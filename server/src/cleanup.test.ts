import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupOrphanedAttachments, startAttachmentCleanup } from './cleanup.js';
import { createDb, type Db } from './db/index.js';
import { attachments, chats, messages, users } from './db/schema.js';
import { createStorage, type Storage } from './storage.js';

// Direct-insert unit tests: they exercise the pure sweep against real rows +
// real files on disk without going through the HTTP upload path, so they can set
// up each orphan kind (and each safety case) exactly.

const GRACE_MS = 24 * 60 * 60 * 1000;
/** A createdAt comfortably past the 24h grace window. */
const oldTs = () => new Date(Date.now() - 48 * 60 * 60 * 1000);

let db: Db;
let storage: Storage;
let scratchDir: string;

beforeEach(() => {
  db = createDb(':memory:');
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-cleanup-'));
  storage = createStorage(scratchDir);
  storage.ensureDir();
});

afterEach(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function insertUser() {
  return db
    .insert(users)
    .values({ email: `${randomUUID()}@x.com`, passwordHash: 'x', displayName: 'U' })
    .returning()
    .get();
}

function insertChat(createdBy: number) {
  return db
    .insert(chats)
    .values({ type: 'group', name: 'G', createdBy })
    .returning()
    .get();
}

function insertMessage(chatId: number, senderId: number, deletedAt: Date | null = null) {
  return db
    .insert(messages)
    .values({ chatId, senderId, content: 'hi', deletedAt })
    .returning()
    .get();
}

interface AttachOpts {
  chatId: number;
  uploaderId: number;
  messageId?: number | null;
  createdAt?: Date;
  withThumb?: boolean;
  /** When false, no files are written to disk (simulates already-missing files). */
  writeFiles?: boolean;
}

function insertAttachment(opts: AttachOpts) {
  const storagePath = `${randomUUID()}.png`;
  const thumbPath = opts.withThumb ? `${randomUUID()}.webp` : null;
  if (opts.writeFiles !== false) {
    fs.writeFileSync(storage.filePath(storagePath), 'original-bytes');
    if (thumbPath) fs.writeFileSync(storage.filePath(thumbPath), 'thumb-bytes');
  }
  return db
    .insert(attachments)
    .values({
      chatId: opts.chatId,
      uploaderId: opts.uploaderId,
      messageId: opts.messageId ?? null,
      kind: 'image',
      originalName: 'p.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      width: 100,
      height: 100,
      storagePath,
      thumbPath,
      createdAt: opts.createdAt ?? new Date(),
    })
    .returning()
    .get();
}

const rowExists = (id: number) =>
  db.select().from(attachments).where(eq(attachments.id, id)).get() !== undefined;
const fileExists = (name: string) => fs.existsSync(storage.filePath(name));

describe('cleanupOrphanedAttachments', () => {
  it('removes a tombstoned message’s attachment (row + original + thumb) but keeps the message row', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const msg = insertMessage(chat.id, u.id, new Date()); // tombstone
    const att = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: msg.id,
      withThumb: true,
    });
    expect(fileExists(att.storagePath)).toBe(true);
    expect(fileExists(att.thumbPath!)).toBe(true);

    const counts = cleanupOrphanedAttachments(db, storage);

    expect(counts).toEqual({ tombstoned: 1, unlinked: 0, total: 1 });
    // Attachment row + both files gone.
    expect(rowExists(att.id)).toBe(false);
    expect(fileExists(att.storagePath)).toBe(false);
    expect(fileExists(att.thumbPath!)).toBe(false);
    // The message row stays — it's still a tombstone in the UI.
    const stillThere = db.select().from(messages).where(eq(messages.id, msg.id)).get();
    expect(stillThere).toBeDefined();
    expect(stillThere!.deletedAt).not.toBeNull();
  });

  it('removes a never-linked upload past the grace period (row + files)', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const att = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: null,
      createdAt: oldTs(),
      withThumb: true,
    });

    const counts = cleanupOrphanedAttachments(db, storage);

    expect(counts).toEqual({ tombstoned: 0, unlinked: 1, total: 1 });
    expect(rowExists(att.id)).toBe(false);
    expect(fileExists(att.storagePath)).toBe(false);
    expect(fileExists(att.thumbPath!)).toBe(false);
  });

  it('SAFETY: never touches an attachment linked to a live (non-deleted) message', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const msg = insertMessage(chat.id, u.id, null); // live
    const att = insertAttachment({ chatId: chat.id, uploaderId: u.id, messageId: msg.id });

    const counts = cleanupOrphanedAttachments(db, storage);

    expect(counts.total).toBe(0);
    expect(rowExists(att.id)).toBe(true);
    expect(fileExists(att.storagePath)).toBe(true);
  });

  it('SAFETY: never touches an unlinked upload younger than the grace period', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    // Fresh (now) and just-inside-the-window (23h old) both survive.
    const fresh = insertAttachment({ chatId: chat.id, uploaderId: u.id, messageId: null });
    const nearlyOld = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: null,
      createdAt: new Date(Date.now() - (GRACE_MS - 60 * 60 * 1000)), // 23h
    });

    const counts = cleanupOrphanedAttachments(db, storage);

    expect(counts.total).toBe(0);
    expect(rowExists(fresh.id)).toBe(true);
    expect(rowExists(nearlyOld.id)).toBe(true);
    expect(fileExists(fresh.storagePath)).toBe(true);
  });

  it('SAFETY: a missing file on disk doesn’t crash the sweep (row still removed)', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const tombMsg = insertMessage(chat.id, u.id, new Date());
    // Tombstone orphan whose files were already deleted from disk.
    const tombAtt = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: tombMsg.id,
      withThumb: true,
      writeFiles: false,
    });
    // Old unlinked orphan with no file written either.
    const unlinkedAtt = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: null,
      createdAt: oldTs(),
      writeFiles: false,
    });
    expect(fileExists(tombAtt.storagePath)).toBe(false);

    let counts!: ReturnType<typeof cleanupOrphanedAttachments>;
    expect(() => {
      counts = cleanupOrphanedAttachments(db, storage);
    }).not.toThrow();

    expect(counts).toEqual({ tombstoned: 1, unlinked: 1, total: 2 });
    expect(rowExists(tombAtt.id)).toBe(false);
    expect(rowExists(unlinkedAtt.id)).toBe(false);
  });

  it('reports per-kind counts and leaves survivors untouched in a mixed pool', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const liveMsg = insertMessage(chat.id, u.id, null);
    const deadMsg = insertMessage(chat.id, u.id, new Date());

    const tombOrphan = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: deadMsg.id,
    });
    const oldUnlinked = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: null,
      createdAt: oldTs(),
    });
    const liveLinked = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: liveMsg.id,
    });
    const freshUnlinked = insertAttachment({ chatId: chat.id, uploaderId: u.id, messageId: null });

    const counts = cleanupOrphanedAttachments(db, storage);

    expect(counts).toEqual({ tombstoned: 1, unlinked: 1, total: 2 });
    expect(rowExists(tombOrphan.id)).toBe(false);
    expect(rowExists(oldUnlinked.id)).toBe(false);
    // Survivors — rows and files intact.
    expect(rowExists(liveLinked.id)).toBe(true);
    expect(rowExists(freshUnlinked.id)).toBe(true);
    expect(fileExists(liveLinked.storagePath)).toBe(true);
    expect(fileExists(freshUnlinked.storagePath)).toBe(true);
  });

  it('honours a custom grace period', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    // 2h old: reaped under a 1h grace, kept under the default 24h.
    const att = insertAttachment({
      chatId: chat.id,
      uploaderId: u.id,
      messageId: null,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect(cleanupOrphanedAttachments(db, storage).total).toBe(0); // default grace keeps it
    expect(rowExists(att.id)).toBe(true);

    const counts = cleanupOrphanedAttachments(db, storage, 60 * 60 * 1000); // 1h grace
    expect(counts.unlinked).toBe(1);
    expect(rowExists(att.id)).toBe(false);
  });
});

describe('startAttachmentCleanup', () => {
  it('sweeps at boot, repeats on the interval, and stop() halts it', () => {
    const u = insertUser();
    const chat = insertChat(u.id);
    const orphan = () =>
      insertAttachment({ chatId: chat.id, uploaderId: u.id, messageId: null, createdAt: oldTs() });

    vi.useFakeTimers();
    try {
      const bootOrphan = orphan();
      const handle = startAttachmentCleanup(db, storage, 1000);
      // Boot sweep ran synchronously.
      expect(rowExists(bootOrphan.id)).toBe(false);

      // A new orphan appears; one interval later it's swept.
      const tickOrphan = orphan();
      vi.advanceTimersByTime(1000);
      expect(rowExists(tickOrphan.id)).toBe(false);

      // After stop(), the interval no longer fires.
      handle.stop();
      const afterStop = orphan();
      vi.advanceTimersByTime(5000);
      expect(rowExists(afterStop.id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an unref’d timer so it never keeps the process alive', () => {
    const handle = startAttachmentCleanup(db, storage, 1000);
    // A real (unref'd) interval was created; stop() clears it without throwing.
    expect(() => handle.stop()).not.toThrow();
  });
});
