import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { RequestHandler, Response } from 'express';
import type { Db } from '../db/index.js';
import { sessions, users, type UserRow } from '../db/schema.js';

/** How long a session cookie/row stays valid: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const COOKIE_NAME = 'sid';

/** Create a session row for a user and return the opaque token. */
export function createSession(db: Db, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.insert(sessions).values({ token, userId, expiresAt }).run();
  return token;
}

/** Remove a session row (idempotent). */
export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.token, token)).run();
}

/**
 * Resolve an opaque session token to its user, or undefined when the token is
 * unknown or expired (expired rows are pruned on the way out). Shared by the
 * Express session middleware and the Socket.IO handshake so both agree on
 * exactly what "a valid session" means.
 */
export function getSessionUser(db: Db, token: string): UserRow | undefined {
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.token, token))
    .get();
  if (!session) return undefined;

  if (session.expiresAt.getTime() <= Date.now()) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
    return undefined;
  }

  return db.select().from(users).where(eq(users.id, session.userId)).get();
}

/**
 * Populates `req.user` from the `sid` cookie when a live session exists.
 * Expired sessions are pruned. Never throws — an unauthenticated request just
 * proceeds with `req.user` left undefined.
 */
export function sessionMiddleware(db: Db): RequestHandler {
  return (req, _res, next) => {
    try {
      const token: unknown = req.cookies?.sid;
      if (typeof token !== 'string' || token.length === 0) return next();

      const user = getSessionUser(db, token);
      if (user) req.user = user;
    } catch {
      // Swallow — treat any failure as "not authenticated".
    }
    next();
  };
}

/** Guard that rejects requests without an authenticated user. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

/** Set the httpOnly session cookie. */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
    secure: process.env.NODE_ENV === 'production',
  });
}

/** Clear the session cookie (must mirror the attributes used to set it). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}
