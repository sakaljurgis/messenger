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
  createReadStream(name: string): fs.ReadStream;
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
    createReadStream: (name) => fs.createReadStream(resolve(name)),
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
