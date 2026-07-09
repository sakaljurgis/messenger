import { EventEmitter } from 'node:events';
import type { MessageDTO } from '@messenger/shared';
import type { ChatRow } from './db/schema.js';

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

/** A chat (DM or group) was created. `memberIds` is every member, incl. the creator. */
export interface ChatNewEvent {
  chat: ChatRow;
  memberIds: number[];
}

/** A group's membership changed. `addedMemberIds` ⊆ `memberIds` (the new full list). */
export interface ChatUpdatedEvent {
  chat: ChatRow;
  memberIds: number[];
  addedMemberIds: number[];
}

interface EventMap {
  'message:new': [MessageNewEvent];
  'chat:new': [ChatNewEvent];
  'chat:updated': [ChatUpdatedEvent];
}

/** Typed facade over a plain node EventEmitter — only the three known events exist. */
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
