import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  requireAuth,
  setSessionCookie,
} from '../auth/session.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { toUserDTO } from '../dto.js';

const registerSchema = z.object({
  email: z.email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

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

export function authRouter(db: Db): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const { password, displayName } = parsed.data;

    const existing = db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = db
        .insert(users)
        .values({ email, passwordHash, displayName })
        .returning()
        .get();
    } catch (err) {
      // Guards against a race between the check above and this insert.
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }
      throw err;
    }

    const token = createSession(db, user.id);
    setSessionCookie(res, token);
    res.status(201).json({ user: toUserDTO(user) });
  });

  router.post('/login', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const user = db.select().from(users).where(eq(users.email, email)).get();
    // Same response for unknown email and wrong password (no user enumeration).
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = createSession(db, user.id);
    setSessionCookie(res, token);
    res.status(200).json({ user: toUserDTO(user) });
  });

  router.post('/logout', requireAuth, (req, res) => {
    const token: unknown = req.cookies?.sid;
    if (typeof token === 'string' && token.length > 0) {
      deleteSession(db, token);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.status(200).json({ user: toUserDTO(req.user!) });
  });

  return router;
}
