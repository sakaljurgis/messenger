import type http from 'node:http';
import { Server, type DefaultEventsMap } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@messenger/shared';
import { getSessionUser } from './auth/session.js';
import { getChatForMember, getChatSummaryForUser, getMemberIds } from './chats/service.js';
import type { Db } from './db/index.js';
import type { ChatEvents } from './events.js';

/** Per-connection state carried from the handshake into the connection handler. */
interface SocketData {
  userId: number;
}

type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>;

export interface SocketHandle {
  io: IoServer;
  /**
   * True while a user has at least one live socket. Phase 5 (web push) uses this
   * to notify only members who are NOT currently connected. Stays strictly
   * refcount-based (real-time) — the presence-broadcast grace window below does
   * NOT apply here, so push targeting never waits on the debounce.
   */
  isUserConnected(userId: number): boolean;
  /**
   * Cancel any pending offline-presence timers (graceful shutdown / test
   * teardown). Idempotent; leaves no dangling timers.
   */
  clearPresenceTimers(): void;
}

/**
 * Extract one cookie's value from a raw `Cookie` header without pulling in a
 * cookie-parsing dependency (the handshake gives us the header, not req.cookies).
 */
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return undefined;
}

/**
 * Attaches Socket.IO to the HTTP server and wires the fan-out bus to connected
 * clients. Sockets are receive-only: every send still goes through REST, which
 * emits on `events`; we relay those domain events to the right user rooms here.
 *
 * Emits target `user:{id}` rooms (one per member), never chat rooms — a user
 * room transparently covers every chat the user belongs to, including chats
 * created after they connected and multiple tabs/devices.
 */
