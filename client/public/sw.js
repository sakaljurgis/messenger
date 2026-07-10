/* Messenger service worker (plain JS, served from the root scope).
 *
 * Responsibilities:
 *   - offline app shell: network-first caching of the navigation document ("/"),
 *     so a reopen while offline still boots the SPA,
 *   - web push: render notifications from the server payload,
 *   - notification clicks: focus/open the app at the right conversation,
 *   - Web Share Target: catch the OS share sheet's POST to /share, stash the
 *     shared payload, and redirect to the /share page (Android/Chromium only —
 *     iOS Safari doesn't implement share_target, so that branch never runs there).
 *
 * Only navigation requests and the share POST are intercepted; everything else
 * (JS/CSS/API/socket) passes straight through to the network.
 *
 * Cache-busting: bump CACHE when this file changes so installed clients drop the
 * old shell on activate and pick up the new worker.
 */

const CACHE = 'messenger-shell-v2';

// Where the share-target payload is stashed for the /share page to read. Kept in
// sync with the key layout in src/lib/share.ts.
const SHARED_PAYLOAD_CACHE = 'shared-payload';

self.addEventListener('install', () => {
  // Activate this version immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions, but keep the current shell and any
      // pending share payload (a share stashed just before an update must survive).
      const keep = new Set([CACHE, SHARED_PAYLOAD_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Web Share Target handler. The share sheet POSTs the shared title/text/url and
 * any files (multipart/form-data) to /share. We must read the body HERE, in the
 * worker, because the target page may not be open yet — so we stash everything
 * into the SHARED_PAYLOAD_CACHE (each file as its own Response plus a JSON
 * manifest) and 303-redirect to /share, where SharePage reads it back out via
 * src/lib/share.ts. Any failure still redirects; the page then shows its empty
 * state rather than hanging.
 */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    // Start clean so a new share never mixes with a previous, unconsumed one.
    await caches.delete(SHARED_PAYLOAD_CACHE);
    const cache = await caches.open(SHARED_PAYLOAD_CACHE);

    const shared = formData.getAll('files');
    const manifestFiles = [];
    for (let i = 0; i < shared.length; i++) {
      const file = shared[i];
      // Non-file entries (or empty picks) can appear; skip anything not a Blob.
      if (!file || typeof file.arrayBuffer !== 'function') continue;
      const key = '/shared-payload/file/' + i;
      const type = file.type || 'application/octet-stream';
      await cache.put(key, new Response(file, { headers: { 'Content-Type': type } }));
      manifestFiles.push({ key, name: file.name || 'shared-file', type });
    }

    const manifest = {
      title: formData.get('title') || '',
      text: formData.get('text') || '',
      url: formData.get('url') || '',
      files: manifestFiles,
    };
    await cache.put(
      '/shared-payload/manifest',
      new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }),
    );
  } catch {
    // Swallow — we still redirect below and the page handles "nothing shared".
  }

  // 303 forces the follow-up to be a GET of /share (the SPA route).
  return Response.redirect(new URL('/share', self.location.origin).toString(), 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Web Share Target: intercept the share sheet's POST /share BEFORE the
  // navigate branch (a share POST is a navigation, but must be handled here, not
  // network-fetched). No-op on browsers without share_target (the POST never
  // arrives), so this is safe cross-platform.
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Only the app-shell navigation is our concern; let all other requests be.
  if (request.mode !== 'navigate') return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        // Refresh the cached shell on every successful navigation.
        const cache = await caches.open(CACHE);
        cache.put('/', response.clone());
        return response;
      } catch {
        // Offline: serve the last good shell if we have one.
        const cached = await caches.match('/');
        return cached ?? Response.error();
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Messenger';
  const data = payload.data || {};

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: payload.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'chat-' + data.chatId,
        data,
      });
      // Flag the app icon so it shows *something* is unread even if the app
      // isn't open to compute a total. No exact count available in a push
      // handler; the app self-corrects it (see badge.ts) on next open/refetch.
      // Guarded by feature detection, and a rejection here must never surface
      // (it would otherwise become an unhandled promise rejection in the SW).
      if ('setAppBadge' in self.navigator) {
        await self.navigator.setAppBadge().catch(() => {});
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const chatId = event.notification.data && event.notification.data.chatId;
  const url = chatId != null ? '/chats/' + chatId : '/chats';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        // Reuse an already-open tab: focus it and let the SPA route in-app
        // (App listens for this message) — client.navigate() would full-reload.
        await client.focus();
        client.postMessage({ type: 'navigate', url });
        return;
      }
      // No open tab: launch a fresh one.
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
