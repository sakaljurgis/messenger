// Shared types between client and server.
// This file is imported as TypeScript source by both Vite (client) and tsx (server).

// ---------- Entities (as serialized over the API) ----------

export interface UserDTO {
  id: number;
  email: string;
  displayName: string;
  isBot: boolean;
}

export type ChatType = 'dm' | 'group';

export interface MessageDTO {
  id: number;
  chatId: number;
  sender: UserDTO;
  content: string;
  /** User ids @-mentioned in this message. */
  mentions: number[];
  /** ISO 8601 */
  createdAt: string;
}

export interface ChatSummaryDTO {
  id: number;
  type: ChatType;
  /** Group name; null for DMs (render the other member's name instead). */
  name: string | null;
  members: UserDTO[];
  lastMessage: MessageDTO | null;
  unreadCount: number;
}

// ---------- Request bodies ----------

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** POST /api/chats — exactly one of the two shapes. */
export type CreateChatRequest =
  | { userId: number } // DM (idempotent: returns the existing DM if one exists)
  | { name: string; memberIds: number[] }; // group

export interface SendMessageRequest {
  content: string;
  mentions?: number[];
}

export interface AddMembersRequest {
  memberIds: number[];
}

export interface MarkReadRequest {
  /** Mark read up to and including this message id. */
  messageId: number;
}

// ---------- Responses ----------

export interface AuthResponse {
  user: UserDTO;
}

export interface MessagesPage {
  messages: MessageDTO[];
  /** Pass as ?before= to fetch the next (older) page; null when exhausted. */
  nextCursor: number | null;
}

export interface ApiErrorBody {
  error: string;
}

// ---------- Socket.IO events ----------

export interface ServerToClientEvents {
  'message:new': (message: MessageDTO) => void;
  'chat:new': (chat: ChatSummaryDTO) => void;
  'chat:updated': (chat: ChatSummaryDTO) => void;
}

export interface ClientToServerEvents {
  typing: (chatId: number) => void;
}
