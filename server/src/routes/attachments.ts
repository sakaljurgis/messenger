import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AttachmentKind } from '@messenger/shared';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { requireAuth } from '../auth/session.js';
import { getChatForMember } from '../chats/service.js';
import type { Db } from '../db/index.js';
import { attachments } from '../db/schema.js';
import { toAttachmentDTO } from '../dto.js';
import type { Storage } from '../storage.js';

/** 25MB upload cap. */
const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Longest edge of a generated thumbnail; images larger than this get one. */
const THUMB_MAX = 512;
/**
 * Mimes treated as inline-previewable images. Note image/svg+xml is deliberately
 * absent: inline SVG is an XSS vector, so SVGs are stored as opaque 'file's.
 */
const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/**
 * Video mimes the client renders inline (<video>). mp4/webm decode everywhere;
 * quicktime (.mov — what iPhones record) plays natively in Safari and usually
 * in Chrome (H.264 tracks), and the client swaps in a download card via the
 * <video> element's onError when a browser genuinely can't decode one. Any
 * other video/* stays kind 'file' — a download card, same as an unrecognized
 * document.
 */
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/**
 * Extension → mime fallback for the inline-safe video types. Browsers derive a
 * file's type from the OS extension registry, and outside Apple platforms (or
 * for freshly re-downloaded files) a .mov commonly arrives as '' or
 * 'application/octet-stream' — which would wrongly demote it to a download
 * card. Only these known video extensions are ever upgraded; everything else
 * keeps whatever the browser said.
 */
const VIDEO_EXT_MIMES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * Normalize the browser-reported mime (lowercase, parameters like `;codecs=`
 * stripped); when it's missing/generic, fall back to the filename extension
 * for the known video types. The result is what gets STORED — playback needs
 * a real video/* Content-Type, so kind alone wouldn't be enough.
 */
function effectiveMimeType(reported: string, originalName: string): string {
  const normalized = (reported ?? '').split(';')[0]!.trim().toLowerCase();
  if (normalized === '' || normalized === 'application/octet-stream') {
    const ext = path.extname(originalName).toLowerCase();
    return VIDEO_EXT_MIMES[ext] ?? normalized;
  }
  return normalized;
}

const CHAT_NOT_FOUND = { error: 'Chat not found' };
const NOT_FOUND = { error: 'Not found' };

/** Parse a positive-int path param; NaN/garbage -> null (treated as 404 by callers). */
function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Keep only a plausible, short file extension (leading dot, alnum) for the stored name. */
function safeExt(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/** Parsed outcome of a client `Range` header against a known file size. */
type RangeResult = 'full' | 'unsatisfiable' | { start: number; end: number };

/**
 * Parses a single-range `Range: bytes=<start>-<end>` header (open-ended
 * `bytes=100-` and suffix `bytes=-100` forms included) against `size`.
 * Multipart ranges (comma-separated) are deliberately treated as 'full' —
 * this endpoint only ever streams one range, so a multi-range request just
 * gets the whole file rather than a real `multipart/byteranges` response.
 * No header at all is also 'full'. Anything else that doesn't resolve to an
 * in-bounds, non-empty range is 'unsatisfiable' (the caller sends 416).
 */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return 'full';
  const raw = header.trim();
  if (raw.includes(',')) return 'full';
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match) return 'unsatisfiable';
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return 'unsatisfiable';

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * The attachments router (mounted at /api). Owns both the upload endpoint
 * (POST /chats/:chatId/attachments) and the authenticated streaming endpoint
 * (GET /attachments/:id). Files live on the volume via the injected Storage;
 * only metadata is in the DB.
 */
