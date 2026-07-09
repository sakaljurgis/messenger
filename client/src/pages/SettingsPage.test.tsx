import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
