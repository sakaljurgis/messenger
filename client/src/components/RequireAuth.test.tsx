import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RequireAuth from './RequireAuth';
import { AuthProvider } from '../lib/auth';

// Keep the real Socket.IO client out of jsdom (no live connection in tests).
vi.mock('../lib/socket', () => ({
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

function renderGuardedRoute() {
  render(
    <MemoryRouter initialEntries={['/chats']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/chats" element={<div>Protected content</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /login when the visitor is not authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'Not authenticated' })),
    );

    renderGuardedRoute();

    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders the protected content when the visitor is authenticated', async () => {
    const user = { id: 1, email: 'ann@example.com', displayName: 'Ann', isBot: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { user })),
    );

    renderGuardedRoute();

    expect(await screen.findByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });
});
