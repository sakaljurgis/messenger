import { asc, eq, lte } from 'drizzle-orm';
import { createMessage, getChatForMember } from './chats/service.js';
import type { Db } from './db/index.js';
import { messages, scheduledMessages } from './db/schema.js';
import type { ChatEvents } from './events.js';

/** Default interval between dispatch ticks (30s). */
const DEFAULT_INTERVAL_MS = 30 * 1000;

/** Parse the JSON `mentions` column to a number[] (tolerant of corruption). */
function parseMentions(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === 'number');
  } catch {
    // never let a bad row block the tick
  }
  return [];
}

/**
 * One dispatch pass: sends every scheduled row whose time has come (soonest
 * first) through the SAME `createMessage` path a live POST uses, so the shared
 * bus fans the send out to sockets/push/webhooks/link-previews identically.
 * Returns the number of rows actually sent (for logging/tests).
 *
 * Per-row re-validation at send time (state may have changed since scheduling):
 *   - Sender no longer a member of the chat (they left, or the chat is gone) →
 *     the row is DROPPED silently. Sending on their behalf into a chat they left
 *     would be wrong, and there is no one to surface an error to.
 *   - Reply target no longer a live message in the chat (edited-away is fine, but
 *     hard-deleted via chat teardown, or soft-deleted) → the message is still
 *     sent, WITHOUT the reply reference (degrade, don't drop) — losing a quote is
 *     far less surprising than silently dropping the whole message.
 *
 * Double-send safety — the deliberate tradeoff: each due row is CLAIMED by
 * deleting it BEFORE the send (delete-then-send). better-sqlite3 is synchronous
 * and this loop runs to completion on a single event-loop turn with no `await`
 * between claiming a row and sending it, so overlapping interval ticks can never
 * double-process the same row. Deleting first means the only failure window is a
 * hard process crash in the microscopic synchronous gap between the delete and
 * the insert, in which case that one message is LOST rather than sent twice — a
 * duplicate message is more confusing/harmful in a chat than a rare missed
 * send, so we favor at-most-once. (createMessage runs its own transaction and
 * emits synchronously, so wrapping the delete + send in one outer transaction
 * would risk firing subscribers on a row that later rolls back; delete-then-send
 * avoids that entirely.)
 */
export function dispatchDueScheduledMessages(
  db: Db,
  events: ChatEvents,
  now: Date = new Date(),
): number {
  const due = db
    .select()
    .from(scheduledMessages)
    .where(lte(scheduledMessages.scheduledAt, now))
    .orderBy(asc(scheduledMessages.scheduledAt), asc(scheduledMessages.id))
    .all();

  let sent = 0;
  for (const row of due) {
    try {
      // Sender must still be a member; otherwise drop the row silently.
      const chat = getChatForMember(db, row.chatId, row.senderId);
      if (!chat) {
        db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id)).run();
        continue;
      }

      // Reply target must still be live in this chat; a stale target degrades to
      // a plain send rather than dropping the message.
      let replyToId: number | undefined = row.replyToId ?? undefined;
      if (replyToId !== undefined) {
        const target = db.select().from(messages).where(eq(messages.id, replyToId)).get();
        if (!target || target.chatId !== chat.id || target.deletedAt !== null) {
          replyToId = undefined;
        }
      }

      // Claim the row FIRST (delete-then-send) so it can never double-send.
      db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id)).run();

      const result = createMessage(db, events, {
        chatId: row.chatId,
        senderId: row.senderId,
        content: row.content,
        mentions: parseMentions(row.mentions),
        replyToId,
      });
      if (result.ok) {
        sent += 1;
      } else {
        // The row is already claimed (deleted); a failure here loses the one
        // message but never resends. Should be unreachable after re-validation.
        console.warn(`[scheduled] createMessage rejected a due row (${result.reason}); dropped`);
      }
    } catch (err) {
      // Contain a single bad row so the rest of the tick still runs.
      console.error(`[scheduled] failed to dispatch row ${row.id}`, err);
    }
  }
  return sent;
}

/** Handle for the periodic dispatcher started by {@link startScheduledDispatcher}. */
export interface ScheduledDispatcherHandle {
  /** Stop the periodic dispatch (clears the interval). Idempotent. */
  stop(): void;
}

/**
 * Boot wiring for {@link dispatchDueScheduledMessages}: runs one pass immediately
 * (so a message that came due while the process was down goes out at startup),
 * then repeats every `intervalMs` (default 30s). Mirrors cleanup.ts: the interval
 * is `unref()`d so it never keeps the process (or a test) alive on its own, each
 * tick is wrapped so a transient failure logs rather than crashes the timer, and
 * `stop()` clears it. Intended to be called once from `index.ts`.
 */
export function startScheduledDispatcher(
  db: Db,
  events: ChatEvents,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): ScheduledDispatcherHandle {
  const tick = () => {
    try {
      const count = dispatchDueScheduledMessages(db, events);
      if (count > 0) console.log(`[scheduled] dispatched ${count} due message(s)`);
    } catch (err) {
      console.error('[scheduled] dispatch tick failed', err);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
