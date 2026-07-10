import { Router } from 'express';
import { requireAuth } from '../auth/session.js';
import { getChatForMember } from '../chats/service.js';
import type { Db } from '../db/index.js';
import {
  createScheduledMessage,
  deleteScheduledForSender,
  listScheduledForSender,
  parseId,
} from '../scheduled-service.js';

const CHAT_NOT_FOUND = { error: 'Chat not found' };

/**
 * Send-later ("schedule a message") REST endpoints, mounted at /api/chats so it
 * owns the `/:id/scheduled` path shapes the chats router never matches. Rows are
 * dispatched later by the background dispatcher (scheduled.ts) through the exact
 * same `createMessage` path a live POST uses. Validation, bounds, the per-sender
 * cap and the DTO shape live in scheduled-service.ts, shared with the bot API.
 */
export function scheduledRouter(db: Db): Router {
  const router = Router();

  // POST /api/chats/:id/scheduled — queue a send-later message.
  router.post('/:id/scheduled', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }

    const result = createScheduledMessage(db, chat.id, me.id, req.body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ scheduled: result.dto });
  });

  // GET /api/chats/:id/scheduled — MY pending scheduled messages for this chat,
  // soonest first. Only the requester's own rows (never another member's).
  router.get('/:id/scheduled', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    res.status(200).json({ scheduled: listScheduledForSender(db, chat.id, me.id) });
  });

  // DELETE /api/chats/:id/scheduled/:scheduledId — cancel MY own pending row.
  router.delete('/:id/scheduled/:scheduledId', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.id);
    const scheduledId = parseId(req.params.scheduledId);
    const chat = chatId === null ? undefined : getChatForMember(db, chatId, me.id);
    if (!chat) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }
    if (scheduledId === null) {
      res.status(404).json({ error: 'Scheduled message not found' });
      return;
    }

    // Only my own row in this chat is deletable; anything else is a 404 (no leak
    // of whether the id exists for another user/chat).
    if (!deleteScheduledForSender(db, scheduledId, me.id, chat.id)) {
      res.status(404).json({ error: 'Scheduled message not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
