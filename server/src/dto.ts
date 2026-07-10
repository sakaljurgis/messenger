import type {
  AttachmentDTO,
  ChatMemberDTO,
  ChatSummaryDTO,
  MessageDTO,
  ReactionGroupDTO,
  ReplyToDTO,
  UserDTO,
} from '@messenger/shared';
import type { AttachmentRow, ChatRow, MessageRow, UserRow } from './db/schema.js';

/** Reply snapshots trim the quoted content to at most this many characters. */
const REPLY_SNIPPET_MAX = 200;

/**
 * Snapshots a reply's target message into the compact {@link ReplyToDTO} carried
 * on the replying message. Reflects the target's CURRENT state: a tombstoned
 * target collapses to empty content + `isDeleted: true` (and drops the attachment
 * flag, matching the tombstone neutering), otherwise the content is trimmed to
 * {@link REPLY_SNIPPET_MAX} chars. `hasAttachments` is supplied by the caller
 * (batch-computed) so this mapper stays pure.
 */
export function toReplyToDTO(target: MessageRow, hasAttachments: boolean): ReplyToDTO {
  const isDeleted = target.deletedAt !== null;
  return {
    id: target.id,
    senderId: target.senderId,
    content: isDeleted ? '' : target.content.slice(0, REPLY_SNIPPET_MAX),
    isDeleted,
    hasAttachments: isDeleted ? false : hasAttachments,
  };
}

/**
 * Maps a DB user row to the public API shape. Deliberately omits
 * passwordHash, apiToken and webhookUrl so they can never leak over the API.
 */
export function toUserDTO(user: UserRow): UserDTO {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isBot: user.isBot,
    color: user.color,
  };
}

/**
 * Maps an attachment row to the public API shape. `hasThumb` collapses the
 * server-side `thumbPath` into a boolean — the URL is derived by the client
 * (GET /api/attachments/:id?thumb=1), never the raw storage path.
 */
export function toAttachmentDTO(attachment: AttachmentRow): AttachmentDTO {
  return {
    id: attachment.id,
    kind: attachment.kind,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    hasThumb: attachment.thumbPath != null,
  };
}

/**
 * Maps a message row (+ its resolved sender, mention user ids and attachments)
 * to the API shape. `createdAt` is a Date from the drizzle timestamp column →
 * ISO string over the wire. `attachments` defaults to empty for plain messages.
 *
 * Deleted messages serialize as a tombstone: the original text, mentions,
 * attachments, reactions and reply reference are dropped (`content: ''`, all
 * lists empty, `replyTo: null`, `editedAt: null`) so a deleted message can never
 * leak its former contents. `replyTo`, when present, is the target's snapshot.
 */
export function toMessageDTO(
  message: MessageRow,
  sender: UserRow,
  mentions: number[],
  attachments: AttachmentDTO[] = [],
  reactions: ReactionGroupDTO[] = [],
  replyTo: ReplyToDTO | null = null,
): MessageDTO {
  const isDeleted = message.deletedAt !== null;
  return {
    id: message.id,
    chatId: message.chatId,
    sender: toUserDTO(sender),
    content: isDeleted ? '' : message.content,
    mentions: isDeleted ? [] : mentions,
    attachments: isDeleted ? [] : attachments,
    reactions: isDeleted ? [] : reactions,
    replyTo: isDeleted ? null : replyTo,
    createdAt: message.createdAt.toISOString(),
    editedAt: isDeleted || message.editedAt === null ? null : message.editedAt.toISOString(),
    isDeleted,
  };
}

/** A chat member row (+ their own read position) as loaded by the chats service. */
export interface ChatMemberRow {
  user: UserRow;
  lastReadMessageId: number;
}

/** Maps a member row to the public API shape: the user fields plus their read position. */
export function toChatMemberDTO(member: ChatMemberRow): ChatMemberDTO {
  return { ...toUserDTO(member.user), lastReadMessageId: member.lastReadMessageId };
}

/**
 * Assembles a chat summary personalized for the requesting user. `members` are all
 * members (incl. the requester), each carrying their own `lastReadMessageId` (this
 * is what powers read-receipt rendering — everyone's read position, not just the
 * requester's); `lastMessage`/`unreadCount` are precomputed by the chats service to
 * keep this mapper pure.
 */
export function toChatSummaryDTO(
  chat: ChatRow,
  members: ChatMemberRow[],
  lastMessage: MessageDTO | null,
  unreadCount: number,
): ChatSummaryDTO {
  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    members: members.map(toChatMemberDTO),
    lastMessage,
    unreadCount,
  };
}