export function initSocket(
  httpServer: http.Server,
  db: Db,
  events: ChatEvents,
  presenceGraceMs = 5000,
): SocketHandle {
  const io: IoServer = new Server(httpServer);

  // Refcounted so multiple tabs for one user don't clobber each other's presence.
  const connections = new Map<number, number>();
  const isUserConnected = (userId: number): boolean => (connections.get(userId) ?? 0) > 0;

  // A user's LAST disconnect doesn't broadcast "offline" immediately: a timer is
  // parked here and only fires the broadcast after the grace window, so a page
  // reload (disconnect→reconnect within the window) never flickers offline.
  // Keyed by user id; cleared on reconnect.
  const pendingOffline = new Map<number, ReturnType<typeof setTimeout>>();

  // "Presence-online" = has a live socket OR is still inside the offline grace
  // window. This is the set advertised via presence broadcasts + snapshots; it
  // is deliberately looser than isUserConnected (which push targeting needs
  // real-time). connections only holds users with refcount ≥ 1 (we delete on 0).
  const onlineUserIds = (): number[] => {
    const ids = new Set<number>(connections.keys());
    for (const id of pendingOffline.keys()) ids.add(id);
    return [...ids];
  };

  const clearPresenceTimers = (): void => {
    for (const timer of pendingOffline.values()) clearTimeout(timer);
    pendingOffline.clear();
  };

  // Handshake auth: the browser sends the httpOnly `sid` cookie automatically
  // (same-origin), and we resolve it to a user with the exact same logic the
  // REST session middleware uses.
  io.use((socket, next) => {
    const token = parseCookie(socket.request.headers.cookie, 'sid');
    if (!token) {
      next(new Error('Unauthorized'));
      return;
    }
    const user = getSessionUser(db, token);
    if (!user) {
      next(new Error('Unauthorized'));
      return;
    }
    socket.data.userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);

    // Presence, first connect (0→1): broadcast "online". A reconnect within the
    // offline grace window must produce NO events — so cancel any pending offline
    // timer BEFORE deciding whether this is a real transition. The user counts as
    // already-online if they have a live socket OR a parked offline timer.
    const parked = pendingOffline.get(userId);
    const wasOnline = (connections.get(userId) ?? 0) > 0 || parked !== undefined;
    if (parked) {
      clearTimeout(parked);
      pendingOffline.delete(userId);
    }
    connections.set(userId, (connections.get(userId) ?? 0) + 1);

    // One-shot snapshot of who is online right now (this user included).
    socket.emit('presence:state', onlineUserIds());

    if (!wasOnline) {
      io.emit('presence', { userId, online: true });
    }

    // Client -> server typing indicator: relay a transient "typing" signal to
    // every OTHER member of the chat. Verify membership (cheap lookup) so a
    // non-member can't spam a chat; invalid/non-member input is ignored silently.
    socket.on('typing', (chatId) => {
      if (typeof chatId !== 'number') return;
      const chat = getChatForMember(db, chatId, userId);
      if (!chat) return;
      for (const id of getMemberIds(db, chat.id)) {
        if (id === userId) continue;
        io.to(`user:${id}`).emit('typing', { chatId: chat.id, userId });
      }
    });

    socket.on('disconnect', () => {
      const remaining = (connections.get(userId) ?? 1) - 1;
      if (remaining > 0) {
        connections.set(userId, remaining);
        return;
      }
      // Last socket gone: drop the real-time refcount now (isUserConnected must
      // read false immediately for push targeting), but debounce the "offline"
      // broadcast so a quick reconnect cancels it. Replace any stale timer.
      connections.delete(userId);
      const existing = pendingOffline.get(userId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pendingOffline.delete(userId);
        io.emit('presence', { userId, online: false });
      }, presenceGraceMs);
      // Don't let a parked presence timer keep the process alive.
      timer.unref?.();
      pendingOffline.set(userId, timer);
    });
  });

  // ---- Fan-out: domain events (from REST writes) -> connected members --------

  // Same message DTO for every member.
  events.on('message:new', ({ message, memberIds }) => {
    for (const id of memberIds) {
      io.to(`user:${id}`).emit('message:new', message);
    }
  });

  // An edit/delete: relay the current DTO (a tombstone when deleted) to every
  // member so open threads replace the message in place. No push (see push.ts).
  events.on('message:updated', ({ message, memberIds }) => {
    for (const id of memberIds) {
      io.to(`user:${id}`).emit('message:updated', message);
    }
  });

  // Each member gets a summary personalized to them (their own unread count, the
  // DM's "other member", etc.).
  events.on('chat:new', ({ chat, memberIds }) => {
    for (const id of memberIds) {
      const summary = getChatSummaryForUser(db, chat.id, id);
      if (summary) io.to(`user:${id}`).emit('chat:new', summary);
    }
  });

  events.on('chat:updated', ({ chat, memberIds, removedMemberIds }) => {
    for (const id of memberIds) {
      const summary = getChatSummaryForUser(db, chat.id, id);
      if (summary) io.to(`user:${id}`).emit('chat:updated', summary);
    }
    // A removed member can't receive a summary (no membership to personalize
    // against) — their clients get an explicit signal to drop the chat instead.
    for (const id of removedMemberIds ?? []) {
      io.to(`user:${id}`).emit('chat:removed', { chatId: chat.id });
    }
  });

  // A member's read marker advanced: relay the small (chatId, userId,
  // lastReadMessageId) delta to every member so open threads can move that
  // member's read-receipt avatar without a full chat refetch.
  events.on('read:updated', ({ chat, memberIds, userId, lastReadMessageId }) => {
    for (const id of memberIds) {
      io.to(`user:${id}`).emit('read:updated', { chatId: chat.id, userId, lastReadMessageId });
    }
  });

  // A BOT is "typing" (POST /api/bot/typing → bus). Relayed to every OTHER
  // member exactly like the human socket `typing` handler above — same event
  // name and payload, so clients can't tell bots and humans apart here.
  events.on('typing', ({ chat, memberIds, userId }) => {
    for (const id of memberIds) {
      if (id === userId) continue;
      io.to(`user:${id}`).emit('typing', { chatId: chat.id, userId });
    }
  });

  return { io, isUserConnected, clearPresenceTimers };
}
