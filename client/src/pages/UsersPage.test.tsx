import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UsersPage from './UsersPage';
import { AuthProvider } from '../lib/auth';
import { __resetPresenceForTests, initPresence } from '../lib/presence';

// Controllable socket so presence events can be driven synchronously.
const socket = vi.hoisted(() => {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const s = {
    connected: false,
    on(event: string, fn: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(fn);
      return s;
    },
    off(event: string, fn: (...a: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      return s;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners[event] ?? [])]) fn(...args);
      return true;
    },
    connect() {
      s.connected = true;
      return s;
    },
    disconnect() {
      s.connected = false;
      return s;
    },
    clear() {
      for (const key of Object.keys(listeners)) delete listeners[key];
    },
  };
  return s;
});

vi.mock('../lib/socket', () => ({
  getSocket: () => socket,
  connectSocket: () => socket.connect(),
  disconnectSocket: () => socket.disconnect(),
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const me = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };
const users = [
  { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false, color: '#f44336' },
  { id: 3, email: 'echo@example.com', displayName: 'Echo Bot', isBot: true },
];

function renderUsersPage() {
  render(
    <MemoryRouter initialEntries={['/users']}>
      <AuthProvider>
        <Routes>
          <Route path="/users" element={<UsersPage />} />
          <Route path="/chats/:id" element={<div>Conversation open</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('UsersPage', () => {
  beforeEach(() => {
    socket.clear();
    __resetPresenceForTests();
    initPresence();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetPresenceForTests();
  });

  it('renders the directory with a Bot badge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
        if (input.toString().endsWith('/api/users')) return jsonResponse(200, { users });
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    renderUsersPage();

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Echo Bot')).toBeInTheDocument();
    expect(screen.getByText('Bot')).toBeInTheDocument();
    // My own entry is pinned above the directory.
    expect(await screen.findByText('Notes to self')).toBeInTheDocument();
  });

  it("passes each user's color through to their Avatar", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
        if (input.toString().endsWith('/api/users')) return jsonResponse(200, { users });
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    renderUsersPage();

    const bobRow = (await screen.findByText('Bob')).closest('button')!;
    const bobAvatar = bobRow.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(bobAvatar.style.backgroundColor).toBe('rgb(244, 67, 54)');

    // Echo Bot has no color set — falls back to the id-derived color, not Bob's.
    const echoRow = screen.getByText('Echo Bot').closest('button')!;
    const echoAvatar = echoRow.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(echoAvatar.style.backgroundColor).not.toBe('rgb(244, 67, 54)');
    expect(echoAvatar.style.backgroundColor).not.toBe('');
  });

  it('shows an online dot only for online users (bots never connect)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
        if (input.toString().endsWith('/api/users')) return jsonResponse(200, { users });
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    renderUsersPage();
    await screen.findByText('Bob');

    // Bob (id 2) is online; the Echo Bot (id 3) is not → exactly one dot.
    act(() => {
      socket.emit('presence:state', [2]);
    });
    expect(screen.getAllByTestId('presence-dot')).toHaveLength(1);
  });

  it('shows the empty state (plus my own notes row) when there are no other users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
        return jsonResponse(200, { users: [] });
      }),
    );

    renderUsersPage();

    expect(await screen.findByText(/no other users yet/i)).toBeInTheDocument();
    expect(await screen.findByText('Notes to self')).toBeInTheDocument();
  });

  it('POSTs { userId } and navigates to the created chat when a row is tapped', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      if (url.endsWith('/api/users')) return jsonResponse(200, { users });
      if (url.endsWith('/api/chats') && init?.method === 'POST') {
        return jsonResponse(201, { chat: { id: 42, type: 'dm', name: null, members: [], lastMessage: null, unreadCount: 0 } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsersPage();

    await userEvent.click(await screen.findByText('Bob'));

    expect(await screen.findByText('Conversation open')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => input.toString().endsWith('/api/chats') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({ userId: 2 });
  });

  it('opens a self-DM from the notes-to-self row', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      if (url.endsWith('/api/users')) return jsonResponse(200, { users });
      if (url.endsWith('/api/chats') && init?.method === 'POST') {
        return jsonResponse(201, { chat: { id: 7, type: 'dm', name: null, members: [], lastMessage: null, unreadCount: 0 } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderUsersPage();

    await userEvent.click(await screen.findByText('Notes to self'));

    expect(await screen.findByText('Conversation open')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => input.toString().endsWith('/api/chats') && init?.method === 'POST',
    );
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({ userId: 1 });
  });
});
