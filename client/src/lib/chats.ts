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
  ChatSummaryDTO,
  MessageDTO,
  MessagesPage,
  SendMessageRequest,
  ServerToClientEvents,
  UserDTO,
} from '@messenger/shared';
import { apiGet, apiPost } from './api';
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
 * `chat:updated` for this chat (e.g. members added) is applied directly, and we
 * re-fetch on focus/reconnect to catch up on anything missed.
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

  return { chat, loading, error, refresh: () => void load() };
}

export interface UseMessagesResult {
  messages: MessageDTO[];
  loadOlder: () => Promise<void>;
  hasMore: boolean;
  sendMessage: (content: string, mentions?: number[]) => Promise<MessageDTO>;
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
    async (content: string, mentions?: number[]): Promise<MessageDTO> => {
      const body: SendMessageRequest =
        mentions && mentions.length > 0 ? { content, mentions } : { content };
      const res = await apiPost<{ message: MessageDTO }>(`/api/chats/${chatId}/messages`, body);
      setMessages((prev) => mergeMessages(prev, [res.message]));
      return res.message;
    },
    [chatId],
  );

  return {
    messages,
    loadOlder,
    hasMore: olderCursor !== null,
    sendMessage,
    loading,
    error,
  };
}

/** Mark the chat read up to and including `messageId` (fire-and-forget). */
export function markRead(chatId: number, messageId: number): Promise<void> {
  return apiPost<void>(`/api/chats/${chatId}/read`, { messageId });
}
