import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal blob storage abstraction over a directory on the volume. Kept
 * deliberately small (and an interface) so an S3-backed implementation could
 * drop in one file later without touching the routes: they only ever ask for a
 * path, a read stream, or a removal by stored filename.
 *
 * Stored "names" are opaque filenames (a UUID plus a sanitized extension), not
 * full paths — the store owns the directory layout.
 */
export interface Storage {
  /** Absolute path of the backing directory (multer's diskStorage writes here). */
  dir: string;
  /** Absolute path of a stored file by its name. */
  filePath(name: string): string;
  /**
   * A read stream for the whole file, or just the inclusive `[start, end]`
   * byte range when `range` is given — HTTP Range support for the serving
   * endpoint (video seeking; iOS Safari refuses to play video without it).
   */
  createReadStream(name: string, range?: { start: number; end: number }): fs.ReadStream;
  /** Byte size of a stored file; throws (like fs.statSync) when it's missing. */
  size(name: string): number;
  /** Delete a stored file; tolerant of a name that no longer exists on disk. */
  remove(name: string): void;
  /** Create the backing directory (idempotent); call once on boot. */
  ensureDir(): void;
}

export function createStorage(
  dir: string = process.env.UPLOADS_DIR ?? './data/uploads',
): Storage {
  const root = path.resolve(dir);
  // basename-only join defends against a stored name ever escaping the root.
  const resolve = (name: string) => path.join(root, path.basename(name));
  return {
    dir: root,
    filePath: resolve,
    createReadStream: (name, range) =>
      fs.createReadStream(resolve(name), range ? { start: range.start, end: range.end } : undefined),
    size: (name) => fs.statSync(resolve(name)).size,
    remove(name) {
      try {
        fs.rmSync(resolve(name), { force: true });
      } catch {
        // Best-effort deletion — a missing or already-removed file is fine.
      }
    },
    ensureDir() {
      fs.mkdirSync(root, { recursive: true });
    },
  };
}
