import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enablePush, urlBase64ToUint8Array } from './push';

describe('urlBase64ToUint8Array', () => {
  it('decodes a URL-safe base64 string to the right bytes', () => {
    // "hello" → base64 "aGVsbG8=" → URL-safe (no change here) → bytes.
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles URL-safe chars (- and _) and missing padding', () => {
    // Bytes [251, 255] → base64 "+/8=" → URL-safe "-_8".
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });
});

describe('enablePush', () => {
  // A realistic 65-byte P-256 VAPID public key (URL-safe base64).
  const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFa1eOEHNTIl2ah1p9pRC7hLYCa3D-1TVwT6HZoQ1n8AhqYUj5R-w';

  const subscribeMock = vi.fn();
  const registration = {
    pushManager: {
      subscribe: subscribeMock,
      getSubscription: vi.fn().mockResolvedValue(null),
    },
  };
  const requestPermission = vi.fn().mockResolvedValue('granted');

  function jsonResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }

  beforeEach(() => {
    subscribeMock.mockResolvedValue({
      endpoint: 'https://push.example.com/abc',
      toJSON: () => ({
        endpoint: 'https://push.example.com/abc',
        keys: { p256dh: 'PUB_KEY', auth: 'AUTH_KEY' },
      }),
    });

    vi.stubGlobal('PushManager', class {});
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(registration) },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.endsWith('/api/push/vapid-key')) return jsonResponse(200, { key: VAPID_KEY });
        if (url.endsWith('/api/push/subscribe')) return jsonResponse(201, { ok: true });
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    vi.clearAllMocks();
  });

  it('subscribes with the decoded VAPID key and posts the subscription', async () => {
    const state = await enablePush();

    expect(requestPermission).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const postCall = fetchMock.mock.calls.find(([input]) =>
      input.toString().endsWith('/api/push/subscribe'),
    );
    expect(postCall).toBeDefined();
    expect(postCall![1].method).toBe('POST');
    expect(JSON.parse(postCall![1].body as string)).toEqual({
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'PUB_KEY', auth: 'AUTH_KEY' },
    });

    expect(state).toBe('enabled');
  });

  it('throws a clear error when the server has no VAPID key', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/api/push/vapid-key')) return jsonResponse(200, { key: null });
      throw new Error('should not reach subscribe');
    });

    await expect(enablePush()).rejects.toThrow(/not configured/i);
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});
