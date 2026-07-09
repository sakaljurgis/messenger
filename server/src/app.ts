import express from 'express';
import cookieParser from 'cookie-parser';
import type { Db } from './db/index.js';
import { sessionMiddleware } from './auth/session.js';
import { createChatEvents, type ChatEvents } from './events.js';
import { authRouter } from './routes/auth.js';
import { botApiRouter } from './routes/bot-api.js';
import { botsRouter } from './routes/bots.js';
import { chatsRouter } from './routes/chats.js';
import { pushRouter } from './routes/push.js';
import { usersRouter } from './routes/users.js';

/**
 * Builds the Express app with all API routes. HTTP listening, static file
 * serving and Socket.IO live in index.ts — keeping this factory pure makes
 * supertest tests trivial: `request(createApp(createDb(':memory:')))`.
 *
 * `events` is the fan-out bus the chat routes emit on; index.ts passes a shared
 * instance so later phases (sockets/push/webhooks) can subscribe. Defaults to a
 * throwaway bus so existing callers/tests keep compiling with no listeners.
 */
export function createApp(db: Db, events: ChatEvents = createChatEvents()) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Populates req.user from the session cookie for every downstream router.
  app.use(sessionMiddleware(db));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Routers are mounted here as phases land:
  app.use('/api/auth', authRouter(db));
  app.use('/api/users', usersRouter(db));
  app.use('/api/chats', chatsRouter(db, events));
  app.use('/api/push', pushRouter(db));
  app.use('/api/bots', botsRouter(db));
  app.use('/api/bot', botApiRouter(db, events));

  // JSON 404 for unknown API paths (must stay after all routers).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
