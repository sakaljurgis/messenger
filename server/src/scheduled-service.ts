import type { ScheduledMessageDTO } from '@messenger/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { messages, scheduledMessages } from './db/schema.js';

/**
 * Shared send-later ("schedule a message") core, used by BOTH the human REST
 * endpoints (routes/scheduled.ts, session-cookie auth, chat id in the path) and
 * the bot API (routes/bot-api.ts, Bearer auth, chat id in the body). Both routes
 * resolve+authorize the chat their own way (membership → 404), then hand off to
 * these helpers so validation, bounds, the per-sender cap, the reply-target rule
 * and the DTO shape live in exactly one place. Keeping the rules here means a
 * bot and a human schedule under identical constraints, just as they SEND under
 * one `createMessage` path.
 */

/** How far ahead a message must be scheduled (mirrors the shared contract). */
export const MIN_LEAD_MS = 60 * 1000; // 1 minute
export const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
/** Cheap per-sender, per-chat abuse guard: at most this many pending rows. Keyed
 *  by senderId, so every bot gets its own budget independent of humans/other bots. */
export const MAX_PENDING_PER_CHAT = 20;

// content 1–4000 trimmed (same as a live send/edit); scheduledAt is validated
// for parseability + bounds in {@link createScheduledMessage} (a plain string
// here so the bounds message is specific rather than a generic zod "invalid
// datetime"). Unknown keys (e.g. the bot route's `chatId`) are stripped by zod.
const scheduleSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  mentions: z.array(z.number().int().positive()).optional(),
  replyToId: z.number().int().positive().optional(),
  scheduledAt: z.string(),
});

/** First zod issue message, for the `{ error }` body. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

/** Parse a positive-int id (path param or query value); NaN/garbage -> null. */
export function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type ScheduledRow = typeof scheduledMessages.$inferSelect;

/** Serialize a stored row to the wire DTO (timestamps → ISO, mentions JSON → array). */
export function toScheduledDTO(row: ScheduledRow): ScheduledMessageDTO {
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
 * Outcome of {@link createScheduledMessage}: either the queued DTO, or the exact
 * status + `{ error }` string the route should send back. A discriminated union
 * so the caller stays a two-line handler that never re-derives error mapping.
 */
export type CreateScheduledResult =
  | { ok: true; dto: ScheduledMessageDTO }
  | { ok: false; status: number; error: string };

/**
 * Validate `body` and, if it passes, queue a send-later row for `senderId` in
 * `chatId`. The caller MUST have already verified `senderId` is a member of
 * `chatId` (this function does not re-check membership). Enforces, in order:
 * content 1–4000 trimmed, a parseable future `scheduledAt` within [1min, 1yr],
 * a live reply target in this chat (if any), and the per-sender pending cap.
 */
export function createScheduledMessage(
  db: Db,
  chatId: number,
  senderId: number,
  body: unknown,
): CreateScheduledResult {
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: firstIssue(parsed.error) };

  const when = new Date(parsed.data.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, status: 400, error: 'Invalid scheduled time' };
  }
  const lead = when.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) {
    return {
      ok: false,
      status: 400,
      error: 'Scheduled time must be at least 1 minute in the future',
    };
  }
  if (lead > MAX_LEAD_MS) {
    return { ok: false, status: 400, error: 'Scheduled time must be within 1 year' };
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
    if (!target || target.chatId !== chatId || target.deletedAt !== null) {
      return { ok: false, status: 400, error: 'Invalid reply target' };
    }
  }

  // Cheap abuse guard: cap pending rows per sender per chat.
  const pending = db
    .select({ n: count() })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.chatId, chatId), eq(scheduledMessages.senderId, senderId)))
    .get();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_CHAT) {
    return {
      ok: false,
      status: 400,
      error: `Too many scheduled messages for this chat (max ${MAX_PENDING_PER_CHAT})`,
    };
  }

  const mentions = [...new Set(parsed.data.mentions ?? [])];
  const row = db
    .insert(scheduledMessages)
    .values({
      chatId,
      senderId,
      content: parsed.data.content,
      mentions: JSON.stringify(mentions),
      replyToId: parsed.data.replyToId ?? null,
      scheduledAt: when,
    })
    .returning()
    .get();

  return { ok: true, dto: toScheduledDTO(row) };
}

/** `senderId`'s pending rows for `chatId`, soonest first (never another sender's). */
export function listScheduledForSender(
  db: Db,
  chatId: number,
  senderId: number,
): ScheduledMessageDTO[] {
  const rows = db
    .select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.chatId, chatId), eq(scheduledMessages.senderId, senderId)))
    .orderBy(asc(scheduledMessages.scheduledAt), asc(scheduledMessages.id))
    .all();
  return rows.map(toScheduledDTO);
}

/**
 * Delete `senderId`'s own pending row `scheduledId`; returns whether a row was
 * removed (false → the caller sends 404, leaking nothing about whether the id
 * exists for another sender). `chatId` is an optional extra scope: the human
 * route passes it (the row must be in the path's chat); the bot route omits it
 * (its DELETE is chat-agnostic, keyed only by the row id + the bot).
 */
export function deleteScheduledForSender(
  db: Db,
  scheduledId: number,
  senderId: number,
  chatId?: number,
): boolean {
  const conditions = [
    eq(scheduledMessages.id, scheduledId),
    eq(scheduledMessages.senderId, senderId),
  ];
  if (chatId !== undefined) conditions.push(eq(scheduledMessages.chatId, chatId));
  const result = db.delete(scheduledMessages).where(and(...conditions)).run();
  return result.changes > 0;
}
