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
