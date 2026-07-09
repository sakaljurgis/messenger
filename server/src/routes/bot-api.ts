import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { createMessage } from '../chats/service.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { ChatEvents } from '../events.js';

/**
 * The inbound bot API (mounted at /api/bot in app.ts). Authenticated by
 * `Authorization: Bearer <apiToken>` instead of the session cookie — bots have
 * no browser session. Deliberately thin: it re-uses chats/service#createMessage,
 * the exact path routes/chats.ts uses for humans, so bots and humans send
 * messages through one code path with one set of rules (member-only, mention
 * filtering, unread bookkeeping, `message:new` fan-out).
 */

const sendSchema = z
  .object({
    chatId: z.number().int().positive(),
    // Empty content is allowed only with at least one attachment (see refine).
    content: z.string().trim().max(4000).optional().default(''),
    mentions: z.array(z.number().int().positive()).optional(),
    attachmentIds: z.array(z.number().int().positive()).optional(),
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
    });
    if (!result.ok) {
      if (result.reason === 'invalid-attachments') {
        res.status(400).json({ error: 'Invalid attachments' });
        return;
      }
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    res.status(201).json({ message: result.message });
  });

  return router;
}
