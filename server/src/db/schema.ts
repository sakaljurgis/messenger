import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
  /** Bots only: URL that receives webhook POSTs for messages in their chats. */
  webhookUrl: text('webhook_url'),
  /** Bots only: bearer token the bot uses to call the inbound bot API. */
  apiToken: text('api_token').unique(),
  /**
   * Soft-delete marker (set when a bot is deleted). The row is kept so the
   * bot's old messages still resolve a sender; deleted users are excluded from
   * the directory and the bots list, and hold no memberships or credentials.
   */
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  /**
   * User-picked accent color as '#rrggbb'; null → the client derives a stable
   * color from the user id (see UserDTO.color in shared). Added in
   * drizzle/0007_user_colors.sql.
   */
  color: text('color'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['dm', 'group'] }).notNull(),
  /** Group name; null for DMs. */
  name: text('name'),
  /** For DMs: "minUserId:maxUserId" — unique, enforces one DM per pair. Null for groups. */
  dmKey: text('dm_key').unique(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const chatMembers = sqliteTable(
  'chat_members',
  {
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: integer('joined_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Unread counts: messages with id > this are unread. */
    lastReadMessageId: integer('last_read_message_id').notNull().default(0),
    /** Per-member mute: suppresses web-push for this chat only (sockets/unread unaffected). */
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index('chat_members_user_idx').on(t.userId),
  ],
);

// NOTE: an external-content FTS5 virtual table `messages_fts` (over
// messages.content, content_rowid=id) plus INSERT/UPDATE/DELETE sync triggers
// live in drizzle/0006_messages_fts.sql. FTS5 virtual tables can't be expressed
// in the Drizzle schema, so they're hand-written there and queried via raw SQL
// in chats/service#searchMessages (which additionally filters tombstones — a
// soft-delete leaves the original text in the index).
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id),
    content: text('content').notNull(),
    /**
     * The message this one replies to; null for a normal message. Self-FK within
     * `messages`. Deletes are soft (tombstones), so the target normally persists;
     * but a chat delete (last member leaves) hard-deletes its messages, so this is
     * SET NULL to avoid a dangling reference during that cascade.
     */
    replyToId: integer('reply_to_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Set on each edit; null when the message was never edited. */
    editedAt: integer('edited_at', { mode: 'timestamp' }),
    /** Set on soft-delete; null while the message is live. Deleted messages serialize as tombstones. */
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    /**
     * JSON-serialized LinkPreviewDTO for the first URL in the content, written
     * by the link-preview subscriber after send; null before resolution, when
     * no URL exists, or when the fetch failed.
     */
    linkPreview: text('link_preview'),
    /**
     * JSON-serialized MessageActionDTO[] — bot-sent action buttons; null for
     * human messages and for bot messages without actions.
     */
    actions: text('actions'),
    /**
     * JSON-serialized { actionId, userId, at } once a member tapped one of
     * the actions (one-shot; set exactly once, first tap wins); null while
     * the buttons are still live.
     */
    actionTaken: text('action_taken'),
  },
  (t) => [index('messages_chat_idx').on(t.chatId, t.id)],
);

/**
 * Send-later queue: a boot+interval dispatcher sends due rows through the
 * normal createMessage flow (so sockets/push/webhooks fan out) and deletes
 * them. Text-only by design — attachments can't be scheduled. `replyToId`
 * has no FK: the target may be hard-deleted (chat teardown) before dispatch;
 * the dispatcher re-validates and drops a stale reference to a plain send.
 */
export const scheduledMessages = sqliteTable(
  'scheduled_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    /** JSON number[] of mentioned user ids. */
    mentions: text('mentions').notNull().default('[]'),
    replyToId: integer('reply_to_id'),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('scheduled_messages_due_idx').on(t.scheduledAt)],
);

export const messageMentions = sqliteTable(
  'message_mentions',
  {
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('message_mentions_user_idx').on(t.userId),
  ],
);

export const messageReactions = sqliteTable(
  'message_reactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // One reaction per (message, user, emoji) — the toggle relies on this.
    uniqueIndex('message_reactions_unique').on(t.messageId, t.userId, t.emoji),
    index('message_reactions_message_idx').on(t.messageId),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    uploaderId: integer('uploader_id')
      .notNull()
      .references(() => users.id),
    /** Null until a message links this attachment on send; then the owning message. */
    messageId: integer('message_id').references(() => messages.id),
    kind: text('kind', { enum: ['image', 'video', 'audio', 'file'] }).notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Pixel dimensions for images (post-metadata); null for non-images. */
    width: integer('width'),
    height: integer('height'),
    /** Stored filename on the volume (not a full path). */
    storagePath: text('storage_path').notNull(),
    /** Stored filename of the ≤512px webp thumbnail; null when none was generated. */
    thumbPath: text('thumb_path'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('attachments_message_idx').on(t.messageId)],
);

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type MessageReactionRow = typeof messageReactions.$inferSelect;
