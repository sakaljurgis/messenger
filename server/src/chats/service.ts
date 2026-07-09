import type { ChatSummaryDTO, MessageDTO, MessagesPage } from '@messenger/shared';
import { and, count, desc, eq, gt, inArray, lt, max, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  chatMembers,
  chats,
  messageMentions,
  messages,
  users,
  type ChatRow,
  type UserRow,
} from '../db/schema.js';
import { toChatSummaryDTO, toMessageDTO } from '../dto.js';
import type { ChatEvents } from '../events.js';

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

/** Params for {@link createMessage}. `content` is expected pre-validated (trimmed, 1-4000 chars). */
export interface CreateMessageParams {
  chatId: number;
  senderId: number;
  content: string;
  mentions?: number[];
}

/**
 * The single message-creation path, shared by the human REST endpoint
 * (routes/chats.ts) and the bot API (routes/bot-api.ts): persists the message,
 * filters mentions down to actual chat members, bumps the sender's own
 * `lastReadMessageId` (they've obviously read their own message), and emits
 * `message:new` on the shared bus for sockets/push/webhooks to relay.
 *
 * Returns `null` when `senderId` isn't a member of `chatId` (covers both "chat
 * doesn't exist" and "not a member") — callers turn that into a 404, keeping
 * bots and humans behind the same "member-only" rule.
 */
export function createMessage(
  db: Db,
  events: ChatEvents,
  { chatId, senderId, content, mentions }: CreateMessageParams,
): MessageDTO | null {
  const chat = getChatForMember(db, chatId, senderId);
  if (!chat) return null;
  const sender = db.select().from(users).where(eq(users.id, senderId)).get();
  if (!sender) return null;

  const memberIds = getMemberIds(db, chat.id);
  const memberSet = new Set(memberIds);
  // Silently drop mentions of non-members and duplicates.
  const dedupedMentions = [...new Set(mentions ?? [])].filter((id) => memberSet.has(id));

  const message = db
    .insert(messages)
    .values({ chatId: chat.id, senderId: sender.id, content })
    .returning()
    .get();
  if (dedupedMentions.length > 0) {
    db.insert(messageMentions)
      .values(dedupedMentions.map((userId) => ({ messageId: message.id, userId })))
      .run();
  }
  // The sender has obviously read their own message.
  db.update(chatMembers)
    .set({ lastReadMessageId: message.id })
    .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, sender.id)))
    .run();

  const dto = toMessageDTO(message, sender, dedupedMentions);
  events.emit('message:new', { message: dto, chat, memberIds });
  return dto;
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

  // All members (as user rows) grouped by chat.
  const membersByChat = new Map<number, UserRow[]>();
  const memberRows = db
    .select({ chatId: chatMembers.chatId, user: users })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(inArray(chatMembers.chatId, chatIds))
    .all();
  for (const row of memberRows) {
    const list = membersByChat.get(row.chatId) ?? [];
    list.push(row.user);
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
    const msgRows = db
      .select({ message: messages, sender: users })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(inArray(messages.id, lastMessageIds))
      .all();
    for (const row of msgRows) {
      lastMessageByChat.set(
        row.message.chatId,
        toMessageDTO(row.message, row.sender, mentionsByMessage.get(row.message.id) ?? []),
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

  const mentionsByMessage = loadMentions(db, ascending.map((r) => r.message.id));
  const dtos = ascending.map((r) =>
    toMessageDTO(r.message, r.sender, mentionsByMessage.get(r.message.id) ?? []),
  );

  const oldest = ascending[0]?.message.id ?? null;
  return { messages: dtos, nextCursor: hasMore ? oldest : null };
}
