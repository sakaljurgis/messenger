import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LoginPage from './LoginPage';
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

function renderLoginPage() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/chats" element={<div>Chats page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the login form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: 'Not authenticated' })),
    );

    renderLoginPage();

    expect(await screen.findByPlaceholderText(/email/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('submits credentials to /api/auth/login and navigates to /chats on success', async () => {
    const user = { id: 1, email: 'ann@example.com', displayName: 'Ann', isBot: false };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(401, { error: 'Not authenticated' });
      }
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse(200, { user });
      }
      throw new Error(`Unexpected fetch call: ${url} ${init?.method ?? ''}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLoginPage();

    await screen.findByPlaceholderText(/email/i);
    await userEvent.type(screen.getByPlaceholderText(/email/i), 'ann@example.com');
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'hunter2pass');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText('Chats page')).toBeInTheDocument();

    const loginCall = fetchMock.mock.calls.find(([input]) => input.toString().endsWith('/api/auth/login'));
    expect(loginCall).toBeDefined();
    const init = loginCall?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'ann@example.com',
      password: 'hunter2pass',
    });
  });

  it('shows the server error message on invalid credentials', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse(401, { error: 'Not authenticated' });
      }
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse(401, { error: 'Invalid email or password' });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderLoginPage();

    await screen.findByPlaceholderText(/email/i);
    await userEvent.type(screen.getByPlaceholderText(/email/i), 'ann@example.com');
    await userEvent.type(screen.getByPlaceholderText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });
});
