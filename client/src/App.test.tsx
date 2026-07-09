import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

// Keep the real Socket.IO client out of jsdom (no live connection in tests).
vi.mock('./lib/socket', () => ({
  getSocket: () => ({ on() {}, off() {}, connect() {}, disconnect() {}, connected: false }),
  connectSocket: () => {},
  disconnectSocket: () => {},
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('app scaffold', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an unauthenticated visitor at / to the login page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'Not authenticated' })),
    );

    window.history.pushState({}, '', '/');
    render(<App />);

    expect(await screen.findByText(/messenger/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /log in/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });
});
