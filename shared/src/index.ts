// Shared types between client and server.
// This file is imported as TypeScript source by both Vite (client) and tsx (server).

// ---------- Entities (as serialized over the API) ----------

export interface UserDTO {
  id: number;
  email: string;
  displayName: string;
  isBot: boolean;
  /**
   * User-picked accent color as '#rrggbb' for their avatar/name badge, or
   * null/absent → the client derives a stable color from the user id.
   */
  color?: string | null;
}

/** A chat member, personalized with their own read position in that chat. */
export interface ChatMemberDTO extends UserDTO {
  /** This member's last-read message id in the chat (0 if they've read nothing). */
  lastReadMessageId: number;
}

export type ChatType = 'dm' | 'group';

/**
 * 'video' is assigned only to browser-safe types (video/mp4, video/webm,
 * video/quicktime), which the client renders inline via <video> (served with
 * Range support); 'audio' likewise for browser-safe audio (audio/webm,
 * audio/mp4, audio/mpeg, audio/ogg — voice messages record as webm/opus or
 * mp4/AAC on iOS) rendered as an inline <audio> player; any other video/* or
 * audio/* mime stays 'file' (a download card).
 */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

/** The fixed palette of emoji a message may be reacted with. */
export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/**
 * One emoji's reactions on a message: the emoji plus the ids of every user who
 * reacted with it. Groups are ordered by first-reaction time; `userIds` are in
 * reaction order.
 */
export interface ReactionGroupDTO {
  emoji: string;
  userIds: number[];
}

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

/**
 * A compact snapshot of the message a reply quotes. Computed at DTO-assembly time
 * from the CURRENT state of the original: `content` is trimmed to at most 200
 * chars, and a tombstoned original collapses to `content: ''` + `isDeleted: true`
 * (with no attachment flag). The snapshot does NOT live-update — a later edit or
 * delete of the original is only reflected on the next refetch of the reply.
 */
export interface ReplyToDTO {
  id: number;
  senderId: number;
  content: string;
  isDeleted: boolean;
  hasAttachments: boolean;
}

/**
 * Open Graph summary of the first http(s) URL in a message, fetched
 * server-side after send (SSRF-guarded) and delivered via `message:updated`
 * once resolved. `imageUrl` is the remote og:image URL — the client hotlinks
 * it (same IP exposure as tapping the link itself); the server never proxies
 * or stores preview images.
 */
