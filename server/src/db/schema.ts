import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
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
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index('chat_members_user_idx').on(t.userId),
  ],
);

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
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Set on each edit; null when the message was never edited. */
    editedAt: integer('edited_at', { mode: 'timestamp' }),
    /** Set on soft-delete; null while the message is live. Deleted messages serialize as tombstones. */
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (t) => [index('messages_chat_idx').on(t.chatId, t.id)],
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
    kind: text('kind', { enum: ['image', 'file'] }).notNull(),
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
