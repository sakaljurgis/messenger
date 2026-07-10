import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchMessages,
} from '../chats/service.js';
import type { Db } from '../db/index.js';

/** Parse an optional `before` cursor query param (positive int, else null). */
function parseCursor(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Clamp the `limit` query param to [1, MAX], defaulting when absent/invalid. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_SEARCH_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_SEARCH_LIMIT;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

/**
 * GET /api/search?q=<terms>&before=<cursor>&limit=<n> — full-text search over
 * messages in the caller's own chats (FTS5), newest first, tombstones excluded.
 * Membership + tombstone filtering happen inside the SQL query (see
 * {@link searchMessages}) so nothing from another user's chats can ever leak.
 */
export function searchRouter(db: Db): Router {
  const router = Router();

  router.get('/', requireAuth, (req, res) => {
    const me = req.user!;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length === 0) {
      res.status(400).json({ error: 'Search query required' });
      return;
    }
    const before = parseCursor(req.query.before);
    const limit = parseLimit(req.query.limit);
    res.status(200).json(searchMessages(db, me.id, q, before, limit));
  });

  return router;
}
