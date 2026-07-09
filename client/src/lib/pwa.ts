// Service worker registration.
//
// Registers /sw.js (copied verbatim from public/ by Vite, in dev and prod) so the
// app has an offline shell and can receive web push. Registration is best-effort:
// failures (unsupported browser, insecure context) are swallowed — the app works
// without a service worker, just without offline support / notifications.

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal — ignore silently.
    });
  });
}

/**
 * Subscribe to `{ type: 'navigate', url }` messages from the service worker
 * (sent on notification click) so an already-open tab can route in-app instead
 * of doing a full page reload. Returns an unsubscribe function.
 */
export function listenForSwNavigation(onNavigate: (url: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }

  const handler = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      data !== null &&
      typeof data === 'object' &&
      (data as { type?: unknown }).type === 'navigate' &&
      typeof (data as { url?: unknown }).url === 'string'
    ) {
      onNavigate((data as { url: string }).url);
    }
  };

  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
