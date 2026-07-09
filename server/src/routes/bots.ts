import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { BotDTO } from '@messenger/shared';
import { requireAuth } from '../auth/session.js';
import { getMemberIds } from '../chats/service.js';
import type { Db } from '../db/index.js';
import { chatMembers, chats, users, type UserRow } from '../db/schema.js';
import { toUserDTO } from '../dto.js';
import type { ChatEvents } from '../events.js';

/**
 * Bot registration (POST /api/bots). Any authenticated human can create a bot —
 * bots are just `users` rows (isBot=true) with a generated login-proof email, a
 * random apiToken for the inbound bot API (routes/bot-api.ts), and an optional
 * webhookUrl the server POSTs to on new messages (see ../webhooks.ts). Once
 * created, a bot is indistinguishable from any other user for chats/directory
 * purposes — no other routes need to know about bots.
 */

const createBotSchema = z.object({
  name: z.string().trim().min(1).max(100),
  webhookUrl: z.url().optional(),
});

/**
 * PATCH body: an http(s) URL to (re)set the webhook, or null/'' to clear it.
 * The empty string is accepted purely so an emptied edit-form field reads as
 * "clear" without the client having to translate it to null.
 */
const updateBotSchema = z.object({
  webhookUrl: z.union([
    z.url({ protocol: /^https?$/, error: 'Webhook URL must be an http(s) URL' }),
    z.literal(''),
    z.null(),
  ]),
});

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/**
 * Bot row -> BotDTO for the management UI: the public user fields plus the
 * editable webhookUrl. Still omits apiToken/passwordHash (only toUserDTO's
 * fields are copied), so credentials never leak.
 */
function toBotDTO(bot: UserRow): BotDTO {
  return { ...toUserDTO(bot), webhookUrl: bot.webhookUrl };
}

/**
 * Fake, unique-enough email for a bot's `users` row. Bots never log in
 * (passwordHash is the unguessable, unhashable sentinel `'!'`), so this only
 * needs to satisfy the `users.email` unique constraint.
 */
function botEmail(): string {
  return `bot-${randomBytes(8).toString('hex')}@bots.local`;
}

export function botsRouter(db: Db, events: ChatEvents): Router {
  const router = Router();

  // POST /api/bots — create a bot. The apiToken is generated here and returned
  // ONLY in this response; it is never re-exposed by any other endpoint (the
  // `users` table -> UserDTO mapping in dto.ts always omits it).
  router.post('/', requireAuth, (req, res) => {
    const parsed = createBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const apiToken = randomBytes(24).toString('base64url');
    const bot = db
      .insert(users)
      .values({
        email: botEmail(),
        passwordHash: '!',
        displayName: parsed.data.name,
        isBot: true,
        webhookUrl: parsed.data.webhookUrl ?? null,
        apiToken,
      })
      .returning()
      .get();

    res.status(201).json({ bot: toUserDTO(bot), apiToken });
  });

  // GET /api/bots — list every bot for the management UI. Any authenticated
  // human may manage bots (bots are a shared resource in this personal app).
  // Returns BotDTOs (incl. webhookUrl for the edit form) but never the apiToken.
  router.get('/', requireAuth, (_req, res) => {
    const bots = db
      .select()
      .from(users)
      .where(and(eq(users.isBot, true), isNull(users.deletedAt)))
      .all();
    res.json({ bots: bots.map(toBotDTO) });
  });

  // PATCH /api/bots/:id — set or clear a bot's webhookUrl. The update is scoped
  // to isBot rows, so a human id (or an unknown id) matches nothing and 404s —
  // no existence leak, consistent with the rest of the API. A PATCHed URL takes
  // effect on the very next message: webhooks.ts reads webhookUrl live per event.
  router.patch('/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    const parsed = updateBotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    // '' means "clear" — normalize it to null so the column is consistently null.
    const webhookUrl = parsed.data.webhookUrl === '' ? null : parsed.data.webhookUrl;
    const updated = db
      .update(users)
      .set({ webhookUrl })
      .where(and(eq(users.id, id), eq(users.isBot, true), isNull(users.deletedAt)))
      .returning()
      .get();
    if (!updated) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    res.json({ bot: toBotDTO(updated) });
  });

  // DELETE /api/bots/:id — retire a bot. The row is soft-deleted (its old
  // messages keep a resolvable sender) with credentials revoked, and it is
  // pulled out of every chat — members are notified exactly like a leave, so
  // open member lists update live. A repeat delete 404s (already gone).
  router.delete('/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }
    const bot = db
      .update(users)
      .set({ deletedAt: new Date(), apiToken: null, webhookUrl: null })
      .where(and(eq(users.id, id), eq(users.isBot, true), isNull(users.deletedAt)))
      .returning()
      .get();
    if (!bot) {
      res.status(404).json({ error: 'Bot not found' });
      return;
    }

    const memberships = db
      .select({ chat: chats })
      .from(chatMembers)
      .innerJoin(chats, eq(chats.id, chatMembers.chatId))
      .where(eq(chatMembers.userId, bot.id))
      .all();
    db.delete(chatMembers).where(eq(chatMembers.userId, bot.id)).run();
    for (const { chat } of memberships) {
      events.emit('chat:updated', {
        chat,
        memberIds: getMemberIds(db, chat.id),
        addedMemberIds: [],
        removedMemberIds: [bot.id],
      });
    }
    res.status(204).end();
  });

  return router;
}
