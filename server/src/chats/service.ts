import type {
  AttachmentDTO,
  ChatSummaryDTO,
  MessageDTO,
  MessagesPage,
  ReactionGroupDTO,
  ReplyToDTO,
} from '@messenger/shared';
import { and, count, desc, eq, gt, inArray, isNull, lt, max, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  attachments,
  chatMembers,
  chats,
  messageMentions,
  messageReactions,
  messages,
  users,
  type ChatRow,
  type MessageRow,
} from '../db/schema.js';
import {
  toAttachmentDTO,
  toChatSummaryDTO,
  toMessageDTO,
  toReplyToDTO,
  type ChatMemberRow,
} from '../dto.js';
import type { ChatEvents } from '../events.js';
import type { Storage } from '../storage.js';

/** Default and hard-cap page sizes for message history. */
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 100;

/**
 * Returns the chat row only if `userId` is a member of it. Undefined for both
 * "chat doesn't exist" and "not a member" — routes turn either into a 404 so
 * non-members can't probe which chat ids exist.
 */
export function getChatForMember(
  db: Db,
  chatId: number,
  userId: number,
): ChatRow | undefined {
  const row = db
    .select({ chat: chats })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
    .get();
  return row?.chat;
}

/** All member user ids of a chat (order unspecified). */
export function getMemberIds(db: Db, chatId: number): number[] {
  return db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
    .all()
    .map((r) => r.userId);
}

/** Params for {@link createMessage}. `content` is expected pre-validated (trimmed, ≤4000 chars). */
export interface CreateMessageParams {
  chatId: number;
  senderId: number;
  content: string;
  mentions?: number[];
  /** Ids of attachments already uploaded to this chat, to link onto the new message. */
  attachmentIds?: number[];
  /**
   * Id of the message this one replies to. Must be a live (non-deleted) message
   * in the same chat, else the whole send fails with `invalid-reply`.
   */
  replyToId?: number;
}

/**
 * Outcome of {@link createMessage}: a discriminated union so routes can map each
 * failure to the right status without a second query. `not-member` → 404 (covers
 * "chat doesn't exist" and "not a member" alike); `invalid-attachments` and
 * `invalid-reply` → 400.
 */
export type CreateMessageResult =
  | { ok: true; message: MessageDTO }
  | { ok: false; reason: 'not-member' | 'invalid-attachments' | 'invalid-reply' };

/**
 * The single message-creation path, shared by the human REST endpoint
 * (routes/chats.ts) and the bot API (routes/bot-api.ts): persists the message,
 * filters mentions down to actual chat members, links any uploaded attachments,
 * bumps the sender's own `lastReadMessageId` (they've obviously read their own
 * message), and emits `message:new` on the shared bus for sockets/push/webhooks.
 *
 * The persist + attachment-link happen inside a single (synchronous, better-
 * sqlite3) transaction so a message never lands half-linked.
 */
