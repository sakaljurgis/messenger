import { ne, sql } from 'drizzle-orm';
import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { toUserDTO } from '../dto.js';

export function usersRouter(db: Db): Router {
  const router = Router();

  // GET /api/users — everyone except the requester, ordered by display name
  // (case-insensitive) for a stable directory.
  router.get('/', requireAuth, (req, res) => {
    const me = req.user!;
    const rows = db
      .select()
      .from(users)
      .where(ne(users.id, me.id))
      .orderBy(sql`lower(${users.displayName})`)
      .all();
    res.status(200).json({ users: rows.map(toUserDTO) });
  });

  return router;
}
