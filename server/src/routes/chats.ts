import { and, eq, inArray, lt } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  createMessage,
  getChatForMember,
  getChatSummaryForUser,
  getMemberIds,
  listChatSummaries,
  listMessages,
} from '../chats/service.js';
import type { Db } from '../db/index.js';
import { chatMembers, chats, users, type ChatRow } from '../db/schema.js';
import type { ChatEvents } from '../events.js';

const dmSchema = z.object({ userId: z.number().int().positive() });
const groupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  memberIds: z.array(z.number().int().positive()).nonempty(),
});
const sendSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  mentions: z.array(z.number().int().positive()).optional(),
});
const addMembersSchema = z.object({
  memberIds: z.array(z.number().int().positive()),
});
const markReadSchema = z.object({ messageId: z.number().int() });

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

export function chatsRouter(db: Db, events: ChatEvents): Router {
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
      const targetId = parsed.data.userId;
      if (targetId === me.id) {
        res.status(400).json({ error: 'Cannot chat with yourself' });
        return;
      }
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
      db.insert(chatMembers)
        .values([
          { chatId: chat.id, userId: me.id },
          { chatId: chat.id, userId: targetId },
        ])
        .run();

      const memberIds = [me.id, targetId];
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

  // GET /api/chats/:id/messages — cursor-paginated history, oldest-first.
  router.get('/:id/messages', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    if (chatId === null || !getChatForMember(db, chatId, me.id)) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const before = parseCursor(req.query.before);
    const limit = parseLimit(req.query.limit);
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

    const message = createMessage(db, events, {
      chatId,
      senderId: me.id,
      content: parsed.data.content,
      mentions: parsed.data.mentions,
    });
    if (!message) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    res.status(201).json({ message });
  });

  // POST /api/chats/:id/read — advance my read marker (never rewinds).
  router.post('/:id/read', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    if (chatId === null || !getChatForMember(db, chatId, me.id)) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    const parsed = markReadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    // Only advance: the WHERE clause makes this a max(current, messageId).
    db.update(chatMembers)
      .set({ lastReadMessageId: parsed.data.messageId })
      .where(
        and(
          eq(chatMembers.chatId, chatId),
          eq(chatMembers.userId, me.id),
          lt(chatMembers.lastReadMessageId, parsed.data.messageId),
        ),
      )
      .run();
    res.status(204).end();
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

  return router;
}