export function createMessage(
  db: Db,
  events: ChatEvents,
  { chatId, senderId, content, mentions, attachmentIds, replyToId }: CreateMessageParams,
): CreateMessageResult {
  const chat = getChatForMember(db, chatId, senderId);
  if (!chat) return { ok: false, reason: 'not-member' };
  const sender = db.select().from(users).where(eq(users.id, senderId)).get();
  if (!sender) return { ok: false, reason: 'not-member' };

  // Reply target (if any): must exist, live in THIS chat, and not be a tombstone.
  let replyTarget: MessageRow | undefined;
  if (replyToId !== undefined) {
    replyTarget = db.select().from(messages).where(eq(messages.id, replyToId)).get();
    if (!replyTarget || replyTarget.chatId !== chat.id || replyTarget.deletedAt !== null) {
      return { ok: false, reason: 'invalid-reply' };
    }
  }

  const memberIds = getMemberIds(db, chat.id);
  const memberSet = new Set(memberIds);
  // Silently drop mentions of non-members and duplicates.
  const dedupedMentions = [...new Set(mentions ?? [])].filter((id) => memberSet.has(id));

  // Validate every attachment: it must exist, belong to this chat, have been
  // uploaded by the sender, and still be unlinked. Any violation fails the whole
  // send (a distinguishable result the routes turn into a 400).
  const attachmentIdList = [...new Set(attachmentIds ?? [])];
  let attachmentRows: (typeof attachments.$inferSelect)[] = [];
  if (attachmentIdList.length > 0) {
    attachmentRows = db
      .select()
      .from(attachments)
      .where(inArray(attachments.id, attachmentIdList))
      .all();
    if (attachmentRows.length !== attachmentIdList.length) {
      return { ok: false, reason: 'invalid-attachments' };
    }
    for (const a of attachmentRows) {
      if (a.chatId !== chat.id || a.uploaderId !== sender.id || a.messageId !== null) {
        return { ok: false, reason: 'invalid-attachments' };
      }
    }
  }

  const message = db.transaction((tx) => {
    const msg = tx
      .insert(messages)
      .values({ chatId: chat.id, senderId: sender.id, content, replyToId: replyToId ?? null })
      .returning()
      .get();
    if (dedupedMentions.length > 0) {
      tx.insert(messageMentions)
        .values(dedupedMentions.map((userId) => ({ messageId: msg.id, userId })))
        .run();
    }
    if (attachmentIdList.length > 0) {
      tx.update(attachments)
        .set({ messageId: msg.id })
        .where(inArray(attachments.id, attachmentIdList))
        .run();
    }
    // The sender has obviously read their own message.
    tx.update(chatMembers)
      .set({ lastReadMessageId: msg.id })
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, sender.id)))
      .run();
    return msg;
  });

  // Preserve the caller's attachment order in the DTO.
  const rowById = new Map(attachmentRows.map((r) => [r.id, r]));
  const attachmentDTOs = attachmentIdList.map((id) => toAttachmentDTO(rowById.get(id)!));

  // Snapshot the reply target's current state (batch loader handles the one row).
  const replyTo = loadReplyTargets(db, [message]).get(message.id) ?? null;

  const dto = toMessageDTO(message, sender, dedupedMentions, attachmentDTOs, [], replyTo);
  events.emit('message:new', { message: dto, chat, memberIds });
  return { ok: true, message: dto };
}

/**
 * Shared access check for the own-message edit/delete endpoints. Ordered so a
 * non-member can never learn whether a message exists: membership first (→
 * `not-member`, a 404 'Chat not found'), then existence-in-this-chat (→
 * `not-found`, a 404 'Message not found'), then ownership (→ `forbidden`, 403).
 */
type MessageAccess =
  | { ok: true; message: MessageRow; chat: ChatRow; memberIds: number[] }
  | { ok: false; reason: 'not-member' | 'not-found' | 'forbidden' };

function accessOwnMessage(
  db: Db,
  chatId: number,
  messageId: number,
  userId: number,
): MessageAccess {
  const chat = getChatForMember(db, chatId, userId);
  if (!chat) return { ok: false, reason: 'not-member' };
  const message = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message || message.chatId !== chat.id) return { ok: false, reason: 'not-found' };
  if (message.senderId !== userId) return { ok: false, reason: 'forbidden' };
  return { ok: true, message, chat, memberIds: getMemberIds(db, chat.id) };
}

/** Params for {@link editMessage}. `content` is expected pre-validated (trimmed, 1–4000 chars). */
export interface EditMessageParams {
  chatId: number;
  messageId: number;
  userId: number;
  content: string;
  mentions?: number[];
}

/**
 * Outcome of {@link editMessage}. `deleted` (400) is distinct from the shared
 * access reasons so a tombstone can't be edited back to life.
 */
export type EditMessageResult =
  | { ok: true; message: MessageDTO }
  | { ok: false; reason: 'not-member' | 'not-found' | 'forbidden' | 'deleted' };

/**
 * Edits an own, non-deleted message: rewrites the text, stamps `editedAt`, and
 * REPLACES the mention rows (re-filtered to current chat members). Attachments
 * are untouched (not editable) and preserved in the returned DTO. Emits
 * `message:updated` on the shared bus for the socket relay.
 */