export interface LinkPreviewDTO {
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

/**
 * One tappable action button on a BOT message (humans can't send actions).
 * Rendered as a button row under the bubble; tapping POSTs
 * /api/chats/:chatId/messages/:messageId/actions { actionId } (204), which
 * dispatches an action event to the bot's webhook.
 */
export interface MessageActionDTO {
  /** Bot-chosen identifier echoed back on tap. ≤64 chars. */
  id: string;
  /** Button label. ≤40 chars. */
  label: string;
  /** Visual emphasis; default is a neutral button. */
  style?: 'primary' | 'danger';
}

export interface MessageDTO {
  id: number;
  chatId: number;
  sender: UserDTO;
  content: string;
  /** User ids @-mentioned in this message. */
  mentions: number[];
  attachments: AttachmentDTO[];
  /**
   * Emoji reactions grouped by emoji (empty when none). Groups are ordered by
   * first-reaction time; `userIds` within a group are in reaction order.
   * Always empty for tombstones.
   */
  reactions: ReactionGroupDTO[];
  /**
   * The message this one replies to (a snapshot of that message's current state),
   * or null when it isn't a reply. Always null for tombstones.
   */
  replyTo: ReplyToDTO | null;
  /**
   * IANA timezone of the sender's device at send time (browser-reported via
   * SendMessageRequest.timezone), e.g. "Europe/Vilnius". Null when the client
   * didn't provide one (older clients, bots, scheduled dispatches) or the
   * provided name wasn't a real zone (sanitized server-side, never trusted).
   * Bots use it to interpret times like "at 9" in the sender's local zone.
   * Always null for tombstones. Optional like the other later-added fields
   * (linkPreview, actions) so pre-existing fixtures/clients stay valid; the
   * server always includes it.
   */
  senderTimezone?: string | null;
  /** ISO 8601 */
  createdAt: string;
  /**
   * Link preview for the first URL in the content, when one has resolved
   * (null/absent before resolution, after a failed fetch, and for tombstones).
   */
  linkPreview?: LinkPreviewDTO | null;
  /**
   * Action buttons (bot messages only, ≤6). Empty/absent for human messages
   * and always absent for tombstones.
   */
  actions?: MessageActionDTO[];
  /**
   * Set once a member taps one of the message's actions. Actions are
   * one-shot: clients replace the buttons with a record line ("<label> —
   * <member>"), and further taps are rejected with 409 'Action already
   * taken' (simultaneous taps: first write wins). Delivered live via
   * message:updated. Absent while the actions are still tappable.
   */
  actionTaken?: { actionId: string; userId: number } | null;
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
  /**
   * Whether I muted this chat (personalized, like unreadCount). Muted chats
   * receive no web-push notifications; sockets/unread counts are unaffected.
   * Toggled via PUT /api/chats/:id/mute { muted: boolean } → 204.
   */
  muted?: boolean;
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
  /**
   * The message being replied to. Must be a live (non-deleted) message in the
   * same chat, else the send is rejected with 400 'Invalid reply target'.
   */
  replyToId?: number;
  /**
   * IANA timezone of the sending device (`Intl.DateTimeFormat().resolvedOptions()
   * .timeZone`). Optional; stored on the message and echoed as
   * MessageDTO.senderTimezone. An invalid name is silently stored as null
   * (mirrors mention filtering — a bad hint never fails the send).
   */
  timezone?: string;
}

/** POST /api/chats/:chatId/messages/:messageId/actions — tap a bot action button (204). */
export interface TriggerActionRequest {
  actionId: string;
}

/**
 * A queued send-later message (text only — attachments can't be scheduled).
 * POST /api/chats/:id/scheduled creates one; GET lists MINE for that chat;
 * DELETE /api/chats/:id/scheduled/:scheduledId cancels (204). At the
 * scheduled time the server sends it through the normal message flow
 * (sockets/push/webhooks all fire as if sent live).
 */
export interface ScheduledMessageDTO {
  id: number;
  chatId: number;
  content: string;
  mentions: number[];
  replyToId: number | null;
  /** ISO 8601 — when it will be sent. */
  scheduledAt: string;
  /** ISO 8601 — when it was queued. */
  createdAt: string;
}

/**
 * Bot variant of scheduling (Bearer-token auth): POST /api/bot/scheduled
 * creates (chatId in the body since bot routes aren't chat-scoped), GET
 * /api/bot/scheduled?chatId= lists the BOT's own pending rows, DELETE
 * /api/bot/scheduled/:id cancels its own row. Same validation/cap as the
 * human endpoints; "adjusting" a schedule = delete + re-create.
 */
export interface BotScheduleMessageRequest extends ScheduleMessageRequest {
  chatId: number;
}

/**
 * POST /api/bot/typing — a bot signals it is "typing" in a chat (e.g. while an
 * LLM parse runs). Transient: relayed once to the other members' sockets
 * exactly like a human's socket `typing` signal (same client expiry); nothing
 * is persisted. Re-send every few seconds to keep the indicator alive.
 */
export interface BotTypingRequest {
  chatId: number;
}

/** POST /api/chats/:id/scheduled — queue a send-later message. */
export interface ScheduleMessageRequest {
  /** Trimmed 1–4000 chars (same rule as a live send; can't be empty). */
  content: string;
  mentions?: number[];
  replyToId?: number;
  /** ISO 8601; must be in the future (≥1 min, ≤1 year). */
  scheduledAt: string;
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
  /**
   * Accent color as '#rrggbb' (validated server-side), or null to revert to
   * the id-derived default. Omit to leave unchanged.
   */
  color?: string | null;
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
  /**
   * Pass as ?after= to fetch the next (newer) page; null when already at the
   * newest message. Only present on windowed fetches (?around= / ?after=) —
   * the default newest-page fetch omits it (there is nothing newer).
   */
  newerCursor?: number | null;
}

/**
 * GET /api/search?q=<terms>&before=<cursor> — full-text search (FTS5) over
 * messages in MY chats only, newest first, tombstones excluded. Same cursor
 * convention as MessagesPage.
 */
export interface SearchResponse {
  messages: MessageDTO[];
  nextCursor: number | null;
}

/**
 * GET /api/chats/:id/messages/:messageId/thread — every message connected to
 * the given one via reply links: the chain is walked up to its root, then all
 * transitive replies to that root are collected, oldest-first (the root is
 * always `messages[0]`). Tombstones stay in the thread like in normal history.
 * Not paginated — threads are conversations, not archives.
 *
 * Also served to bots (Bearer auth) at
 * GET /api/bot/messages/:messageId/thread?chatId=<id> — same shape, same
 * 404 rules; the chat id moves to the query because bot routes aren't
 * chat-scoped.
 */
export interface ThreadResponse {
  /** Id of the thread's first message (the one everything else replies into). */
  rootId: number;
  messages: MessageDTO[];
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
