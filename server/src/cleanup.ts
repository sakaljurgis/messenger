import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { attachments, messages } from './db/schema.js';
import type { Storage } from './storage.js';

/**
 * How long a never-linked upload is kept before it's considered abandoned. The
 * composer creates an attachment ROW the moment a file is picked (messageId
 * still null) and only links it to a message on send — so a freshly uploaded,
 * still-unlinked row may just be mid-compose. We give it a full day's grace
 * before reaping it.
 */
const DEFAULT_UNLINKED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Default interval between background sweeps (6h). */
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Per-kind removal tally returned by {@link cleanupOrphanedAttachments} (for logging). */
export interface CleanupCounts {
  /** Rows removed because their owning message is a tombstone (`messages.deletedAt` set). */
  tombstoned: number;
  /** Rows removed because they were uploaded but never linked, past the grace age. */
  unlinked: number;
  /** `tombstoned + unlinked`. */
  total: number;
}

/**
 * Sweeps orphaned attachments off the volume + out of the DB. Pure and
 * injectable (no timers, no env, no globals) so tests drive it directly with a
 * `createDb(':memory:')` + `createStorage(tmpdir)`. Two disjoint orphan kinds:
 *
 * (a) **Tombstone leftovers** — attachments still linked to a soft-deleted
 *     message. (The normal delete path in `chats/service#deleteMessage` already
 *     unlinks these eagerly; this is the safety net for a partial failure or a
 *     tombstone created by some other path.) The message ROW is deliberately
 *     kept — it's still a tombstone in the UI; only the files + attachment rows
 *     go. Safe because the tombstone DTO renders empty attachments regardless
 *     (see `dto#toMessageDTO`) and a reply-quote to a deleted message forces
 *     `hasAttachments: false` (see `dto#toReplyToDTO`) — neither consults these
 *     rows, so removing them can't change any rendering.
 *
 * (b) **Never-linked uploads** — `messageId IS NULL` (user picked a file then
 *     navigated away) AND older than `graceMs` (younger ones may be mid-compose
 *     and are never touched).
 *
 * For each orphan the original file and its thumbnail (when present) are removed
 * (`storage.remove` tolerates a file that's already gone — a missing file never
 * aborts the sweep) and the row is deleted. A live-message attachment is never
 * selected by either predicate. Returns per-kind counts for the caller to log.
 */
export function cleanupOrphanedAttachments(
  db: Db,
  storage: Storage,
  graceMs: number = DEFAULT_UNLINKED_GRACE_MS,
): CleanupCounts {
  // (a) Linked to a tombstoned message. INNER JOIN → only rows whose message
  // still exists AND carries a deletedAt; a live message (deletedAt IS NULL) or
  // an unlinked row (no join match) is excluded.
  const tombstoned = db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
      thumbPath: attachments.thumbPath,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(isNotNull(messages.deletedAt))
    .all();

  // (b) Never linked and older than the grace age.
  const cutoff = new Date(Date.now() - graceMs);
  const unlinked = db
    .select({
      id: attachments.id,
      storagePath: attachments.storagePath,
      thumbPath: attachments.thumbPath,
    })
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .all();

  // The two sets are disjoint (messageId non-null vs null), so no id repeats.
  for (const orphan of [...tombstoned, ...unlinked]) {
    storage.remove(orphan.storagePath);
    if (orphan.thumbPath) storage.remove(orphan.thumbPath);
    db.delete(attachments).where(eq(attachments.id, orphan.id)).run();
  }

  return {
    tombstoned: tombstoned.length,
    unlinked: unlinked.length,
    total: tombstoned.length + unlinked.length,
  };
}

/** Handle for the periodic sweep started by {@link startAttachmentCleanup}. */
export interface AttachmentCleanupHandle {
  /** Stop the periodic sweep (clears the interval). Idempotent. */
  stop(): void;
}

/**
 * Boot wiring for {@link cleanupOrphanedAttachments}: runs one sweep immediately,
 * then repeats every `intervalMs` (default 6h). The interval is `unref()`d so it
 * never keeps the process (or a test) alive on its own, and `stop()` clears it
 * outright. Sweeps are wrapped so a transient failure logs rather than crashes
 * the timer. Intended to be called once from `index.ts`.
 */
export function startAttachmentCleanup(
  db: Db,
  storage: Storage,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): AttachmentCleanupHandle {
  const sweep = () => {
    try {
      const counts = cleanupOrphanedAttachments(db, storage);
      if (counts.total > 0) {
        console.log(
          `[cleanup] removed ${counts.total} orphaned attachment(s) ` +
            `(${counts.tombstoned} tombstoned, ${counts.unlinked} unlinked)`,
        );
      }
    } catch (err) {
      console.error('[cleanup] attachment sweep failed', err);
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
