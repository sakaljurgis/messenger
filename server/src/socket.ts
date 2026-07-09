import type http from 'node:http';
import { Server, type DefaultEventsMap } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@messenger/shared';
import { getSessionUser } from './auth/session.js';
import { getChatSummaryForUser } from './chats/service.js';
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
   * to notify only members who are NOT currently connected.
   */
  isUserConnected(userId: number): boolean;
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
export function initSocket(httpServer: http.Server, db: Db, events: ChatEvents): SocketHandle {
  const io: IoServer = new Server(httpServer);

  // Refcounted so multiple tabs for one user don't clobber each other's presence.
  const connections = new Map<number, number>();
  const isUserConnected = (userId: number): boolean => (connections.get(userId) ?? 0) > 0;

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
    connections.set(userId, (connections.get(userId) ?? 0) + 1);

    // Client -> server typing indicator (phase 7 stretch): accepted but ignored
    // for now so the event exists end-to-end.
    socket.on('typing', () => {
      // TODO(phase 7): relay a transient "typing" signal to the chat's members.
    });

    socket.on('disconnect', () => {
      const remaining = (connections.get(userId) ?? 1) - 1;
      if (remaining <= 0) connections.delete(userId);
      else connections.set(userId, remaining);
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

  events.on('chat:updated', ({ chat, memberIds }) => {
    for (const id of memberIds) {
      const summary = getChatSummaryForUser(db, chat.id, id);
      if (summary) io.to(`user:${id}`).emit('chat:updated', summary);
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

  return { io, isUserConnected };
}
