import type {
  AttachmentDTO,
  ChatMemberDTO,
  ChatSummaryDTO,
  LinkPreviewDTO,
  MessageActionDTO,
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
 * Parses the raw `messages.link_preview` JSON column into a
 * {@link LinkPreviewDTO}. Never throws: `null` column, malformed JSON, or a
 * value that doesn't even look like an object all collapse to `null` — a
 * link preview is a nice-to-have, so a parse failure must never break message
 * serialization.
 */
function parseLinkPreview(raw: string | null): LinkPreviewDTO | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as LinkPreviewDTO) : null;
  } catch {
    return null;
  }
}

/**
 * Parses the raw `messages.actions` JSON column into {@link MessageActionDTO}s.
 * Bot action buttons are validated on the way in (routes/bot-api.ts), so this
 * is mostly a re-hydrate; but like {@link parseLinkPreview} it NEVER throws —
 * a null column, malformed JSON, a non-array, or an array with no well-formed
 * entries all collapse to `undefined` (the DTO field is simply absent). Each
 * entry is re-shaped to the exact DTO (id/label/optional style) so no stray
 * persisted keys leak, malformed entries are dropped, and the list is capped at
 * 6 to match the contract regardless of what the column holds.
 */
export function parseActions(raw: string | null): MessageActionDTO[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const actions: MessageActionDTO[] = [];
    for (const entry of parsed) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        typeof (entry as MessageActionDTO).id !== 'string' ||
        typeof (entry as MessageActionDTO).label !== 'string'
      ) {
        continue;
      }
      const { id, label, style } = entry as MessageActionDTO;
      const action: MessageActionDTO = { id, label };
      if (style === 'primary' || style === 'danger') action.style = style;
      actions.push(action);
      if (actions.length === 6) break;
    }
    return actions.length > 0 ? actions : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses the raw `messages.action_taken` JSON column into the compact
 * {@link MessageDTO.actionTaken} shape. Like {@link parseActions} it NEVER
 * throws: a null column, malformed JSON, or a value missing a string `actionId`
 * / numeric `userId` all collapse to `undefined` (the DTO field is absent).
 * Only `actionId` and `userId` are surfaced — the persisted `at` timestamp is
 * an internal detail and is stripped.
 */
export function parseActionTaken(
  raw: string | null,
): { actionId: string; userId: number } | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as { actionId: unknown }).actionId !== 'string' ||
      typeof (parsed as { userId: unknown }).userId !== 'number'
    ) {
      return undefined;
    }
    const { actionId, userId } = parsed as { actionId: string; userId: number };
    return { actionId, userId };
  } catch {
    return undefined;
  }
}

/**
 * Maps a message row (+ its resolved sender, mention user ids and attachments)
 * to the API shape. `createdAt` is a Date from the drizzle timestamp column →
 * ISO string over the wire. `attachments` defaults to empty for plain messages.
 *
 * Deleted messages serialize as a tombstone: the original text, mentions,
 * attachments, reactions, reply reference, link preview and action buttons (plus
 * any one-shot resolution record) are dropped (`content: ''`, all lists empty,
 * `replyTo: null`, `linkPreview: null`, `actions`/`actionTaken` absent,
 * `editedAt: null`) so a deleted message can never leak its former contents —
 * even though the underlying `link_preview` column, like `content`, is left
 * untouched by the soft-delete itself (see chats/service#deleteMessage).
 * `replyTo`, when present, is the target's snapshot.
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
    linkPreview: isDeleted ? null : parseLinkPreview(message.linkPreview),
    // Bot action buttons: absent for humans (null column) and always dropped on
    // a tombstone — matching the rest of the tombstone neutering above.
    actions: isDeleted ? undefined : parseActions(message.actions),
    // The one-shot resolution record ({ actionId, userId }): present once a
    // member tapped, absent while still tappable, and dropped on a tombstone.
    actionTaken: isDeleted ? undefined : parseActionTaken(message.actionTaken),
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
 * requester's); `lastMessage`/`unreadCount`/`muted` are precomputed by the chats
 * service to keep this mapper pure. `muted` is the REQUESTER's own mute flag only
 * (like `unreadCount`) — another member's mute state is never exposed here.
 */
export function toChatSummaryDTO(
  chat: ChatRow,
  members: ChatMemberRow[],
  lastMessage: MessageDTO | null,
  unreadCount: number,
  muted: boolean,
): ChatSummaryDTO {
  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    members: members.map(toChatMemberDTO),
    lastMessage,
    unreadCount,
    muted,
  };
}
