// Chat/message data layer for the client.
//
// Real-time (phase 3): live updates arrive over Socket.IO. `useSocketEvent`
// subscribes hooks to server events (message:new / chat:new / chat:updated),
// and `useLiveRefresh` re-fetches on window focus and on socket (re)connect to
// close any gap while the socket was down. There is no polling — the server
// pushes. Everything still merges through the same pure helpers (mergeMessages,
// upsertChat) so state stays de-duplicated and ordered.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMemberDTO,
  ChatSummaryDTO,
  EditMessageRequest,
  MessageDTO,
  MessagesPage,
  SendMessageRequest,
  ServerToClientEvents,
  UserDTO,
} from '@messenger/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from './api';
import { getSocket } from './socket';

const PAGE_LIMIT = 30;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no React, no I/O)
// ---------------------------------------------------------------------------

/** Group → its name; DM → the *other* member's display name. */
export function chatTitle(chat: ChatSummaryDTO, meId: number): string {
  if (chat.type === 'group') {
    return chat.name ?? 'Group';
  }
  const other = chat.members.find((m) => m.id !== meId);
  return other?.displayName ?? chat.name ?? 'Conversation';
}

/** The other participant of a DM (undefined for groups / degenerate chats). */
export function otherMember(chat: ChatSummaryDTO, meId: number): UserDTO | undefined {
  return chat.members.find((m) => m.id !== meId);
}

/** Up to two uppercase initials from the first two words of a name. */
export function chatInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return '?';
  return words.map((w) => w.charAt(0).toUpperCase()).join('');
}

