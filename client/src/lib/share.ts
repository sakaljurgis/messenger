// Web Share Target payload bridge.
//
// On Android/Chromium, the OS share sheet can send a photo/file/link straight
// into the messenger. The manifest declares a `share_target` (action POST
// /share); the service worker (public/sw.js) catches that POST BEFORE any window
// exists, stashes the shared files + text/url/title into a dedicated Cache
// ('shared-payload'), and 303-redirects to /share. This module reads that stash
// back out on the SharePage and disposes of it once consumed.
//
// iOS Safari does NOT implement the Web Share Target API — `share_target` in the
// manifest is simply ignored there — so this whole flow is Android/Chromium-only.
// There is no workaround (Apple has never shipped it); on iOS the user shares by
// copy/paste instead. The SharePage still renders correctly if deep-linked, just
// with the "nothing shared" empty state.
//
// The cache key layout is a small contract with sw.js — keep the two in sync:
//   /shared-payload/manifest  -> JSON { title, text, url, files: [{ key, name, type }] }
//   /shared-payload/file/<i>  -> the i-th shared file's bytes (one Response each)

export const SHARED_PAYLOAD_CACHE = 'shared-payload';
export const MANIFEST_KEY = '/shared-payload/manifest';

/** One file handed over by the share sheet. */
export interface SharedFile {
  name: string;
  type: string;
  blob: Blob;
}

/** The complete payload the share sheet delivered. */
export interface SharedPayload {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
}

/**
 * How the SharePage reads and disposes of the stashed share payload. Kept as an
 * interface so tests can inject a fake (no real Cache API needed) and the page
 * stays agnostic about where the payload physically lives.
 */
export interface SharePayloadStore {
  /** The stashed payload, or null when nothing has been shared. */
  read(): Promise<SharedPayload | null>;
  /** Drop the stash so a shared item is consumed exactly once. */
  clear(): Promise<void>;
}

interface ManifestFileEntry {
  key: string;
  name: string;
  type: string;
}

interface ShareManifest {
  title?: string;
  text?: string;
  url?: string;
  files?: ManifestFileEntry[];
}

/** True when the Cache API is available (absent in jsdom and insecure contexts). */
function cachesAvailable(): boolean {
  return typeof caches !== 'undefined';
}

/**
 * The default store, backed by the 'shared-payload' Cache the service worker
 * writes. Returns null (rather than throwing) whenever the Cache API is missing
 * or nothing is stashed, so the page falls through to its empty state.
 */
export const defaultSharePayloadStore: SharePayloadStore = {
  async read() {
    if (!cachesAvailable()) return null;
    const cache = await caches.open(SHARED_PAYLOAD_CACHE);
    const manifestRes = await cache.match(MANIFEST_KEY);
    if (!manifestRes) return null;

    let manifest: ShareManifest;
    try {
      manifest = (await manifestRes.json()) as ShareManifest;
    } catch {
      return null;
    }

    const files: SharedFile[] = [];
    for (const entry of manifest.files ?? []) {
      const res = await cache.match(entry.key);
      if (!res) continue;
      files.push({ name: entry.name, type: entry.type, blob: await res.blob() });
    }

    return {
      title: manifest.title ?? '',
      text: manifest.text ?? '',
      url: manifest.url ?? '',
      files,
    };
  },

  async clear() {
    if (!cachesAvailable()) return;
    await caches.delete(SHARED_PAYLOAD_CACHE);
  },
};

/**
 * Merge the shared title/text/url into a single message-prefill string. A shared
 * link typically arrives as title=page-title + url=link (text empty); a shared
 * text selection arrives as text (url empty). We lead with the text (or the title
 * when there's no text) and append the url unless it's already contained in that
 * lead, avoiding the common "url twice" duplication.
 */
export function buildPrefill({ title, text, url }: SharedPayload): string {
  const base = (text.trim() || title.trim()).trim();
  const parts: string[] = [];
  if (base) parts.push(base);
  if (url && !base.includes(url)) parts.push(url);
  return parts.join('\n');
}

/** Rehydrate a SharedFile into a real File for the upload pipeline. */
export function sharedFileToFile(file: SharedFile): File {
  return new File([file.blob], file.name || 'shared-file', {
    type: file.type || 'application/octet-stream',
  });
}