export function editMessage(
  db: Db,
  events: ChatEvents,
  { chatId, messageId, userId, content, mentions }: EditMessageParams,
): EditMessageResult {
  const access = accessOwnMessage(db, chatId, messageId, userId);
  if (!access.ok) return access;
  const { message, chat, memberIds } = access;
  if (message.deletedAt !== null) return { ok: false, reason: 'deleted' };

  const memberSet = new Set(memberIds);
  const dedupedMentions = [...new Set(mentions ?? [])].filter((id) => memberSet.has(id));

  const updated = db.transaction((tx) => {
    const row = tx
      .update(messages)
      .set({ content, editedAt: new Date() })
      .where(eq(messages.id, message.id))
      .returning()
      .get();
    // Mention rows are replaced wholesale so removed @names don't linger.
    tx.delete(messageMentions).where(eq(messageMentions.messageId, message.id)).run();
    if (dedupedMentions.length > 0) {
      tx.insert(messageMentions)
        .values(dedupedMentions.map((mentionUserId) => ({ messageId: message.id, userId: mentionUserId })))
        .run();
    }
    return row;
  });

  const sender = db.select().from(users).where(eq(users.id, updated.senderId)).get()!;
  const attachmentRows = db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, message.id))
    .orderBy(attachments.id)
    .all();
  const attachmentDTOs = attachmentRows.map((r) => toAttachmentDTO(r));
  // An edit leaves existing reactions and the reply reference untouched — carry
  // them into the new DTO so the live `message:updated` replace doesn't wipe the
  // chips or the quoted-reply block.
  const reactions = loadReactions(db, [message.id]).get(message.id) ?? [];
  const replyTo = loadReplyTargets(db, [updated]).get(updated.id) ?? null;

  const dto = toMessageDTO(updated, sender, dedupedMentions, attachmentDTOs, reactions, replyTo);
  events.emit('message:updated', { message: dto, chat, memberIds });
  return { ok: true, message: dto };
}

/** Params for {@link deleteMessage}. */
export interface DeleteMessageParams {
  chatId: number;
  messageId: number;
  userId: number;
}

/** Outcome of {@link deleteMessage}. Deleting an already-deleted message is a success (idempotent). */
export type DeleteMessageResult =
  | { ok: true }
  | { ok: false; reason: 'not-member' | 'not-found' | 'forbidden' };

/**
 * Soft-deletes an own message: stamps `deletedAt`, drops the message's mention
 * and attachment rows, and removes each attachment's file + thumb from disk.
 * Idempotent — deleting an already-deleted message succeeds without re-emitting.
 * Emits `message:updated` (a tombstone DTO) on a real transition.
 */
export function deleteMessage(
  db: Db,
  events: ChatEvents,
  storage: Storage,
  { chatId, messageId, userId }: DeleteMessageParams,
): DeleteMessageResult {
  const access = accessOwnMessage(db, chatId, messageId, userId);
  if (!access.ok) return access;
  const { message, chat, memberIds } = access;

  // Already a tombstone: nothing to change, no event.
  if (message.deletedAt !== null) return { ok: true };

  // Capture the files to unlink before the rows are gone.
  const attachmentRows = db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, message.id))
    .all();

  const updated = db.transaction((tx) => {
    const row = tx
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(eq(messages.id, message.id))
      .returning()
      .get();
    tx.delete(attachments).where(eq(attachments.messageId, message.id)).run();
    tx.delete(messageMentions).where(eq(messageMentions.messageId, message.id)).run();
    // Drop any reactions too — a tombstone carries none (the DTO neuters them).
    tx.delete(messageReactions).where(eq(messageReactions.messageId, message.id)).run();
    return row;
  });

  // Best-effort file removal, outside the txn (storage.remove tolerates misses).
  for (const a of attachmentRows) {
    storage.remove(a.storagePath);
    if (a.thumbPath) storage.remove(a.thumbPath);
  }

  const sender = db.select().from(users).where(eq(users.id, updated.senderId)).get()!;
  const dto = toMessageDTO(updated, sender, [], []);
  events.emit('message:updated', { message: dto, chat, memberIds });
  return { ok: true };
}

/**
 * Access check for the reaction endpoint — like {@link accessOwnMessage} but
 * WITHOUT the ownership gate, since any member may react to any message. Ordered
 * so a non-member can't probe message existence: membership first (→
 * `not-member`, 404 'Chat not found'), then existence-in-this-chat (→
 * `not-found`, 404 'Message not found').
 */
function accessChatMessage(
  db: Db,
  chatId: number,
  messageId: number,
  userId: number,
):
  | { ok: true; message: MessageRow; chat: ChatRow; memberIds: number[] }
  | { ok: false; reason: 'not-member' | 'not-found' } {
  const chat = getChatForMember(db, chatId, userId);
  if (!chat) return { ok: false, reason: 'not-member' };
  const message = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message || message.chatId !== chat.id) return { ok: false, reason: 'not-found' };
  return { ok: true, message, chat, memberIds: getMemberIds(db, chat.id) };
}

