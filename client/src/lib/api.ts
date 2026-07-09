// Typed fetch wrapper for the /api backend.
//
// Requests are same-origin (Vite proxies /api to the server in dev; the
// production build is served by the same Express process), so the `sid`
// session cookie is sent automatically without any extra fetch options.

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function extractErrorMessage(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'error' in data) {
    const message = (data as Record<string, unknown>).error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return undefined;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });

  if (res.status === 204) {
    if (!res.ok) {
      throw new ApiError(res.status, res.statusText || 'Request failed');
    }
    return undefined as T;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    const message = extractErrorMessage(data) ?? (res.statusText || `Request failed with status ${res.status}`);
    throw new ApiError(res.status, message);
  }

  return data as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return api<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
}
