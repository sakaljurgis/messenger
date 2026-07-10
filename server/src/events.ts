import { EventEmitter } from 'node:events';
import type { MessageDTO, UserDTO } from '@messenger/shared';
import type { ChatRow, UserRow } from './db/schema.js';

/**
 * Fan-out event bus. Phase 2 (this file's REST routes) emits domain events after
 * it commits writes; later phases subscribe without touching the routes:
 *   - phase 3 (Socket.IO) relays to connected members,
 *   - phase 5 (web push) notifies members without a live socket,
 *   - phase 6 (webhooks) POSTs to bot members.
 * The payloads carry the full member id list so subscribers never re-query.
 */

/** A message was persisted. `memberIds` is every member of the chat, incl. the sender. */
export interface MessageNewEvent {
  message: MessageDTO;
  chat: ChatRow;
  memberIds: number[];
}

/**
 * An existing message was edited or soft-deleted. `message` is the current DTO
 * (a tombstone for a deleted message). `memberIds` is every member, incl. the
 * sender. Sockets relay this; push deliberately ignores it (no notification for
 * edits/deletes).
 */
export interface MessageUpdatedEvent {
  message: MessageDTO;
  chat: ChatRow;
  memberIds: number[];
}

/** A chat (DM or group) was created. `memberIds` is every member, incl. the creator. */
export interface ChatNewEvent {
  chat: ChatRow;
  memberIds: number[];
}

/**
 * A group's membership changed. `addedMemberIds` ⊆ `memberIds` (the new full
 * list); `removedMemberIds` are users who are NOT in `memberIds` any more (they
 * left) — the socket relay tells their clients to drop the chat.
 */
export interface ChatUpdatedEvent {
  chat: ChatRow;
  memberIds: number[];
  addedMemberIds: number[];
  removedMemberIds?: number[];
}

/**
 * A member advanced their read marker in a chat. Only emitted when the update
 * actually moved the marker forward — a repeat or backwards read is a silent
 * no-op at the route level and never reaches here, so subscribers (the socket
 * relay) never have to re-derive "did this really change?".
 */
export interface ReadUpdatedEvent {
  chat: ChatRow;
  memberIds: number[];
  userId: number;
  lastReadMessageId: number;
}

/**
 * A member tapped an action button on a BOT message (see routes/chats.ts
 * `POST .../actions`). The webhook subscriber POSTs an action callback to the
 * bot's `webhookUrl`; nothing else listens (it never touches sockets/push).
 * `bot` is the still-alive bot that sent the actions message — guaranteed
 * `isBot`, not soft-deleted, and with a `webhookUrl` (the route rejects
 * otherwise); `message` is that message's current DTO, `user` the tapper.
 */
export interface ActionTriggeredEvent {
  bot: UserRow;
  actionId: string;
  message: MessageDTO;
  user: UserDTO;
  chat: ChatRow;
}

interface EventMap {
  'message:new': [MessageNewEvent];
  'message:updated': [MessageUpdatedEvent];
  'chat:new': [ChatNewEvent];
  'chat:updated': [ChatUpdatedEvent];
  'read:updated': [ReadUpdatedEvent];
  'action:triggered': [ActionTriggeredEvent];
}

/** Typed facade over a plain node EventEmitter — only the known events exist. */
export interface ChatEvents {
  on<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): void;
  off<K extends keyof EventMap>(event: K, listener: (...args: EventMap[K]) => void): void;
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean;
}

export function createChatEvents(): ChatEvents {
  const emitter = new EventEmitter();
  return {
    on(event, listener) {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
    emit(event, ...args) {
      return emitter.emit(event, ...args);
    },
  };
}
