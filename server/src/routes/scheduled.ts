import type { ScheduledMessageDTO } from '@messenger/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { getChatForMember } from '../chats/service.js';
import type { Db } from '../db/index.js';
import { messages, scheduledMessages } from '../db/schema.js';

/** How far ahead a message must be scheduled (mirrors the shared contract). */
const MIN_LEAD_MS = 60 * 1000; // 1 minute
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
/** Cheap per-user, per-chat abuse guard: at most this many pending rows. */
const MAX_PENDING_PER_CHAT = 20;

// content 1–4000 trimmed (same as a live send/edit); scheduledAt is validated
// for parseability + bounds in the handler (a plain string here so the bounds
// message is specific rather than a generic zod "invalid datetime").
const scheduleSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  mentions: z.array(z.number().int().positive()).optional(),
  replyToId: z.number().int().positive().optional(),
  scheduledAt: z.string(),
});

/** First zod issue message, for the `{ error }` body. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/** Parse a positive-int path param; NaN/garbage -> null (treated as 404 by callers). */
function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const CHAT_NOT_FOUND = { error: 'Chat not found' };

type ScheduledRow = typeof scheduledMessages.$inferSelect;

/** Serialize a stored row to the wire DTO (timestamps → ISO, mentions JSON → array). */
function toScheduledDTO(row: ScheduledRow): ScheduledMessageDTO {
  let mentions: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.mentions);
    if (Array.isArray(parsed)) mentions = parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    // Corrupt JSON should never happen (we always write via JSON.stringify), but
    // never let it break listing — fall back to no mentions.
  }
  return {
    id: row.id,
    chatId: row.chatId,
    content: row.content,
    mentions,
    replyToId: row.replyToId,
    scheduledAt: row.scheduledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Send-later ("schedule a message") REST endpoints, mounted at /api/chats so it
 * owns the `/:id/scheduled` path shapes the chats router never matches. Rows are
 * dispatched later by the background dispatcher (scheduled.ts) through the exact
 * same `createMessage` path a live POST uses.
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

    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssue(parsed.error) });
      return;
    }

    const when = new Date(parsed.data.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: 'Invalid scheduled time' });
      return;
    }
    const lead = when.getTime() - Date.now();
    if (lead < MIN_LEAD_MS) {
      res.status(400).json({ error: 'Scheduled time must be at least 1 minute in the future' });
      return;
    }
    if (lead > MAX_LEAD_MS) {
      res.status(400).json({ error: 'Scheduled time must be within 1 year' });
      return;
    }

    // Reply target must be a live message in THIS chat AT SCHEDULING TIME (same
    // rule a live send enforces via createMessage). The dispatcher re-checks at
    // send time and degrades a stale target to a plain send rather than dropping.
    if (parsed.data.replyToId !== undefined) {
      const target = db
        .select()
        .from(messages)
        .where(eq(messages.id, parsed.data.replyToId))
        .get();
      if (!target || target.chatId !== chat.id || target.deletedAt !== null) {
        res.status(400).json({ error: 'Invalid reply target' });
        return;
      }
    }

    // Cheap abuse guard: cap pending rows per user per chat.
    const pending = db
      .select({ n: count() })
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.chatId, chat.id), eq(scheduledMessages.senderId, me.id)))
      .get();
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_CHAT) {
      res
        .status(400)
        .json({ error: `Too many scheduled messages for this chat (max ${MAX_PENDING_PER_CHAT})` });
      return;
    }

    const mentions = [...new Set(parsed.data.mentions ?? [])];
    const row = db
      .insert(scheduledMessages)
      .values({
        chatId: chat.id,
        senderId: me.id,
        content: parsed.data.content,
        mentions: JSON.stringify(mentions),
        replyToId: parsed.data.replyToId ?? null,
        scheduledAt: when,
      })
      .returning()
      .get();

    res.status(201).json({ scheduled: toScheduledDTO(row) });
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

    const rows = db
      .select()
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.chatId, chat.id), eq(scheduledMessages.senderId, me.id)))
      .orderBy(asc(scheduledMessages.scheduledAt), asc(scheduledMessages.id))
      .all();
    res.status(200).json({ scheduled: rows.map(toScheduledDTO) });
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
    const result = db
      .delete(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.id, scheduledId),
          eq(scheduledMessages.chatId, chat.id),
          eq(scheduledMessages.senderId, me.id),
        ),
      )
      .run();
    if (result.changes === 0) {
      res.status(404).json({ error: 'Scheduled message not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
