import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
  return { id, chatId: 1, sender, content, mentions: [], attachments: [], createdAt: new Date().toISOString(), editedAt: null, isDeleted: false };
}

const chats: ChatSummaryDTO[] = [
  { id: 10, type: 'dm', name: null, members: [me, bob], lastMessage: msg(5, bob, 'Hey there'), unreadCount: 2 },
  { id: 11, type: 'group', name: 'Team', members: [me, bob, carol], lastMessage: msg(6, me, 'Hello all'), unreadCount: 0 },
];

function stubFetch(chatList: ChatSummaryDTO[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
      if (url.endsWith('/api/chats')) return jsonResponse(200, { chats: chatList });
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
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
});
