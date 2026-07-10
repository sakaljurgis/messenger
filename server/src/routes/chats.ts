import { REACTION_EMOJIS } from '@messenger/shared';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  createMessage,
  deleteMessage,
  editMessage,
  getChatForMember,
  getChatSummaryForUser,
  getMemberIds,
  listChatSummaries,
  listMessages,
  listMessagesAfter,
  listMessagesAround,
  toggleReaction,
} from '../chats/service.js';
import type { Db } from '../db/index.js';
import { attachments, chatMembers, chats, users, type ChatRow } from '../db/schema.js';
import type { ChatEvents } from '../events.js';
import type { Storage } from '../storage.js';

const dmSchema = z.object({ userId: z.number().int().positive() });
const groupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  memberIds: z.array(z.number().int().positive()).nonempty(),
});
const sendSchema = z
  .object({
    // Empty/whitespace content is allowed only alongside at least one attachment
    // (enforced by the refine below); trimming collapses whitespace-only to ''.
    content: z.string().trim().max(4000).optional().default(''),
    mentions: z.array(z.number().int().positive()).optional(),
    attachmentIds: z.array(z.number().int().positive()).optional(),
    // Reply target; existence/same-chat/live checks happen in createMessage.
    replyToId: z.number().int().positive().optional(),
  })
  .refine((d) => d.content.length > 0 || (d.attachmentIds?.length ?? 0) > 0, {
    message: 'Message content or attachments required',
  });
const addMembersSchema = z.object({
  memberIds: z.array(z.number().int().positive()),
});
// Same rule as a group's name at creation (groupSchema).
const renameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const markReadSchema = z.object({ messageId: z.number().int() });
// Edits can't be attachment-only-empty: content is required, 1–4000 chars trimmed.
const editSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  mentions: z.array(z.number().int().positive()).optional(),
});
// The emoji whitelist is enforced against REACTION_EMOJIS in the handler.
const reactionSchema = z.object({ emoji: z.string() });

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

/** Parse a positive-int path param; NaN/garbage -> null (treated as 404 by callers). */
function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse an optional `before` cursor query param. */
function parseCursor(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Clamp the `limit` query param to [1, MAX], defaulting when absent/invalid. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_MESSAGE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(n, MAX_MESSAGE_LIMIT);
}

const CHAT_NOT_FOUND = { error: 'Chat not found' };
const MESSAGE_NOT_FOUND = { error: 'Message not found' };

