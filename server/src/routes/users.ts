import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireAuth } from '../auth/session.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { toUserDTO } from '../dto.js';

// Mirrors registerSchema's rules (auth.ts) for the fields that can change.
const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

export function usersRouter(db: Db): Router {
  const router = Router();

  // GET /api/users — everyone except the requester (and soft-deleted bots),
  // ordered by display name (case-insensitive) for a stable directory.
  router.get('/', requireAuth, (req, res) => {
    const me = req.user!;
    const rows = db
      .select()
      .from(users)
      .where(and(ne(users.id, me.id), isNull(users.deletedAt)))
      .orderBy(sql`lower(${users.displayName})`)
      .all();
    res.status(200).json({ users: rows.map(toUserDTO) });
  });

  // PATCH /api/users/me — update own profile (display name).
  router.patch('/me', requireAuth, (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    const updated = db
      .update(users)
      .set({ displayName: parsed.data.displayName })
      .where(eq(users.id, req.user!.id))
      .returning()
      .get();
    res.status(200).json({ user: toUserDTO(updated) });
  });

  // PUT /api/users/me/password — change own password; the current one must
  // verify first. Existing sessions stay valid (personal app, own devices).
  router.put('/me/password', requireAuth, async (req, res) => {
    const me = req.user!;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }
    if (!(await verifyPassword(parsed.data.currentPassword, me.passwordHash))) {
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }
    const passwordHash = await hashPassword(parsed.data.newPassword);
    db.update(users).set({ passwordHash }).where(eq(users.id, me.id)).run();
    res.status(204).end();
  });

  return router;
}
