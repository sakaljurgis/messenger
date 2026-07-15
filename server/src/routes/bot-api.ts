import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { createMessage, getChatForMember, getMemberIds } from '../chats/service.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { ChatEvents } from '../events.js';
import {
  createScheduledMessage,
  deleteScheduledForSender,
  listScheduledForSender,
  parseId,
} from '../scheduled-service.js';

/**
 * The inbound bot API (mounted at /api/bot in app.ts). Authenticated by
 * `Authorization: Bearer <apiToken>` instead of the session cookie — bots have
 * no browser session. Deliberately thin: it re-uses chats/service#createMessage,
 * the exact path routes/chats.ts uses for humans, so bots and humans send
 * messages through one code path with one set of rules (member-only, mention
 * filtering, unread bookkeeping, `message:new` fan-out).
 */

// One action button. Hard limits mirror MessageActionDTO in the shared
// contract: id non-empty ≤64, label non-empty ≤40, style absent or one of the
// two accents. Anything else (extra keys are stripped; wrong types, over-length,
// a bad style value) fails the parse → 400.
const actionSchema = z.object({
  id: z.string().min(1, 'Action id required').max(64, 'Action id too long'),
  label: z.string().min(1, 'Action label required').max(40, 'Action label too long'),
  style: z.enum(['primary', 'danger']).optional(),
});

const sendSchema = z
  .object({
    chatId: z.number().int().positive(),
    // Empty content is allowed only with at least one attachment (see refine).
    content: z.string().trim().max(4000).optional().default(''),
    mentions: z.array(z.number().int().positive()).optional(),
    attachmentIds: z.array(z.number().int().positive()).optional(),
    // Reply target: must be a live message in the same chat (createMessage
    // enforces it → 'invalid-reply' → 400). Optional, same as the human path.
    replyToId: z.number().int().positive().optional(),
    // Action buttons (bots only): at most 6, with unique ids.
    actions: z
      .array(actionSchema)
      .max(6, 'At most 6 actions allowed')
      .refine((arr) => new Set(arr.map((a) => a.id)).size === arr.length, {
        message: 'Duplicate action id',
      })
      .optional(),
  })
  .refine((d) => d.content.length > 0 || (d.attachmentIds?.length ?? 0) > 0, {
    message: 'Message content or attachments required',
  });

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/** Parses the `Authorization: Bearer <token>` header; undefined when absent/malformed. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Resolves the calling bot from its apiToken, rejecting with 401 when the
 * token is missing, garbage, or doesn't belong to a bot user. On success sets
 * `req.bot` for the route handler.
 */
function requireBotAuth(db: Db): RequestHandler {
  return (req, res, next) => {
    const token = bearerToken(req.header('authorization'));
    const bot = token
      ? db
          .select()
          .from(users)
          .where(and(eq(users.apiToken, token), eq(users.isBot, true)))
          .get()
      : undefined;
    if (!bot) {
      res.status(401).json({ error: 'Invalid bot token' });
      return;
    }
    req.bot = bot;
    next();
  };
}

export function botApiRouter(db: Db, events: ChatEvents): Router {
  const router = Router();
  router.use(requireBotAuth(db));

  // POST /api/bot/messages — a bot sends a message. Same rules as the human
  // endpoint: the bot must already be a member of the chat (404 otherwise).
  router.post('/messages', (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const result = createMessage(db, events, {
      chatId: parsed.data.chatId,
      senderId: req.bot!.id,
      content: parsed.data.content,
      mentions: parsed.data.mentions,
      attachmentIds: parsed.data.attachmentIds,
      replyToId: parsed.data.replyToId,
      actions: parsed.data.actions,
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
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.status(201).json({ message: result.message });
  });

  // POST /api/bot/typing — a transient "the bot is typing" signal
  // (BotTypingRequest). Membership-checked like every bot route (404, no
  // existence leak), then relayed to the chat's other members over sockets via
  // the bus — the exact fan-out a human's socket `typing` gets. Nothing is
  // persisted; clients expire the indicator on their own, so a bot doing slow
  // work (LLM parse) re-sends every few seconds.
  router.post('/typing', (req, res) => {
    const chatId = parseId((req.body as { chatId?: unknown })?.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }
    const chat = getChatForMember(db, chatId, req.bot!.id);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    events.emit('typing', { chat, memberIds: getMemberIds(db, chat.id), userId: req.bot!.id });
    res.status(204).end();
  });

  // ── Scheduled ("send later") messages ──────────────────────────────────────
  // The Bearer-auth mirror of /api/chats/:id/scheduled. Chat id travels in the
  // body (POST) or query (GET) since bot routes aren't chat-scoped; the shared
  // scheduled-service enforces the same validation/bounds/cap as the human path.
  // "Adjusting" a schedule is DELETE + POST — there is no PATCH.

  // POST /api/bot/scheduled — queue a send-later message (BotScheduleMessageRequest).
  router.post('/scheduled', (req, res) => {
    const chatId = parseId((req.body as { chatId?: unknown })?.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chatId is required' });
      return;
    }
    // Membership check (404, no existence leak) before any body validation, just
    // like the human route resolves the path's chat before parsing.
    const chat = getChatForMember(db, chatId, req.bot!.id);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    const result = createScheduledMessage(db, chat.id, req.bot!.id, req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ scheduled: result.dto });
  });

  // GET /api/bot/scheduled?chatId=<id> — the bot's OWN pending rows for a chat,
  // soonest first. chatId is required (400 without it); non-member → 404.
  router.get('/scheduled', (req, res) => {
    const chatId = parseId(req.query.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chatId query parameter is required' });
      return;
    }
    const chat = getChatForMember(db, chatId, req.bot!.id);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.status(200).json({ scheduled: listScheduledForSender(db, chat.id, req.bot!.id) });
  });

  // DELETE /api/bot/scheduled/:id — cancel the bot's OWN pending row (204).
  // Chat-agnostic: keyed only by the row id + this bot, so another bot's or a
  // human's row is a 404 (no leak of whether the id exists elsewhere).
  router.delete('/scheduled/:id', (req, res) => {
    const scheduledId = parseId(req.params.id);
    if (scheduledId === null) {
      res.status(404).json({ error: 'Scheduled message not found' });
      return;
    }
    if (!deleteScheduledForSender(db, scheduledId, req.bot!.id)) {
      res.status(404).json({ error: 'Scheduled message not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
