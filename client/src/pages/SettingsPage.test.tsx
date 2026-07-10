import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { UserDTO } from '@messenger/shared';
import SettingsPage from './SettingsPage';
import { AuthProvider } from '../lib/auth';

// Keep the real Socket.IO client out of jsdom.
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ on() {}, off() {}, connect() {}, disconnect() {}, connected: false }),
  connectSocket: () => {},
  disconnectSocket: () => {},
}));

// Controllable push lib so we don't touch real browser push APIs.
const push = vi.hoisted(() => ({
  getPushState: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  pushSupported: vi.fn(() => true),
}));
vi.mock('../lib/push', () => push);

const me: UserDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderSettings() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      throw new Error(`Unexpected fetch: ${input.toString()}`);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <AuthProvider>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage — notifications', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the enable flow and turns notifications on', async () => {
    push.getPushState.mockResolvedValue('disabled');
    push.enablePush.mockResolvedValue('enabled');
    renderSettings();

    const enableButton = await screen.findByRole('button', { name: /enable notifications/i });
    await userEvent.click(enableButton);

    expect(push.enablePush).toHaveBeenCalledTimes(1);
    // After enabling, the button flips to a disable action.
    expect(await screen.findByRole('button', { name: /disable notifications/i })).toBeInTheDocument();
    expect(screen.getByText(/notifications are on/i)).toBeInTheDocument();
  });

  it('explains when notifications are blocked and offers no toggle', async () => {
    push.getPushState.mockResolvedValue('denied');
    renderSettings();

    expect(await screen.findByText(/blocked in your browser settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /notifications/i })).not.toBeInTheDocument();
  });
});

describe('SettingsPage — profile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function renderWithFetch(fetchMock: typeof fetch) {
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <AuthProvider>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
  }

  it('saves an edited display name via PATCH /api/users/me', async () => {
    push.getPushState.mockResolvedValue('disabled');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      if (url.endsWith('/api/users/me') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as { displayName: string };
        return jsonResponse(200, { user: { ...me, displayName: body.displayName } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    renderWithFetch(fetchMock as unknown as typeof fetch);

    const input = await screen.findByLabelText('Display name');
    await waitFor(() => expect(input).toHaveValue('Me'));

    await userEvent.clear(input);
    await userEvent.type(input, 'New Me');
    await userEvent.click(screen.getByRole('button', { name: /save name/i }));

    expect(await screen.findByText('Name updated')).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().endsWith('/api/users/me') && init?.method === 'PATCH',
    );
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ displayName: 'New Me' });
  });

  it('changes the password via PUT and surfaces a wrong current password', async () => {
    push.getPushState.mockResolvedValue('disabled');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      if (url.endsWith('/api/users/me/password') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { currentPassword: string };
        return body.currentPassword === 'correct-horse'
          ? jsonResponse(204, {})
          : jsonResponse(400, { error: 'Current password is incorrect' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    renderWithFetch(fetchMock as unknown as typeof fetch);

    const current = await screen.findByLabelText('Current password');
    const next = screen.getByLabelText('New password');

    // Wrong current password → server error surfaces inline.
    await userEvent.type(current, 'wrong-password');
    await userEvent.type(next, 'battery-staple');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();

    // Correct current password → success message, fields cleared.
    await userEvent.clear(current);
    await userEvent.clear(next);
    await userEvent.type(current, 'correct-horse');
    await userEvent.type(next, 'battery-staple');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(await screen.findByText('Password changed')).toBeInTheDocument();
    expect(current).toHaveValue('');
    expect(next).toHaveValue('');
  });

  it('links to the bots management page', async () => {
    push.getPushState.mockResolvedValue('disabled');
    renderSettings();

    const link = await screen.findByRole('link', { name: /manage bots/i });
    expect(link).toHaveAttribute('href', '/bots');
  });
});

describe('SettingsPage — theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to System and switches theme, applying the html class and persisting', async () => {
    push.getPushState.mockResolvedValue('disabled');
    renderSettings();

    const system = await screen.findByRole('radio', { name: 'System' });
    const light = screen.getByRole('radio', { name: 'Light' });
    const dark = screen.getByRole('radio', { name: 'Dark' });

    // Nothing stored → System is the selected option, no dark class.
    expect(system).toHaveAttribute('aria-checked', 'true');
    expect(dark).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Dark applies immediately and persists.
    await userEvent.click(dark);
    expect(dark).toHaveAttribute('aria-checked', 'true');
    expect(system).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');

    // Light removes the class and updates the stored choice.
    await userEvent.click(light);
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('preselects the stored theme on load', async () => {
    push.getPushState.mockResolvedValue('disabled');
    localStorage.setItem('theme', 'dark');
    renderSettings();

    const dark = await screen.findByRole('radio', { name: 'Dark' });
    expect(dark).toHaveAttribute('aria-checked', 'true');
  });
});