/** Params for {@link toggleReaction}. `emoji` is expected pre-validated (in REACTION_EMOJIS). */
export interface ToggleReactionParams {
  chatId: number;
  messageId: number;
  userId: number;
  emoji: string;
}

/**
 * Outcome of {@link toggleReaction}. `deleted` (400) mirrors the edit path — a
 * tombstone can't be reacted to.
 */
export type ToggleReactionResult =
  | { ok: true; message: MessageDTO }
  | { ok: false; reason: 'not-member' | 'not-found' | 'deleted' };

/**
 * Toggles the caller's `emoji` reaction on a message: adds it, or removes it if
 * the caller already reacted with that exact emoji. Emits `message:updated` with
 * the freshly-assembled DTO (reactions included) on the shared bus, so the
 * socket relay replaces the message in place for every member — the same event
 * edits/deletes use.
 */
export function toggleReaction(
  db: Db,
  events: ChatEvents,
  { chatId, messageId, userId, emoji }: ToggleReactionParams,
): ToggleReactionResult {
  const access = accessChatMessage(db, chatId, messageId, userId);
  if (!access.ok) return access;
  const { message, chat, memberIds } = access;
  if (message.deletedAt !== null) return { ok: false, reason: 'deleted' };

  const existing = db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, message.id),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji),
      ),
    )
    .get();
  if (existing) {
    db.delete(messageReactions).where(eq(messageReactions.id, existing.id)).run();
  } else {
    db.insert(messageReactions).values({ messageId: message.id, userId, emoji }).run();
  }

  const dto = messageDTOFromRow(db, message);
  events.emit('message:updated', { message: dto, chat, memberIds });
  return { ok: true, message: dto };
}

