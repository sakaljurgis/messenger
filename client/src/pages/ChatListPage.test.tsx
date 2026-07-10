import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentDTO, ChatMemberDTO, ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import ChatListPage from './ChatListPage';
import { AuthProvider } from '../lib/auth';

// Controllable stand-in for the Socket.IO client (drive server events; no real
// connection in jsdom).
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
    listenerCount(event: string) {
      return (listeners[event] ?? []).length;
    },
    connect() {
      s.connected = true;
      s.emit('connect');
      return s;
    },
    disconnect() {
      s.connected = false;
      return s;
    },
  };
  return s;
});

vi.mock('../lib/socket', () => ({
  getSocket: () => socket,
  connectSocket: () => socket.connect(),
  disconnectSocket: () => socket.disconnect(),
}));

/**
 * Emit a server→client event only after the page has actually subscribed —
 * an event fired before the effect registers its listener is silently lost
 * (the real app recovers via refetch-on-connect; a test cannot).
 */
async function emitFromServer(event: string, ...args: unknown[]) {
  await waitFor(() => expect(socket.listenerCount(event)).toBeGreaterThan(0));
  act(() => {
    socket.emit(event, ...args);
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const me: ChatMemberDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false, lastReadMessageId: 0 };
const bob: ChatMemberDTO = { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false, lastReadMessageId: 0 };
const carol: ChatMemberDTO = { id: 3, email: 'carol@example.com', displayName: 'Carol', isBot: false, lastReadMessageId: 0 };

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return { id, chatId: 1, sender, content, mentions: [], attachments: [], reactions: [], replyTo: null, createdAt: new Date().toISOString(), editedAt: null, isDeleted: false };
}

const chats: ChatSummaryDTO[] = [
  { id: 10, type: 'dm', name: null, members: [me, bob], lastMessage: msg(5, bob, 'Hey there'), unreadCount: 2 },
  { id: 11, type: 'group', name: 'Team', members: [me, bob, carol], lastMessage: msg(6, me, 'Hello all'), unreadCount: 0 },
];

/** Config for the mocked GET /api/search endpoint. `before=` requests return
 *  `morePage` (the older page); the first request returns `messages`. */
interface SearchStub {
  messages: MessageDTO[];
  nextCursor?: number | null;
  morePage?: MessageDTO[];
}

function stubFetch(chatList: ChatSummaryDTO[], search?: SearchStub) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
    if (url.endsWith('/api/chats')) return jsonResponse(200, { chats: chatList });
    if (url.includes('/api/search')) {
      if (url.includes('before=')) {
        return jsonResponse(200, { messages: search?.morePage ?? [], nextCursor: null });
      }
      return jsonResponse(200, {
        messages: search?.messages ?? [],
        nextCursor: search?.nextCursor ?? null,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderChatList() {
  render(
    <MemoryRouter initialEntries={['/chats']}>
      <AuthProvider>
        <Routes>
          <Route path="/chats" element={<ChatListPage />} />
          <Route path="/chats/:id" element={<div>Conversation open</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ChatListPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders chats with title, preview, and unread badge', async () => {
    stubFetch(chats);
    renderChatList();

    // DM title is the other member's name; group uses its name.
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();

    // Previews, with a "You:" prefix for my own last message.
    expect(screen.getByText('Hey there')).toBeInTheDocument();
    expect(screen.getByText('You: Hello all')).toBeInTheDocument();

    // Unread badge.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it("notes-to-self row uses MY accent color (I'm the DM's only member)", async () => {
    const coloredMe: ChatMemberDTO = { ...me, color: '#12ab34' };
    const notes: ChatSummaryDTO = {
      id: 12, type: 'dm', name: null, members: [coloredMe], lastMessage: null, unreadCount: 0,
    };
    stubFetch([notes]);
    renderChatList();

    const row = (await screen.findByText('Notes to self')).closest('a') as HTMLElement;
    const avatar = row.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(avatar).toHaveStyle({ backgroundColor: '#12ab34' });
  });

  it("group row avatar is a pie of the members' accent colors in stable id order", async () => {
    const coloredBob: ChatMemberDTO = { ...bob, color: '#0000ff' };
    const group: ChatSummaryDTO = {
      // Members deliberately out of id order — the pie sorts by id.
      id: 11, type: 'group', name: 'Team', members: [coloredBob, { ...me, color: '#ff0000' }],
      lastMessage: null, unreadCount: 0,
    };
    stubFetch([group]);
    renderChatList();

    const row = (await screen.findByText('Team')).closest('a') as HTMLElement;
    const avatar = row.querySelector('[aria-hidden="true"]') as HTMLElement;
    // jsdom serializes the hex stops back as rgb(); me (id 1) sorts before Bob (id 2).
    expect(avatar.style.backgroundImage).toBe(
      'conic-gradient(rgb(255, 0, 0) 0deg 180deg, rgb(0, 0, 255) 180deg 360deg)',
    );
  });

  it('marks group rows with a member-count badge; DM rows have none', async () => {
    stubFetch(chats);
    renderChatList();
    await screen.findByText('Team');

    const badges = screen.getAllByTestId('group-badge');
    expect(badges).toHaveLength(1); // only the group row
    expect(badges[0]).toHaveTextContent('3');
    // Hovering the badge lists everyone in the group.
    expect(badges[0]).toHaveAttribute('title', 'Me, Bob, Carol');
  });

  it('shows a Muted indicator and grays out the unread badge on a muted chat', async () => {
    const mutedDm: ChatSummaryDTO = {
      id: 10, type: 'dm', name: null, members: [me, bob], lastMessage: msg(5, bob, 'Hey there'),
      unreadCount: 2, muted: true,
    };
    stubFetch([mutedDm, chats[1]!]);
    renderChatList();
    await screen.findByText('Bob');

    // The muted row shows the indicator and a gray (not blue) unread badge.
    const bobRow = screen.getByText('Bob').closest('a') as HTMLElement;
    expect(within(bobRow).getByLabelText('Muted')).toBeInTheDocument();
    const badge = within(bobRow).getByText('2');
    expect(badge.className).toMatch(/bg-gray-400/);
    expect(badge.className).not.toMatch(/bg-\[#0084ff\]/);

    // The unmuted group row has neither.
    const teamRow = screen.getByText('Team').closest('a') as HTMLElement;
    expect(within(teamRow).queryByLabelText('Muted')).not.toBeInTheDocument();
  });

  it('previews a message-less group with its member names', async () => {
    stubFetch([
      { id: 12, type: 'group', name: 'Quiet Group', members: [me, bob, carol], lastMessage: null, unreadCount: 0 },
    ]);
    renderChatList();

    expect(await screen.findByText('Quiet Group')).toBeInTheDocument();
    // Members (excluding me) instead of "No messages yet".
    expect(screen.getByText('Bob, Carol')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });

  it('drops a chat from the list when chat:removed arrives', async () => {
    stubFetch(chats);
    renderChatList();
    await screen.findByText('Team');

    await emitFromServer('chat:removed', { chatId: 11 });

    expect(screen.queryByText('Team')).not.toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument(); // the DM stays
  });

  it('shows the empty state with a CTA to People when there are no chats', async () => {
    stubFetch([]);
    renderChatList();

    expect(await screen.findByText(/find people to message/i)).toBeInTheDocument();
  });

  it('navigates to the conversation when a chat row is tapped', async () => {
    stubFetch(chats);
    renderChatList();

    await userEvent.click(await screen.findByText('Bob'));
    expect(await screen.findByText('Conversation open')).toBeInTheDocument();
  });

  it('inserts a new chat live when a chat:new event arrives', async () => {
    stubFetch(chats);
    renderChatList();

    // Initial (fetched) list is on screen.
    await screen.findByText('Bob');
    expect(screen.queryByText('Fresh Group')).not.toBeInTheDocument();

    // The server pushes a brand-new group — the row appears without any refetch.
    const newGroup: ChatSummaryDTO = {
      id: 20,
      type: 'group',
      name: 'Fresh Group',
      members: [me, bob, carol],
      lastMessage: null,
      unreadCount: 0,
    };
    await emitFromServer('chat:new', newGroup);

    expect(await screen.findByText('Fresh Group')).toBeInTheDocument();
  });

  it('previews a deleted last message as italic "Message deleted", keeping the You: prefix', async () => {
    const fromBob: MessageDTO = { ...msg(8, bob, ''), content: '', isDeleted: true };
    const fromMe: MessageDTO = { ...msg(9, me, ''), content: '', isDeleted: true };

    stubFetch([
      { id: 30, type: 'dm', name: null, members: [me, bob], lastMessage: fromBob, unreadCount: 0 },
      { id: 31, type: 'group', name: 'Squad', members: [me, bob], lastMessage: fromMe, unreadCount: 0 },
    ]);
    renderChatList();

    const theirs = await screen.findByText('Message deleted');
    expect(theirs).toBeInTheDocument();
    expect(theirs.className).toContain('italic');
    // "You:" prefix logic still applies for my own deleted message.
    expect(screen.getByText('You: Message deleted')).toBeInTheDocument();
  });

  it("shows an italic blue 'typing…' preview while a chat has a typer, reverting on message:new", async () => {
    stubFetch(chats);
    renderChatList();

    // The DM (chat 10) initially previews its last message.
    await screen.findByText('Hey there');

    // A typing signal for chat 10 swaps the preview for 'typing…'.
    await emitFromServer('typing', { chatId: 10, userId: bob.id });
    const typing = await screen.findByText('typing…');
    expect(typing.className).toContain('italic');
    expect(typing.className).toContain('text-[#0084ff]');
    expect(screen.queryByText('Hey there')).not.toBeInTheDocument();

    // A message landing in chat 10 means the typed message arrived — revert at once.
    await emitFromServer('message:new', { ...msg(7, bob, 'Hey there'), chatId: 10 });
    expect(await screen.findByText('Hey there')).toBeInTheDocument();
    expect(screen.queryByText('typing…')).not.toBeInTheDocument();
  });

  it('ignores my own typing signal for the preview', async () => {
    stubFetch(chats);
    renderChatList();
    await screen.findByText('Hey there');

    await emitFromServer('typing', { chatId: 10, userId: me.id });
    expect(screen.queryByText('typing…')).not.toBeInTheDocument();
  });

  it('previews empty-content messages with attachments', async () => {
    const photo: AttachmentDTO = {
      id: 1,
      kind: 'image',
      originalName: 'p.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      width: 100,
      height: 100,
      hasThumb: true,
    };
    const fromBob: MessageDTO = { ...msg(8, bob, ''), attachments: [photo] };
    const fromMe: MessageDTO = { ...msg(9, me, ''), attachments: [photo] };

    stubFetch([
      { id: 30, type: 'dm', name: null, members: [me, bob], lastMessage: fromBob, unreadCount: 0 },
      { id: 31, type: 'group', name: 'Album', members: [me, bob], lastMessage: fromMe, unreadCount: 0 },
    ]);
    renderChatList();

    expect(await screen.findByText('📷 Photo')).toBeInTheDocument();
    // "You:" prefix logic still applies for my own attachment message.
    expect(screen.getByText('You: 📷 Photo')).toBeInTheDocument();
  });

  describe('message search', () => {
    // A search hit lives in the group chat (id 11) so the result's chat title
    // ('Team') is distinct from its sender ('Bob').
    const hit: MessageDTO = { ...msg(50, bob, 'hello there world'), chatId: 11 };

    it('debounces, then renders result rows with chat title, sender and a highlighted snippet', async () => {
      const fetchMock = stubFetch(chats, { messages: [hit] });
      renderChatList();
      await screen.findByText('Bob'); // chat list is up first

      await userEvent.type(screen.getByLabelText('Search messages'), 'world');

      // The result row appears once the debounced request resolves.
      await screen.findByText('Team'); // chat title on the result row
      expect(screen.getByText('Bob')).toBeInTheDocument(); // sender line

      // The matched term is wrapped in a <mark>; the rest of the snippet isn't.
      const mark = screen.getByText('world');
      expect(mark.tagName).toBe('MARK');
      expect(screen.getByText('hello there')).toBeInTheDocument();

      // Exactly one search request fired despite five keystrokes (debounced).
      const searchCalls = fetchMock.mock.calls.filter(([i]) =>
        i.toString().includes('/api/search'),
      );
      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0]?.[0].toString()).toContain('q=world');
    });

    it('links a result to the chat focused on the message (?message=)', async () => {
      stubFetch(chats, { messages: [hit] });
      renderChatList();
      await userEvent.type(screen.getByLabelText('Search messages'), 'world');

      const snippet = await screen.findByText('world');
      const link = snippet.closest('a');
      expect(link?.getAttribute('href')).toBe('/chats/11?message=50');
    });

    it('shows an empty state when nothing matches', async () => {
      stubFetch(chats, { messages: [] });
      renderChatList();
      await userEvent.type(screen.getByLabelText('Search messages'), 'nope');

      expect(await screen.findByText('No messages found')).toBeInTheDocument();
    });

    it('loads more results via the nextCursor', async () => {
      const more: MessageDTO = { ...msg(40, bob, 'another world hit'), chatId: 11 };
      const fetchMock = stubFetch(chats, { messages: [hit], nextCursor: 50, morePage: [more] });
      renderChatList();
      await userEvent.type(screen.getByLabelText('Search messages'), 'world');

      await screen.findByText('hello there');
      await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByText('another')).toBeInTheDocument();
      const moreCall = fetchMock.mock.calls.find(([i]) =>
        i.toString().includes('/api/search') && i.toString().includes('before=50'),
      );
      expect(moreCall).toBeDefined();
    });

    it('clearing the query restores the normal chat list', async () => {
      stubFetch(chats, { messages: [hit] });
      renderChatList();
      await userEvent.type(screen.getByLabelText('Search messages'), 'world');
      await screen.findByText('Team');

      await userEvent.click(screen.getByLabelText('Clear search'));

      // Back to the chat list: the DM row (previewing its last message) returns,
      // and the "No messages found" / result rows are gone.
      expect(await screen.findByText('Hey there')).toBeInTheDocument();
      expect(screen.queryByText('hello there')).not.toBeInTheDocument();
    });
  });
});
