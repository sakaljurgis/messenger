import type { ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import type { ChatRow, MessageRow, UserRow } from './db/schema.js';

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
  };
}

/**
 * Maps a message row (+ its resolved sender and mention user ids) to the API shape.
 * `createdAt` is a Date from the drizzle timestamp column → ISO string over the wire.
 */
export function toMessageDTO(
  message: MessageRow,
  sender: UserRow,
  mentions: number[],
): MessageDTO {
  return {
    id: message.id,
    chatId: message.chatId,
    sender: toUserDTO(sender),
    content: message.content,
    mentions,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Assembles a chat summary personalized for the requesting user. `members` are all
 * members (incl. the requester); `lastMessage`/`unreadCount` are precomputed by the
 * chats service to keep this mapper pure.
 */
export function toChatSummaryDTO(
  chat: ChatRow,
  members: UserRow[],
  lastMessage: MessageDTO | null,
  unreadCount: number,
): ChatSummaryDTO {
  return {
    id: chat.id,
    type: chat.type,
    name: chat.name,
    members: members.map(toUserDTO),
    lastMessage,
    unreadCount,
  };
}
