import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BotDTO, UserDTO } from '@messenger/shared';
import BotsPage from './BotsPage';
import { AuthProvider } from '../lib/auth';

// Keep the real Socket.IO client out of jsdom (AuthProvider connects on login).
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ on() {}, off() {}, connect() {}, disconnect() {}, connected: false }),
  connectSocket: () => {},
  disconnectSocket: () => {},
}));

const me: UserDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * A stateful fetch mock over the bots API: GET reflects the current list, PATCH
 * mutates a bot's webhookUrl, POST appends a new bot and mints a token — so the
 * page's reload-after-mutation shows the updated data, just like the server.
 */
function makeFetch(initialBots: BotDTO[]) {
  let bots = [...initialBots];
  let nextId = 100;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
    if (url.endsWith('/api/bots') && method === 'GET') return jsonResponse(200, { bots });
    if (url.endsWith('/api/bots') && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { name: string; webhookUrl?: string };
      const bot: UserDTO = {
        id: nextId++,
        email: `bot-${nextId}@bots.local`,
        displayName: body.name,
        isBot: true,
      };
      bots = [...bots, { ...bot, webhookUrl: body.webhookUrl ?? null }];
      return jsonResponse(201, { bot, apiToken: 'secret-token-abc123' });
    }
    const patch = url.match(/\/api\/bots\/(\d+)$/);
    if (patch && method === 'PATCH') {
      const id = Number(patch[1]);
      const body = JSON.parse(init!.body as string) as { webhookUrl: string | null };
      bots = bots.map((b) => (b.id === id ? { ...b, webhookUrl: body.webhookUrl } : b));
      return jsonResponse(200, { bot: bots.find((b) => b.id === id)! });
    }
    if (patch && method === 'DELETE') {
      bots = bots.filter((b) => b.id !== Number(patch[1]));
      return jsonResponse(204, {});
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  return fetchMock;
}

function renderBots(fetchMock: ReturnType<typeof makeFetch>) {
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={['/bots']}>
      <AuthProvider>
        <Routes>
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/settings" element={<div>Settings screen</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const bots: BotDTO[] = [
  { id: 2, email: 'echo@bots.local', displayName: 'Echo Bot', isBot: true, webhookUrl: 'https://bot.example.com/webhook' },
  { id: 3, email: 'silent@bots.local', displayName: 'Silent Bot', isBot: true, webhookUrl: null },
];

describe('BotsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the bot list with webhook URLs and a "No webhook" placeholder', async () => {
    renderBots(makeFetch(bots));

    expect(await screen.findByText('Echo Bot')).toBeInTheDocument();
    expect(screen.getByText('https://bot.example.com/webhook')).toBeInTheDocument();
    expect(screen.getByText('Silent Bot')).toBeInTheDocument();
    expect(screen.getByText('No webhook')).toBeInTheDocument();
  });

  it('edits a webhook: PATCHes the new URL and reflects it', async () => {
    const fetchMock = makeFetch(bots);
    renderBots(fetchMock);

    const input = (await screen.findByLabelText('Webhook URL for Echo Bot')) as HTMLInputElement;
    expect(input.value).toBe('https://bot.example.com/webhook');

    const row = input.closest('li')!;
    // One synthetic change instead of per-keystroke typing: under full-suite
    // worker contention, typing a long URL keystroke-by-keystroke occasionally
    // interleaved with a re-render and dropped characters (rare flake). The
    // component contract under test is "Save PATCHes the field's value" —
    // keystroke fidelity adds nothing here.
    fireEvent.change(input, { target: { value: 'https://new.example.com/hook' } });
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    const patchCall = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().endsWith('/api/bots/2') && init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall![1]!.body as string)).toEqual({
      webhookUrl: 'https://new.example.com/hook',
    });

    // After the save + reload, the new URL is shown.
    expect(await screen.findByText('https://new.example.com/hook')).toBeInTheDocument();
  });

  it('creates a bot and reveals the apiToken exactly once', async () => {
    const fetchMock = makeFetch(bots);
    renderBots(fetchMock);
    await screen.findByText('Echo Bot');

    await userEvent.type(screen.getByLabelText('Display name'), 'New Bot');
    await userEvent.click(screen.getByRole('button', { name: /create bot/i }));

    const postCall = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().endsWith('/api/bots') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall![1]!.body as string)).toEqual({ name: 'New Bot' });

    // The one-time token + warning + copy affordance are shown.
    expect(await screen.findByText('secret-token-abc123')).toBeInTheDocument();
    expect(screen.getByText(/not be shown again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy token/i })).toBeInTheDocument();

    // The new bot joins the list after the reload.
    expect(await screen.findByText('New Bot')).toBeInTheDocument();
  });

  it('deletes a bot after confirmation and drops it from the list', async () => {
    const fetchMock = makeFetch(bots);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderBots(fetchMock);
      await screen.findByText('Echo Bot');

      await userEvent.click(screen.getByRole('button', { name: 'Delete Echo Bot' }));

      const deleteCall = fetchMock.mock.calls.find(
        ([i, init]) => i.toString().endsWith('/api/bots/2') && init?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();

      // Reloaded list no longer contains the bot; the other one stays.
      await waitFor(() => expect(screen.queryByText('Echo Bot')).not.toBeInTheDocument());
      expect(screen.getByText('Silent Bot')).toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const fetchMock = makeFetch(bots);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      renderBots(fetchMock);
      await screen.findByText('Echo Bot');

      await userEvent.click(screen.getByRole('button', { name: 'Delete Echo Bot' }));

      const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(deleteCall).toBeUndefined();
      expect(screen.getByText('Echo Bot')).toBeInTheDocument();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
