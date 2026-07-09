import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UsersPage from './UsersPage';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const users = [
  { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false },
  { id: 3, email: 'echo@example.com', displayName: 'Echo Bot', isBot: true },
];

function renderUsersPage() {
  render(
    <MemoryRouter initialEntries={['/users']}>
      <Routes>
        <Route path="/users" element={<UsersPage />} />
        <Route path="/chats/:id" element={<div>Conversation open</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UsersPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the directory with a Bot badge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString().endsWith('/api/users')) return jsonResponse(200, { users });
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );

    renderUsersPage();

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Echo Bot')).toBeInTheDocument();
    expect(screen.getByText('Bot')).toBeInTheDocument();
  });

  it('shows the empty state when there are no other users', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { users: [] })),
    );

    renderUsersPage();

    expect(await screen.findByText(/no other users yet/i)).toBeInTheDocument();
  });

  it('POSTs { userId } and navigates to the created chat when a row is tapped', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
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
});