export function attachmentsRouter(db: Db, storage: Storage): Router {
  const router = Router();

  // multer writes the raw upload straight into the storage dir under an
  // unguessable name; the extension is sanitized off the (untrusted) filename.
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, storage.dir),
      filename: (_req, file, cb) => cb(null, randomUUID() + safeExt(file.originalname)),
    }),
    limits: { fileSize: MAX_FILE_SIZE },
  }).single('file');

  // POST /api/chats/:chatId/attachments — upload one file to a chat the caller
  // is a member of. Returns the attachment (messageId still null) to link on send.
  router.post('/chats/:chatId/attachments', requireAuth, (req, res) => {
    const me = req.user!;
    const chatId = parseId(req.params.chatId);
    // Member check first: never write a file for a non-member.
    if (chatId === null || !getChatForMember(db, chatId, me.id)) {
      res.status(404).json(CHAT_NOT_FOUND);
      return;
    }

    upload(req, res, (err: unknown) => {
      void (async () => {
        if (err) {
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'File too large (max 25MB)' });
            return;
          }
          res.status(400).json({ error: 'Upload failed' });
          return;
        }
        const file = req.file;
        if (!file) {
          res.status(400).json({ error: 'No file uploaded' });
          return;
        }

        const storedName = file.filename;
        // multer hands back originalname as latin1 bytes — re-decode to utf8.
        const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const originalName = path.basename(decoded).slice(0, 200) || 'file';
        const mimeType = effectiveMimeType(file.mimetype, originalName);

        // Videos get no thumbnail/dimensions (sharp never runs on them) — just
        // the kind tag so the client knows to render an inline <video>.
        let kind: AttachmentKind = IMAGE_MIMES.has(mimeType)
          ? 'image'
          : VIDEO_MIMES.has(mimeType)
            ? 'video'
            : 'file';
        let width: number | null = null;
        let height: number | null = null;
        let thumbName: string | null = null;

        if (kind === 'image') {
          try {
            const source = storage.filePath(storedName);
            const meta = await sharp(source).metadata();
            width = meta.width ?? null;
            height = meta.height ?? null;
            if (width !== null && height !== null && (width > THUMB_MAX || height > THUMB_MAX)) {
              // A fresh UUID avoids ever colliding with a .webp original.
              thumbName = `${randomUUID()}.webp`;
              await sharp(source)
                .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 75 })
                .toFile(storage.filePath(thumbName));
            }
          } catch {
            // Corrupt bytes or a lying mime: keep the upload but treat it as an
            // opaque file — no dimensions, no thumbnail.
            kind = 'file';
            width = null;
            height = null;
            if (thumbName) storage.remove(thumbName);
            thumbName = null;
          }
        }

        const row = db
          .insert(attachments)
          .values({
            chatId,
            uploaderId: me.id,
            messageId: null,
            kind,
            originalName,
            mimeType,
            sizeBytes: file.size,
            width,
            height,
            storagePath: storedName,
            thumbPath: thumbName,
          })
          .returning()
          .get();

        res.status(201).json({ attachment: toAttachmentDTO(row) });
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
      });
    });
  });

  // GET /api/attachments/:id — stream an attachment. Linked attachments are
  // visible to any member of the owning chat; still-unlinked ones only to their
  // uploader. Variants: ?thumb=1 (webp thumb), ?download=1 (force download).
  router.get('/attachments/:id', requireAuth, (req, res) => {
    const me = req.user!;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const att = db.select().from(attachments).where(eq(attachments.id, id)).get();
    if (!att) {
      res.status(404).json(NOT_FOUND);
      return;
    }

    // Access control: linked -> chat member; unlinked -> uploader only.
    if (att.messageId !== null) {
      if (!getChatForMember(db, att.chatId, me.id)) {
        res.status(404).json(NOT_FOUND);
        return;
      }
    } else if (att.uploaderId !== me.id) {
      res.status(404).json(NOT_FOUND);
      return;
    }

    const kind: AttachmentKind = att.kind;

    const wantThumb = req.query.thumb === '1';
    const wantDownload = req.query.download === '1';

    // Thumb only exists for images; fall back to the full file when absent.
    const serveThumb = wantThumb && att.thumbPath !== null;
    const fileName = serveThumb ? att.thumbPath! : att.storagePath;
    // Images and (the two safe) videos are served with their real mime so the
    // browser renders them inline; anything else is an opaque download.
    const contentType = serveThumb
      ? 'image/webp'
      : kind === 'image' || kind === 'video'
        ? att.mimeType
        : 'application/octet-stream';

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (wantDownload) {
      const encoded = encodeURIComponent(att.originalName);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    } else if (kind === 'file' && !serveThumb) {
      // Never render an unknown/uploaded file inline.
      res.setHeader('Content-Disposition', 'attachment');
    }

    let fileSize: number;
    try {
      fileSize = storage.size(fileName);
    } catch {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.removeHeader('Accept-Ranges');
      res.status(404).json(NOT_FOUND);
      return;
    }

    // Range support (required for video seeking — iOS Safari won't play video
    // at all without it). A malformed or out-of-bounds Range -> 416; a valid
    // one -> 206 with a genuinely partial fs stream (never buffered in memory).
    const range = parseRange(req.headers.range, fileSize);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }

    let stream: ReturnType<typeof storage.createReadStream>;
    if (range === 'full') {
      res.setHeader('Content-Length', String(fileSize));
      stream = storage.createReadStream(fileName);
    } else {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      stream = storage.createReadStream(fileName, range);
    }

    stream.on('error', () => {
      if (!res.headersSent) {
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Disposition');
        res.status(404).json(NOT_FOUND);
      } else {
        res.destroy();
      }
    });
    // Tear the read stream down if the client goes away mid-transfer.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  return router;
}

/**
 * Boot-time GC: deletes attachment rows (and their files + thumbs) that were
 * uploaded but never linked to a message and are older than `maxAgeMs`. Handles
 * the "user picked a file, never sent" leak. Linked attachments are always kept.
 */
export function cleanupOrphanedAttachments(
  db: Db,
  storage: Storage,
  maxAgeMs = 24 * 60 * 60 * 1000,
): number {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const orphans = db
    .select()
    .from(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .all();
  for (const o of orphans) {
    storage.remove(o.storagePath);
    if (o.thumbPath) storage.remove(o.thumbPath);
    db.delete(attachments).where(eq(attachments.id, o.id)).run();
  }
  return orphans.length;
}