/** messageId -> mentioned user ids, for a batch of messages. */
function loadMentions(db: Db, messageIds: number[]): Map<number, number[]> {
  const byMessage = new Map<number, number[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = db
    .select()
    .from(messageMentions)
    .where(inArray(messageMentions.messageId, messageIds))
    .all();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row.userId);
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/** messageId -> attachment DTOs, for a batch of messages (bulk-fetched to avoid N+1). */
function loadAttachments(db: Db, messageIds: number[]): Map<number, AttachmentDTO[]> {
  const byMessage = new Map<number, AttachmentDTO[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = db
    .select()
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))
    .orderBy(attachments.id)
    .all();
  for (const row of rows) {
    if (row.messageId === null) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push(toAttachmentDTO(row));
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/**
 * messageId -> grouped reaction DTOs, for a batch of messages (bulk-fetched to
 * avoid N+1). Rows are read in ascending id order (the autoincrement PK is
 * monotonic with insertion time), so groups end up ordered by first-reaction
 * time and each group's `userIds` in reaction order — the insertion order of a
 * JS Map's keys preserves both.
 */
function loadReactions(db: Db, messageIds: number[]): Map<number, ReactionGroupDTO[]> {
  const byMessage = new Map<number, ReactionGroupDTO[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .orderBy(messageReactions.id)
    .all();
  // Per message, a Map from emoji -> userIds preserves first-seen emoji order.
  const groupsByMessage = new Map<number, Map<string, number[]>>();
  for (const row of rows) {
    let groups = groupsByMessage.get(row.messageId);
    if (!groups) {
      groups = new Map();
      groupsByMessage.set(row.messageId, groups);
    }
    const userIds = groups.get(row.emoji) ?? [];
    userIds.push(row.userId);
    groups.set(row.emoji, userIds);
  }
  for (const [messageId, groups] of groupsByMessage) {
    byMessage.set(
      messageId,
      [...groups.entries()].map(([emoji, userIds]) => ({ emoji, userIds })),
    );
  }
  return byMessage;
}

/**
 * messageId -> reply-target snapshot ({@link ReplyToDTO}), for a batch of message
 * ROWS (bulk-fetched to avoid N+1). Reads the `replyToId` off each row, batch-
 * loads the distinct target rows plus a single query for which targets carry
 * attachments, and snapshots each target's CURRENT state. Messages that aren't
 * replies (or whose target has somehow vanished) are simply absent from the map.
 */
function loadReplyTargets(db: Db, rows: MessageRow[]): Map<number, ReplyToDTO> {
  const byMessage = new Map<number, ReplyToDTO>();
  const targetIds = [
    ...new Set(rows.map((r) => r.replyToId).filter((id): id is number => id !== null)),
  ];
  if (targetIds.length === 0) return byMessage;

  const targets = db.select().from(messages).where(inArray(messages.id, targetIds)).all();
  const targetById = new Map(targets.map((t) => [t.id, t]));

  // One query for which targets have any linked attachment (drives hasAttachments).
  const withAttachments = new Set(
    db
      .select({ messageId: attachments.messageId })
      .from(attachments)
      .where(inArray(attachments.messageId, targetIds))
      .all()
      .map((r) => r.messageId)
      .filter((id): id is number => id !== null),
  );

  for (const row of rows) {
    if (row.replyToId === null) continue;
    const target = targetById.get(row.replyToId);
    if (!target) continue;
    byMessage.set(row.id, toReplyToDTO(target, withAttachments.has(target.id)));
  }
  return byMessage;
}

/**
 * Assembles the full DTO (sender + mentions + attachments + reactions + reply)
 * for a single message row, reusing the batch loaders. Used where one message's
 * live DTO is needed after a mutation (e.g. a reaction toggle).
 */
function messageDTOFromRow(db: Db, message: MessageRow): MessageDTO {
  const sender = db.select().from(users).where(eq(users.id, message.senderId)).get()!;
  const mentions = loadMentions(db, [message.id]).get(message.id) ?? [];
  const attachmentDTOs = loadAttachments(db, [message.id]).get(message.id) ?? [];
  const reactions = loadReactions(db, [message.id]).get(message.id) ?? [];
  const replyTo = loadReplyTargets(db, [message]).get(message.id) ?? null;
  return toMessageDTO(message, sender, mentions, attachmentDTOs, reactions, replyTo);
}

/**
 * Builds chat summaries for a set of chat ids, personalized for `userId`. Uses a
 * handful of bulk (IN-list / join) queries instead of per-chat lookups to avoid N+1.
 * Caller is responsible for only passing chat ids the user is a member of.
 */
function buildSummaries(
  db: Db,
  chatIds: number[],
  userId: number,
): Map<number, ChatSummaryDTO> {
  const summaries = new Map<number, ChatSummaryDTO>();
  if (chatIds.length === 0) return summaries;

  const chatRows = db.select().from(chats).where(inArray(chats.id, chatIds)).all();

  // All members (as user rows + their own read position) grouped by chat.
  const membersByChat = new Map<number, ChatMemberRow[]>();
  const memberRows = db
    .select({
      chatId: chatMembers.chatId,
      user: users,
      lastReadMessageId: chatMembers.lastReadMessageId,
    })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(inArray(chatMembers.chatId, chatIds))
    .all();
  for (const row of memberRows) {
    const list = membersByChat.get(row.chatId) ?? [];
    list.push({ user: row.user, lastReadMessageId: row.lastReadMessageId });
    membersByChat.set(row.chatId, list);
  }

  // Newest message per chat (max id), then resolve their sender + mentions.
  const lastIdRows = db
    .select({ chatId: messages.chatId, lastId: max(messages.id) })
    .from(messages)
    .where(inArray(messages.chatId, chatIds))
    .groupBy(messages.chatId)
    .all();
  const lastMessageIds = lastIdRows
    .map((r) => r.lastId)
    .filter((id): id is number => id !== null);

  const lastMessageByChat = new Map<number, MessageDTO>();
  if (lastMessageIds.length > 0) {
    const mentionsByMessage = loadMentions(db, lastMessageIds);
    const attachmentsByMessage = loadAttachments(db, lastMessageIds);
    const reactionsByMessage = loadReactions(db, lastMessageIds);
    const msgRows = db
      .select({ message: messages, sender: users })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(inArray(messages.id, lastMessageIds))
      .all();
    const replyByMessage = loadReplyTargets(db, msgRows.map((r) => r.message));
    for (const row of msgRows) {
      lastMessageByChat.set(
        row.message.chatId,
        toMessageDTO(
          row.message,
          row.sender,
          mentionsByMessage.get(row.message.id) ?? [],
          attachmentsByMessage.get(row.message.id) ?? [],
          reactionsByMessage.get(row.message.id) ?? [],
          replyByMessage.get(row.message.id) ?? null,
        ),
      );
    }
  }

  // Unread = messages newer than my lastReadMessageId that I didn't send. The
  // join to my chat_members row supplies the per-chat lastReadMessageId.
  const unreadByChat = new Map<number, number>();
  const unreadRows = db
    .select({ chatId: messages.chatId, unread: count() })
    .from(messages)
    .innerJoin(
      chatMembers,
      and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, userId)),
    )
    .where(
      and(
        inArray(messages.chatId, chatIds),
        ne(messages.senderId, userId),
        gt(messages.id, chatMembers.lastReadMessageId),
        // Deleted messages are tombstones — they never count toward unread.
        isNull(messages.deletedAt),
      ),
    )
    .groupBy(messages.chatId)
    .all();
  for (const row of unreadRows) {
    unreadByChat.set(row.chatId, row.unread);
  }

  for (const chat of chatRows) {
    summaries.set(
      chat.id,
      toChatSummaryDTO(
        chat,
        membersByChat.get(chat.id) ?? [],
        lastMessageByChat.get(chat.id) ?? null,
        unreadByChat.get(chat.id) ?? 0,
      ),
    );
  }
  return summaries;
}

/** Summary for a single chat, or undefined if the user isn't a member. */
export function getChatSummaryForUser(
  db: Db,
  chatId: number,
  userId: number,
): ChatSummaryDTO | undefined {
  const membership = db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
    .get();
  if (!membership) return undefined;
  return buildSummaries(db, [chatId], userId).get(chatId);
}

/**
 * The requester's chats, most recently active first. Activity = last message time,
 * falling back to chat creation time for empty chats. Ties break on last-message id
 * (globally increasing) then chat id, so the order is deterministic.
 */
export function listChatSummaries(db: Db, userId: number): ChatSummaryDTO[] {
  const myChats = db
    .select({ chatId: chatMembers.chatId, chatCreatedAt: chats.createdAt })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(eq(chatMembers.userId, userId))
    .all();

  const chatIds = myChats.map((c) => c.chatId);
  const summaries = buildSummaries(db, chatIds, userId);
  const createdAtByChat = new Map(myChats.map((c) => [c.chatId, c.chatCreatedAt.getTime()]));

  return [...summaries.values()].sort((a, b) => {
    const aTime = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : createdAtByChat.get(a.id) ?? 0;
    const bTime = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : createdAtByChat.get(b.id) ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    const aMsgId = a.lastMessage?.id ?? 0;
    const bMsgId = b.lastMessage?.id ?? 0;
    if (aMsgId !== bMsgId) return bMsgId - aMsgId;
    return b.id - a.id;
  });
}

/**
 * Cursor-paginated history: the newest `limit` messages with id < `before`
 * (or the newest overall when `before` is null), returned ascending (oldest
 * first) for direct rendering. `nextCursor` is the oldest returned id when
 * older messages remain, else null.
 */
export function listMessages(
  db: Db,
  chatId: number,
  before: number | null,
  limit: number,
): MessagesPage {
  const conditions = [eq(messages.chatId, chatId)];
  if (before !== null) conditions.push(lt(messages.id, before));

  // Fetch one extra (desc) to detect whether an older page exists.
  const rows = db
    .select({ message: messages, sender: users })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const ascending = [...pageRows].reverse();

  const messageIds = ascending.map((r) => r.message.id);
  const mentionsByMessage = loadMentions(db, messageIds);
  const attachmentsByMessage = loadAttachments(db, messageIds);
  const reactionsByMessage = loadReactions(db, messageIds);
  const replyByMessage = loadReplyTargets(db, ascending.map((r) => r.message));
  const dtos = ascending.map((r) =>
    toMessageDTO(
      r.message,
      r.sender,
      mentionsByMessage.get(r.message.id) ?? [],
      attachmentsByMessage.get(r.message.id) ?? [],
      reactionsByMessage.get(r.message.id) ?? [],
      replyByMessage.get(r.message.id) ?? null,
    ),
  );

  const oldest = ascending[0]?.message.id ?? null;
  return { messages: dtos, nextCursor: hasMore ? oldest : null };
}
