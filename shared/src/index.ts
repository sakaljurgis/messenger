// Shared types between client and server.
// This file is imported as TypeScript source by both Vite (client) and tsx (server).

// ---------- Entities (as serialized over the API) ----------

export interface UserDTO {
  id: number;
  email: string;
  displayName: string;
  isBot: boolean;
}

/** A chat member, personalized with their own read position in that chat. */
export interface ChatMemberDTO extends UserDTO {
  /** This member's last-read message id in the chat (0 if they've read nothing). */
  lastReadMessageId: number;
}

export type ChatType = 'dm' | 'group';

export type AttachmentKind = 'image' | 'file';

export interface AttachmentDTO {
  id: number;
  kind: AttachmentKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  /** Pixel dimensions of the stored image (post-compression); null for non-images. */
  width: number | null;
  height: number | null;
  /** True when a server-generated thumbnail exists (GET /api/attachments/:id?thumb=1). */
  hasThumb: boolean;
}

export interface MessageDTO {
  id: number;
  chatId: number;
  sender: UserDTO;
  content: string;
  /** User ids @-mentioned in this message. */
  mentions: number[];
  attachments: AttachmentDTO[];
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 of the last edit, or null when never edited. Always null for tombstones. */
  editedAt: string | null;
  /**
   * True when the message has been deleted. Tombstones are neutered server-side:
   * `content` is `''`, `mentions` and `attachments` are empty, `editedAt` is null.
   */
  isDeleted: boolean;
}

export interface ChatSummaryDTO {
  id: number;
  type: ChatType;
  /** Group name; null for DMs (render the other member's name instead). */
  name: string | null;
  members: ChatMemberDTO[];
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
  /** May be empty when attachmentIds is non-empty. */
  content: string;
  mentions?: number[];
  /** Attachments previously uploaded to this chat, linked to this message on send. */
  attachmentIds?: number[];
}

/** PATCH /api/chats/:chatId/messages/:messageId — edit own message text (attachments are not editable). */
export interface EditMessageRequest {
  /** Trimmed 1–4000 chars; edits can't be empty. */
  content: string;
  mentions?: number[];
}

export interface AddMembersRequest {
  memberIds: number[];
}

/** PATCH /api/chats/:id — rename a group. */
export interface RenameChatRequest {
  /** Trimmed 1–100 chars (same rule as at creation). */
  name: string;
}

export interface MarkReadRequest {
  /** Mark read up to and including this message id. */
  messageId: number;
}

/** PATCH /api/users/me — update own profile. */
export interface UpdateProfileRequest {
  /** Trimmed, 1–100 chars (same rule as registration). */
  displayName: string;
}

/** PUT /api/users/me/password — change own password (204 on success). */
export interface ChangePasswordRequest {
  currentPassword: string;
  /** 8–200 chars (same rule as registration). */
  newPassword: string;
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

// ---------- Bot management ----------

/**
 * A bot as returned to the humans who manage it (GET /api/bots, PATCH
 * /api/bots/:id). Extends UserDTO with the editable outbound webhookUrl.
 * NEVER carries apiToken or passwordHash — those are omitted server-side.
 */
export interface BotDTO extends UserDTO {
  /** Outbound webhook URL the server POSTs new messages to, or null when unset. */
  webhookUrl: string | null;
}

/** PATCH /api/bots/:id — set or clear a bot's outbound webhook URL. */
export interface UpdateBotRequest {
  /** An http(s) URL, or null/empty string to clear the webhook. */
  webhookUrl: string | null;
}

// ---------- Socket.IO events ----------

export interface ServerToClientEvents {
  'message:new': (message: MessageDTO) => void;
  /** An existing message was edited or deleted; replace it in place (deleted → tombstone). */
  'message:updated': (message: MessageDTO) => void;
  'chat:new': (chat: ChatSummaryDTO) => void;
  'chat:updated': (chat: ChatSummaryDTO) => void;
  /** The recipient is no longer a member of this chat (they left) — drop it from the UI. */
  'chat:removed': (data: { chatId: number }) => void;
  /** A member's read marker advanced in a chat (never fires on a no-op/backwards read). */
  'read:updated': (data: { chatId: number; userId: number; lastReadMessageId: number }) => void;
  /** A member is typing in a chat — a transient signal relayed to the chat's other members. */
  'typing': (data: { chatId: number; userId: number }) => void;
  /** A user's presence flipped online/offline (offline is debounced past a short grace window). */
  'presence': (data: { userId: number; online: boolean }) => void;
  /** One-shot snapshot of who is currently online, pushed to each socket on connect. */
  'presence:state': (onlineUserIds: number[]) => void;
}

export interface ClientToServerEvents {
  typing: (chatId: number) => void;
}
