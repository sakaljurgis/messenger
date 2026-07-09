import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import type { Db } from '../db/index.js';
import { pushSubscriptions } from '../db/schema.js';
import { getVapidPublicKey } from '../push.js';

const subscribeSchema = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

export function pushRouter(db: Db): Router {
  const router = Router();

  // GET /api/push/vapid-key — the public key the client subscribes with. `null`
  // when the server has no VAPID keys configured (push disabled).
  router.get('/vapid-key', requireAuth, (_req, res) => {
    res.status(200).json({ key: getVapidPublicKey() });
  });

  // POST /api/push/subscribe — store (or move) a browser push subscription.
  // Endpoint is globally unique: upserting on it means switching accounts in the
  // same browser profile reassigns the existing subscription to the new user.
  router.post('/subscribe', requireAuth, (req, res) => {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const { endpoint, keys } = parsed.data;
    db.insert(pushSubscriptions)
      .values({ userId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth },
      })
      .run();
    res.status(201).json({ ok: true });
  });

  // DELETE /api/push/subscribe — drop a subscription. Scoped to the requester so
  // a user can only remove their own; unknown/foreign endpoints are a no-op 204.
  router.delete('/subscribe', requireAuth, (req, res) => {
    const parsed = unsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    db.delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, parsed.data.endpoint),
          eq(pushSubscriptions.userId, req.user!.id),
        ),
      )
      .run();
    res.status(204).end();
  });

  return router;
}