/** Stable hash of a user (or chat) id → hue in [0, 360). */
export function avatarHue(id: number): number {
  let hash = 0;
  const str = String(id);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Merge two lists of messages, de-duplicating by id and keeping ascending
 * (oldest → newest) order. Later occurrences win, so a re-fetched message
 * replaces the stale copy. Used for polled updates, sends, and older pages.
 */
export function mergeMessages(existing: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<number, MessageDTO>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Replace a message in place by id (for live `message:updated` edits/deletes).
 * Unlike {@link mergeMessages} this never *adds* the message: an update for one
 * we haven't loaded (e.g. far up the history) is ignored rather than injected
 * out of context. Returns the same array reference when nothing matched.
 */
export function replaceMessage(existing: MessageDTO[], updated: MessageDTO): MessageDTO[] {
  let found = false;
  const next = existing.map((m) => {
    if (m.id !== updated.id) return m;
    found = true;
    return updated;
  });
  return found ? next : existing;
}

/** Neuter a message into its tombstone form (optimistic local delete). */
export function tombstone(message: MessageDTO): MessageDTO {
  return { ...message, content: '', mentions: [], attachments: [], editedAt: null, isDeleted: true };
}

/** Recent-activity key for sort: last message time, or "now" for an empty (just-created) chat. */
function chatActivity(chat: ChatSummaryDTO): number {
  return chat.lastMessage ? Date.parse(chat.lastMessage.createdAt) : Number.MAX_SAFE_INTEGER;
}

/**
 * Insert or replace a chat summary (matched by id), keeping the list ordered by
 * most-recent activity. Used to apply live `chat:new` / `chat:updated` events —
 * the incoming summary is already personalized/server-truth, so it wins. Ties
 * keep the incoming chat first (a brand-new chat lands at the top).
 */
export function upsertChat(chats: ChatSummaryDTO[], incoming: ChatSummaryDTO): ChatSummaryDTO[] {
  const others = chats.filter((c) => c.id !== incoming.id);
  return [incoming, ...others].sort((a, b) => chatActivity(b) - chatActivity(a));
}

/**
 * The newest message in the (ascending, by id) `messages` array with
 * `id <= targetId`, or null if none qualifies. `messages` is assumed sorted
 * ascending, so the search can stop at the first id that overshoots.
 */
function newestAtOrBelow(messages: MessageDTO[], targetId: number): number | null {
  let result: number | null = null;
  for (const m of messages) {
    if (m.id <= targetId) result = m.id;
    else break;
  }
  return result;
}

/**
 * Groups every other member's read-receipt avatar onto the message it belongs
 * under: the newest currently-loaded message they've read. Read receipts are
 * "seen up to" markers (Messenger-style), so multiple members who've read the
 * same amount cluster on the same anchor message.
 *
 * Rules, per member (excluding `meId`):
 *  - `lastReadMessageId === 0` (never marked anything read — this is also how
 *    bots, which never call the read endpoint, are naturally excluded) → hidden.
 *  - Behind the loaded window (`lastReadMessageId` < the oldest loaded message
 *    id) → hidden; we have no message to anchor the avatar to.
 *  - Read past the newest loaded message → clamped to the newest loaded message
 *    (they're caught up with everything we can currently show).
 *  - Otherwise → the newest loaded message with `id <= lastReadMessageId`.
 *
 * Returns a Map from anchor message id to the members whose read position
 * lands there. Chats with no loaded messages yield an empty map.
 */
export function readPositions(
  messages: MessageDTO[],
  members: ChatMemberDTO[],
  meId: number,
): Map<number, ChatMemberDTO[]> {
  const result = new Map<number, ChatMemberDTO[]>();
  if (messages.length === 0) return result;
  const oldestId = messages[0]!.id;
  const newestId = messages[messages.length - 1]!.id;

  for (const member of members) {
    if (member.id === meId) continue;
    const read = member.lastReadMessageId;
    if (read <= 0) continue;
    if (read < oldestId) continue;
    const anchorId = read >= newestId ? newestId : newestAtOrBelow(messages, read);
    if (anchorId === null) continue;
    const list = result.get(anchorId) ?? [];
    list.push(member);
    result.set(anchorId, list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Date/time formatting helpers (presentational, pure, testable)
// ---------------------------------------------------------------------------

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Same calendar day, comparing two ISO timestamps. */
export function sameCalendarDay(aIso: string, bIso: string): boolean {
  return startOfDay(new Date(aIso)) === startOfDay(new Date(bIso));
}

function timeHM(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Chat-list timestamp: `14:32` today, `Mon` within a week, else `12 Jun`. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (startOfDay(date) === startOfDay(now)) return timeHM(date);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days >= 1 && days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Bubble timestamp, e.g. `14:32`. */
export function formatMessageTime(iso: string): string {
  return timeHM(new Date(iso));
}

/** Day-separator chip: `Today`, `Yesterday`, or `12 Jun 2026`. */
export function formatDaySeparator(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (startOfDay(date) === startOfDay(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (startOfDay(date) === startOfDay(yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// Live-update primitives — Socket.IO subscriptions + gap recovery.
// ---------------------------------------------------------------------------

/**
 * Subscribe to a typed server->client socket event for the lifetime of the
 * component. The latest `handler` closure is always invoked (kept in a ref), so
 * callers can close over fresh props/state without re-subscribing.
 */
function useSocketEvent<E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
): void {
  const saved = useRef(handler);
  saved.current = handler;

  useEffect(() => {
    const socket = getSocket();
    const listener = ((...args: Parameters<ServerToClientEvents[E]>): void => {
      (saved.current as (...a: Parameters<ServerToClientEvents[E]>) => void)(...args);
    }) as ServerToClientEvents[E];
    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }, [event]);
}

/**
 * Re-run `refresh` whenever the window regains focus or the socket (re)connects.
 * Reconnecting fires a catch-up fetch so any events missed while the socket was
 * down are reconciled against server truth. Latest closure via ref, as above.
 */
function useLiveRefresh(refresh: () => void): void {
  const saved = useRef(refresh);
  saved.current = refresh;

  useEffect(() => {
    const run = () => saved.current();
    const socket = getSocket();
    window.addEventListener('focus', run);
    socket.on('connect', run);
    return () => {
      window.removeEventListener('focus', run);
      socket.off('connect', run);
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface UseChatsResult {
  chats: ChatSummaryDTO[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * All of my chats, sorted by recent activity. Live via Socket.IO: new/updated
 * chats are upserted from their (personalized) summaries; an incoming message
 * triggers a refresh so ordering and unread counts reflect server truth.
 */
export function useChats(): UseChatsResult {
  const [chats, setChats] = useState<ChatSummaryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ chats: ChatSummaryDTO[] }>('/api/chats');
      setChats(res.chats);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load chats'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh(() => void load());

  // chat:new / chat:updated carry a full server-truth summary — apply directly.
  useSocketEvent('chat:new', (chat) => setChats((prev) => upsertChat(prev, chat)));
  useSocketEvent('chat:updated', (chat) => setChats((prev) => upsertChat(prev, chat)));
  // A new message changes ordering and (someone else's) unread count; refetch so
  // the list matches the server's read-aware counts rather than guessing locally.
  useSocketEvent('message:new', () => void load());
  // An edit/delete can change a chat's last-message preview and unread count.
  useSocketEvent('message:updated', () => void load());
  // read:updated deliberately has no listener here: the chat list doesn't render
  // per-member read receipts (that's ChatPage's job via useChat below), and its
  // own unread count already comes from `unreadCount` on the summary.

  return { chats, loading, error, refresh: () => void load() };
}

export interface UseChatResult {
  chat: ChatSummaryDTO | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * A single chat summary (title, members, unread). Live via Socket.IO: a
 * `chat:updated` for this chat (e.g. members added) is applied directly, a
 * `read:updated` patches just the affected member's `lastReadMessageId` (so
 * read-receipt rendering updates without a refetch), and we re-fetch on
 * focus/reconnect to catch up on anything missed.
 */
export function useChat(chatId: number): UseChatResult {
  const [chat, setChat] = useState<ChatSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ chat: ChatSummaryDTO }>(`/api/chats/${chatId}`);
      setChat(res.chat);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load chat'));
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useLiveRefresh(() => void load());

  useSocketEvent('chat:updated', (updated) => {
    if (updated.id === chatId) setChat(updated);
  });

  // A member's read marker advanced: patch just that member in place rather
  // than refetching the whole summary.
  useSocketEvent('read:updated', ({ chatId: eventChatId, userId, lastReadMessageId }) => {
    if (eventChatId !== chatId) return;
    setChat((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        members: prev.members.map((m) => (m.id === userId ? { ...m, lastReadMessageId } : m)),
      };
    });
  });

  return { chat, loading, error, refresh: () => void load() };
}

export interface UseMessagesResult {
  messages: MessageDTO[];
  loadOlder: () => Promise<void>;
  hasMore: boolean;
  sendMessage: (content: string, mentions?: number[], attachmentIds?: number[]) => Promise<MessageDTO>;
  editMessage: (messageId: number, content: string, mentions?: number[]) => Promise<MessageDTO>;
  deleteMessage: (messageId: number) => Promise<void>;
  loading: boolean;
  error: string | null;
}

/**
 * Messages for a chat, ascending. Loads the newest page on mount, prepends
 * older pages via `loadOlder`, appends sends, and merges live `message:new`
 * events for this chat — all merged by id so nothing duplicates (including the
 * sender's own optimistic copy) and order is preserved.
 */
export function useMessages(chatId: number): UseMessagesResult {
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  // Cursor for the NEXT older page; null once exhausted. Only advanced by the
  // initial load and `loadOlder` — never by the live poll (which fetches the
  // newest page and would otherwise rewind us).
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset + initial newest page whenever the chat changes.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setOlderCursor(null);
    setLoading(true);
    setError(null);

    apiGet<MessagesPage>(`/api/chats/${chatId}/messages?limit=${PAGE_LIMIT}`)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.messages);
        setOlderCursor(page.nextCursor);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Failed to load messages'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Live: merge messages pushed for THIS chat. mergeMessages dedupes by id, so
  // the echo of our own just-sent message collapses onto the optimistic copy.
  useSocketEvent('message:new', (message) => {
    if (message.chatId === chatId) {
      setMessages((prev) => mergeMessages(prev, [message]));
    }
  });

  // Live edit/delete: replace the message in place (a tombstone when deleted).
  useSocketEvent('message:updated', (message) => {
    if (message.chatId === chatId) {
      setMessages((prev) => replaceMessage(prev, message));
    }
  });

  // Catch-up on focus / reconnect: refetch the newest page and merge, closing
  // any gap where a message:new arrived while the socket was disconnected.
  useLiveRefresh(() => {
    apiGet<MessagesPage>(`/api/chats/${chatId}/messages?limit=${PAGE_LIMIT}`)
      .then((page) => setMessages((prev) => mergeMessages(prev, page.messages)))
      .catch(() => {
        /* transient failure — keep showing what we have */
      });
  });

  const loadOlder = useCallback(async () => {
    if (olderCursor == null) return;
    const page = await apiGet<MessagesPage>(
      `/api/chats/${chatId}/messages?before=${olderCursor}&limit=${PAGE_LIMIT}`,
    );
    setMessages((prev) => mergeMessages(prev, page.messages));
    setOlderCursor(page.nextCursor);
  }, [chatId, olderCursor]);

  const sendMessage = useCallback(
    async (content: string, mentions?: number[], attachmentIds?: number[]): Promise<MessageDTO> => {
      const body: SendMessageRequest = { content };
      if (mentions && mentions.length > 0) body.mentions = mentions;
      if (attachmentIds && attachmentIds.length > 0) body.attachmentIds = attachmentIds;
      const res = await apiPost<{ message: MessageDTO }>(`/api/chats/${chatId}/messages`, body);
      setMessages((prev) => mergeMessages(prev, [res.message]));
      return res.message;
    },
    [chatId],
  );

  const editMessage = useCallback(
    async (messageId: number, content: string, mentions?: number[]): Promise<MessageDTO> => {
      const body: EditMessageRequest = { content };
      if (mentions && mentions.length > 0) body.mentions = mentions;
      const res = await apiPatch<{ message: MessageDTO }>(
        `/api/chats/${chatId}/messages/${messageId}`,
        body,
      );
      setMessages((prev) => replaceMessage(prev, res.message));
      return res.message;
    },
    [chatId],
  );

  const deleteMessage = useCallback(
    async (messageId: number): Promise<void> => {
      // Optimistic tombstone; the server's message:updated echo reconciles it.
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? tombstone(m) : m)),
      );
      await apiDelete(`/api/chats/${chatId}/messages/${messageId}`);
    },
    [chatId],
  );

  return {
    messages,
    loadOlder,
    hasMore: olderCursor !== null,
    sendMessage,
    editMessage,
    deleteMessage,
    loading,
    error,
  };
}

/** Mark the chat read up to and including `messageId` (fire-and-forget). */
export function markRead(chatId: number, messageId: number): Promise<void> {
  return apiPost<void>(`/api/chats/${chatId}/read`, { messageId });
}

// ---------------------------------------------------------------------------
// Typing indicators — transient, socket-driven, self-expiring.
// ---------------------------------------------------------------------------

/** A typing signal is considered stale this long after the last 'typing' event. */
export const TYPING_EXPIRY_MS = 4000;

/**
 * Drop entries whose expiry has passed. Returns the same Map reference when
 * nothing expired so callers can bail out of a state update.
 */
function pruneExpired(map: Map<number, number>, now: number): Map<number, number> {
  let changed = false;
  const next = new Map(map);
  for (const [key, expiresAt] of next) {
    if (expiresAt <= now) {
      next.delete(key);
      changed = true;
    }
  }
  return changed ? next : map;
}

/**
 * Core self-pruning typing store, keyed on whatever `onTyping`/`clearKeyOf`
 * return. A 'typing' event (re)arms a key for {@link TYPING_EXPIRY_MS}; a
 * 'message:new' clears its key immediately (the typed message landed); a change
 * to `resetToken` wipes everything. While anything is live a 1s interval sweeps
 * expired entries so the indicator disappears on its own. Returns the live keys.
 */
function useExpiringTyping(
  onTyping: (data: { chatId: number; userId: number }) => number | null,
  clearKeyOf: (message: MessageDTO) => number | null,
  resetToken = 0,
): Set<number> {
  const [entries, setEntries] = useState<Map<number, number>>(new Map());

  // Reset on token change (render-phase, per React's "adjust state on prop
  // change" pattern) so a stale typer never leaks across the change.
  const resetRef = useRef(resetToken);
  if (resetRef.current !== resetToken) {
    resetRef.current = resetToken;
    if (entries.size > 0) setEntries(new Map());
  }

  useSocketEvent('typing', (data) => {
    const key = onTyping(data);
    if (key === null) return;
    setEntries((prev) => new Map(prev).set(key, Date.now() + TYPING_EXPIRY_MS));
  });

  useSocketEvent('message:new', (message) => {
    const key = clearKeyOf(message);
    if (key === null) return;
    setEntries((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  });

  useEffect(() => {
    if (entries.size === 0) return;
    const interval = setInterval(() => {
      setEntries((prev) => pruneExpired(prev, Date.now()));
    }, 1000);
    return () => clearInterval(interval);
  }, [entries.size]);

  const now = Date.now();
  const live = new Set<number>();
  for (const [key, expiresAt] of entries) {
    if (expiresAt > now) live.add(key);
  }
  return live;
}

/**
 * User ids currently typing in `chatId` (excluding me), for the in-chat
 * indicator. Entries expire 4s after the last 'typing' event and clear the
 * instant that user's message arrives; switching chats wipes the set.
 */
export function useChatTyping(chatId: number, meId: number): Set<number> {
  return useExpiringTyping(
    (data) => (data.chatId === chatId && data.userId !== meId ? data.userId : null),
    (message) => (message.chatId === chatId ? message.sender.id : null),
    chatId,
  );
}

/**
 * Chat ids that currently have someone (other than me) typing, for the chat-list
 * 'typing…' preview. Each entry expires 4s after the last 'typing' event and
 * clears the instant a message lands in that chat.
 */
export function useTypingChats(meId: number): Set<number> {
  return useExpiringTyping(
    (data) => (data.userId !== meId ? data.chatId : null),
    (message) => message.chatId,
  );
}