export function chatsRouter(db: Db, events: ChatEvents, storage: Storage): Router {
  const router = Router();

  // POST /api/chats — create a DM ({ userId }) or a group ({ name, memberIds }).
  router.post('/', requireAuth, (req, res) => {
    const me = req.user!;
    const body: unknown = req.body;
    const isDm = typeof body === 'object' && body !== null && 'userId' in body;

    if (isDm) {
      const parsed = dmSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({ error: firstIssue(parsed.error) });
        return;
      }
      // targetId === me.id is allowed: a self-DM ("notes to self") with a
      // single member row and dmKey "id:id".
      const targetId = parsed.data.userId;
      const target = db.select().from(users).where(eq(users.id, targetId)).get();
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const dmKey = `${Math.min(me.id, targetId)}:${Math.max(me.id, targetId)}`;
      const existing = db.select().from(chats).where(eq(chats.dmKey, dmKey)).get();
      if (existing) {
        res.status(200).json({ chat: getChatSummaryForUser(db, existing.id, me.id)! });
        return;
      }

      let chat: ChatRow;
      try {
        chat = db
          .insert(chats)
          .values({ type: 'dm', name: null, dmKey, createdBy: me.id })
          .returning()
          .get();
      } catch (err) {
        // Race on the dm_key unique index: another request created it first.
        if (isUniqueViolation(err)) {
          const raced = db.select().from(chats).where(eq(chats.dmKey, dmKey)).get();
          if (raced) {
            res.status(200).json({ chat: getChatSummaryForUser(db, raced.id, me.id)! });
            return;
          }
        }
        throw err;
      }
      const memberIds = targetId === me.id ? [me.id] : [me.id, targetId];
      db.insert(chatMembers)
        .values(memberIds.map((userId) => ({ chatId: chat.id, userId })))
        .run();
      events.emit('chat:new', { chat, memberIds });
      res.status(201).json({ chat: getChatSummaryForUser(db, chat.id, me.id)! });
      return;
    }

    // Group.
    const parsed = groupSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const memberIds = [...new Set([...parsed.data.memberIds, me.id])];
    const found = db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, memberIds))
      .all();
    if (found.length !== memberIds.length) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const chat = db
      .insert(chats)
      .values({ type: 'group', name: parsed.data.name, dmKey: null, createdBy: me.id })
      .returning()
      .get();
    db.insert(chatMembers)
      .values(memberIds.map((userId) => ({ chatId: chat.id, userId })))
      .run();

    events.emit('chat:new', { chat, memberIds });
    res.status(201).json({ chat: getChatSummaryForUser(db, chat.id, me.id)! });
  });

  // GET /api/chats — the requester's chats, most recently active first.
  router.get('/', requireAuth, (req, res) => {
    res.status(200).json({ chats: listChatSummaries(db, req.user!.id) });
  });

  // GET /api/chats/:id — single chat summary (member only).
  router.get('/:id', requireAuth, (req, res) => {
    const chatId = parseId(req.params.id);
    if (chatId === null) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const summary = getChatSummaryForUser(db, chatId, req.user!.id);
    if (!summary) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    res.status(200).json({ chat: summary });
  });

  // GET /api/chats/:id/messages — history, oldest-first. Default (no param) and
  // ?before= walk backwards; ?after= walks forwards; ?around=<id> returns a
  // window centred on a message. The three windowing params are mutually
  // exclusive. Only the windowed forms carry `newerCursor`.
  router.get('/:id/messages', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    if (chatId === null || !getChatForMember(db, chatId, me.id)) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const present = (['before', 'after', 'around'] as const).filter(
      (k) => req.query[k] !== undefined,
    );
    if (present.length > 1) {
      res.status(400).json({ error: 'Use only one of before, after, around' });
      return;
    }
    const limit = parseLimit(req.query.limit);

    if (req.query.around !== undefined) {
      const around = parseId(req.query.around);
      const page = around === null ? null : listMessagesAround(db, chatId, around, limit);
      if (!page) {
        res.status(404).json(MESSAGE_NOT_FOUND);
        return;
      }
      res.status(200).json(page);
      return;
    }
    if (req.query.after !== undefined) {
      // Invalid/garbage cursor falls back to 0 → "walk forward from the oldest".
      const after = parseCursor(req.query.after) ?? 0;
      res.status(200).json(listMessagesAfter(db, chatId, after, limit));
      return;
    }
    const before = parseCursor(req.query.before);
    res.status(200).json(listMessages(db, chatId, before, limit));
  });

  // POST /api/chats/:id/messages — send a message. Same path bots use via
  // /api/bot/messages (see routes/bot-api.ts) — both call chats/service#createMessage.
  router.post('/:id/messages', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    if (chatId === null) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const result = createMessage(db, events, {
      chatId,
      senderId: me.id,
      content: parsed.data.content,
      mentions: parsed.data.mentions,
      attachmentIds: parsed.data.attachmentIds,
      replyToId: parsed.data.replyToId,
    });
    if (!result.ok) {
      if (result.reason === 'invalid-attachments') {
        res.status(400).json({ error: 'Invalid attachments' });
        return;
      }
      if (result.reason === 'invalid-reply') {
        res.status(400).json({ error: 'Invalid reply target' });
        return;
      }
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    res.status(201).json({ message: result.message });
  });

  // PATCH /api/chats/:id/messages/:messageId — edit an own message's text.
  router.patch('/:id/messages/:messageId', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const messageId = parseId(req.params.messageId);
    if (chatId === null) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (messageId === null) {
      res.status(404).json(MESSAGE_NOT_FOUND);
      return;
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const result = editMessage(db, events, {
      chatId,
      messageId,
      userId: me.id,
      content: parsed.data.content,
      mentions: parsed.data.mentions,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-member':
          res.status(404).json(CHAT_NOT_FOUND);
          return;
        case 'not-found':
          res.status(404).json(MESSAGE_NOT_FOUND);
          return;
        case 'forbidden':
          res.status(403).json({ error: 'Not your message' });
          return;
        case 'deleted':
          res.status(400).json({ error: 'Message deleted' });
          return;
      }
    }
    res.status(200).json({ message: result.message });
  });

  // DELETE /api/chats/:id/messages/:messageId — soft-delete an own message
  // (idempotent: a second delete still 204s). Attachment files are removed on delete.
  router.delete('/:id/messages/:messageId', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const messageId = parseId(req.params.messageId);
    if (chatId === null) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (messageId === null) {
      res.status(404).json(MESSAGE_NOT_FOUND);
      return;
    }

    const result = deleteMessage(db, events, storage, { chatId, messageId, userId: me.id });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-member':
          res.status(404).json(CHAT_NOT_FOUND);
          return;
        case 'not-found':
          res.status(404).json(MESSAGE_NOT_FOUND);
          return;
        case 'forbidden':
          res.status(403).json({ error: 'Not your message' });
          return;
      }
    }
    res.status(204).end();
  });

  // POST /api/chats/:id/messages/:messageId/reactions — toggle my emoji reaction
  // on a message (any member may react; the message must be in this chat and live).
  router.post('/:id/messages/:messageId/reactions', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const messageId = parseId(req.params.messageId);
    if (chatId === null) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (messageId === null) {
      res.status(404).json(MESSAGE_NOT_FOUND);
      return;
    }
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    if (!(REACTION_EMOJIS as readonly string[]).includes(parsed.data.emoji)) {
      res.status(400).json({ error: 'Invalid reaction' });
      return;
    }

    const result = toggleReaction(db, events, {
      chatId,
      messageId,
      userId: me.id,
      emoji: parsed.data.emoji,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-member':
          res.status(404).json(CHAT_NOT_FOUND);
          return;
        case 'not-found':
          res.status(404).json(MESSAGE_NOT_FOUND);
          return;
        case 'deleted':
          res.status(400).json({ error: 'Message deleted' });
          return;
      }
    }
    res.status(200).json({ message: result.message });
  });

  // POST /api/chats/:id/read — advance my read marker (never rewinds).
  router.post('/:id/read', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const parsed = markReadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    // Only advance: the WHERE clause makes this a max(current, messageId).
    const result = db
      .update(chatMembers)
      .set({ lastReadMessageId: parsed.data.messageId })
      .where(
        and(
          eq(chatMembers.chatId, chat.id),
          eq(chatMembers.userId, me.id),
          lt(chatMembers.lastReadMessageId, parsed.data.messageId),
        ),
      )
      .run();
    // Emit only on a real advance — a repeat or backwards read is a silent
    // no-op (no event storm, no spurious client-side receipt animation).
    if (result.changes > 0) {
      events.emit('read:updated', {
        chat,
        memberIds: getMemberIds(db, chat.id),
        userId: me.id,
        lastReadMessageId: parsed.data.messageId,
      });
    }
    res.status(204).end();
  });

  // PATCH /api/chats/:id — rename a group (any member may).
  router.patch('/:id', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (chat.type === 'dm') {
      res.status(400).json({ error: 'Cannot rename a DM' });
      return;
    }
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const updated = db
      .update(chats)
      .set({ name: parsed.data.name })
      .where(eq(chats.id, chat.id))
      .returning()
      .get();
    events.emit('chat:updated', {
      chat: updated,
      memberIds: getMemberIds(db, chat.id),
      addedMemberIds: [],
    });
    res.status(200).json({ chat: getChatSummaryForUser(db, chat.id, me.id)! });
  });

  // PATCH /api/chats/:id/members — add members to a group.
  router.patch('/:id/members', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (chat.type === 'dm') {
      res.status(400).json({ error: 'Cannot add members to a DM' });
      return;
    }
    const parsed = addMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const requested = [...new Set(parsed.data.memberIds)];
    if (requested.length > 0) {
      const found = db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, requested))
        .all();
      if (found.length !== requested.length) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    const existingMembers = new Set(getMemberIds(db, chat.id));
    const addedMemberIds = requested.filter((id) => !existingMembers.has(id));
    if (addedMemberIds.length > 0) {
      db.insert(chatMembers)
        .values(addedMemberIds.map((userId) => ({ chatId: chat.id, userId })))
        .run();
      events.emit('chat:updated', {
        chat,
        memberIds: getMemberIds(db, chat.id),
        addedMemberIds,
      });
    }
    res.status(200).json({ chat: getChatSummaryForUser(db, chat.id, me.id)! });
  });

  // POST /api/chats/:id/leave — leave a group (any member may). The last member
  // out deletes the chat: rows cascade, attachment files are unlinked from disk.
  router.post('/:id/leave', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (chat.type === 'dm') {
      res.status(400).json({ error: 'Cannot leave a DM' });
      return;
    }

    db.delete(chatMembers)
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, me.id)))
      .run();

    const remaining = getMemberIds(db, chat.id);
    if (remaining.length === 0) {
      // Capture file names before the chat delete cascades the attachment rows.
      const files = db
        .select({ storagePath: attachments.storagePath, thumbPath: attachments.thumbPath })
        .from(attachments)
        .where(eq(attachments.chatId, chat.id))
        .all();
      db.delete(chats).where(eq(chats.id, chat.id)).run();
      for (const f of files) {
        storage.remove(f.storagePath);
        if (f.thumbPath) storage.remove(f.thumbPath);
      }
    }
    // Emitted even for the last member: memberIds=[] relays nothing, while
    // removedMemberIds tells the leaver's other tabs/devices to drop the chat.
    events.emit('chat:updated', {
      chat,
      memberIds: remaining,
      addedMemberIds: [],
      removedMemberIds: [me.id],
    });
    res.status(204).end();
  });

  return router;
}
