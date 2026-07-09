/* Messenger service worker (plain JS, served from the root scope).
 *
 * Responsibilities:
 *   - offline app shell: network-first caching of the navigation document ("/"),
 *     so a reopen while offline still boots the SPA,
 *   - web push: render notifications from the server payload,
 *   - notification clicks: focus/open the app at the right conversation.
 *
 * Only navigation requests are intercepted; everything else (JS/CSS/API/socket)
 * passes straight through to the network.
 */

const CACHE = 'messenger-shell-v1';

self.addEventListener('install', () => {
  // Activate this version immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
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
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'chat-' + data.chatId,
      data,
    }),
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
        // Reuse an already-open tab: focus it and route it to the conversation.
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(url);
          } catch {
            client.postMessage({ type: 'navigate', url });
          }
        } else {
          client.postMessage({ type: 'navigate', url });
        }
        return;
      }
      // No open tab: launch a fresh one.
      if (self.clients.openWindow) {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
