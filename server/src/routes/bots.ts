import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { toUserDTO } from '../dto.js';

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

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/**
 * Fake, unique-enough email for a bot's `users` row. Bots never log in
 * (passwordHash is the unguessable, unhashable sentinel `'!'`), so this only
 * needs to satisfy the `users.email` unique constraint.
 */
function botEmail(): string {
  return `bot-${randomBytes(8).toString('hex')}@bots.local`;
}

export function botsRouter(db: Db): Router {
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

  return router;
}
