import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ChatMemberDTO, ChatSummaryDTO } from '@messenger/shared';
import GroupInfo from './GroupInfo';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const me: ChatMemberDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false, lastReadMessageId: 0 };
const bob: ChatMemberDTO = { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false, lastReadMessageId: 0 };

function makeChat(overrides: Partial<ChatSummaryDTO> = {}): ChatSummaryDTO {
  return {
    id: 100,
    type: 'group',
    name: 'Team',
    members: [me, bob],
    lastMessage: null,
    unreadCount: 0,
    muted: false,
    ...overrides,
  };
}

/** Stubs GET /api/users (the add-members directory) and PUT .../mute. `onMute`
 *  lets a test inspect/override the mute response (default 204). */
function stubFetch(onMute?: (body: { muted: boolean }) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/users')) return jsonResponse(200, { users: [] });
    if (url.endsWith('/mute') && method === 'PUT') {
      const body = JSON.parse(init?.body as string) as { muted: boolean };
      return onMute ? onMute(body) : jsonResponse(204, {});
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderGroupInfo(chat: ChatSummaryDTO, onClose: () => void = () => {}) {
  render(
    <MemoryRouter>
      <GroupInfo chat={chat} meId={me.id} onClose={onClose} />
    </MemoryRouter>,
  );
}

describe('GroupInfo — mute toggle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders off by default and calls PUT with { muted: true } on toggle', async () => {
    const fetchMock = stubFetch();
    renderGroupInfo(makeChat({ muted: false }));

    const toggle = screen.getByRole('switch', { name: 'Mute notifications' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(toggle);

    // Optimistic: flips immediately, before the request settles.
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u.toString().endsWith('/mute'));
      expect(call).toBeDefined();
      expect(call![1]?.method).toBe('PUT');
      expect(JSON.parse(call![1]!.body as string)).toEqual({ muted: true });
    });
  });

  it('renders on when chat.muted is true and calls PUT with { muted: false } on toggle', async () => {
    const fetchMock = stubFetch();
    renderGroupInfo(makeChat({ muted: true }));

    const toggle = screen.getByRole('switch', { name: 'Mute notifications' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u.toString().endsWith('/mute'));
      expect(JSON.parse(call![1]!.body as string)).toEqual({ muted: false });
    });
  });

  it('reverts and shows an error when the request fails', async () => {
    stubFetch(() => jsonResponse(400, { error: 'nope' }));
    renderGroupInfo(makeChat({ muted: false }));

    const toggle = screen.getByRole('switch', { name: 'Mute notifications' });
    await userEvent.click(toggle);

    // Optimistic flip, then reverted once the failure comes back.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('does not toggle again while a request is in flight', async () => {
    let resolve: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    stubFetch(() => pending as unknown as Response);
    renderGroupInfo(makeChat({ muted: false }));

    const toggle = screen.getByRole('switch', { name: 'Mute notifications' });
    await userEvent.click(toggle);
    expect(toggle).toBeDisabled();

    // A second click while busy is a no-op (still just optimistically true).
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    resolve!(jsonResponse(204, {}));
    await waitFor(() => expect(toggle).not.toBeDisabled());
  });
});
