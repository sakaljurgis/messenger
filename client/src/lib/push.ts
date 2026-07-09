// Web push subscription helpers, sitting on top of the browser Push API and the
// server's /api/push routes. Everything here assumes the service worker (pwa.ts)
// is (or will become) active; `navigator.serviceWorker.ready` gates on that.

import { api, apiGet, apiPost } from './api';

/** Coarse state of push notifications for the current user/browser. */
export type PushState = 'unsupported' | 'denied' | 'enabled' | 'disabled';

/** Whether this browser has the APIs web push needs at all. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Decode a URL-safe base64 VAPID key into the Uint8Array the Push API wants as
 * `applicationServerKey`. Exported for unit testing. Standard algorithm.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Current push state: 'enabled' only when permission is granted AND a live
 * subscription exists on the service worker registration.
 */
export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'disabled';

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'enabled' : 'disabled';
}

/**
 * Request permission (if needed), subscribe via the Push API using the server's
 * VAPID key, and register the subscription with the backend. Returns the new
 * state. Throws with a clear message when the server has push disabled.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) {
    throw new Error('Push notifications are not supported in this browser');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    // 'denied' or dismissed ('default') — reflect whatever we ended up with.
    return getPushState();
  }

  const { key } = await apiGet<{ key: string | null }>('/api/push/vapid-key');
  if (!key) {
    throw new Error('Push notifications are not configured on the server');
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });

  const json = subscription.toJSON();
  await apiPost('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
  return 'enabled';
}

/** Unsubscribe locally and tell the backend to forget this endpoint. */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const { endpoint } = subscription;
    await subscription.unsubscribe();
    await api('/api/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }).catch(() => {
      // The local unsubscribe already happened; a failed server delete is
      // non-fatal (a dead endpoint gets pruned on the next send anyway).
    });
  }
  return getPushState();
}
