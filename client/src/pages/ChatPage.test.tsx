import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import ChatPage from './ChatPage';
import { AuthProvider } from '../lib/auth';

// A tiny in-memory stand-in for the Socket.IO client so tests can drive server
// events synchronously (and no real connection is opened in jsdom).
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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const me: UserDTO = { id: 1, email: 'me@example.com', displayName: 'Me', isBot: false };
const bob: UserDTO = { id: 2, email: 'bob@example.com', displayName: 'Bob', isBot: false };

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return { id, chatId: 10, sender, content, mentions: [], createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString() };
}

const dmChat: ChatSummaryDTO = {
  id: 10,
  type: 'dm',
  name: null,
  members: [me, bob],
  lastMessage: null,
  unreadCount: 0,
};

/** Mock covering every endpoint ChatPage touches; POST /messages is customizable. */
function stubFetch(options: {
  messages: MessageDTO[];
  onPost?: (body: unknown) => MessageDTO;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
    if (url.match(/\/api\/chats\/\d+$/)) return jsonResponse(200, { chat: dmChat });
    if (url.includes('/messages') && method === 'GET') {
      return jsonResponse(200, { messages: options.messages, nextCursor: null });
    }
    if (url.includes('/messages') && method === 'POST') {
      const body = JSON.parse(init?.body as string);
      const message = options.onPost ? options.onPost(body) : msg(99, me, body.content);
      return jsonResponse(201, { message });
    }
    if (url.includes('/read')) return jsonResponse(204, {});
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderChatPage() {
  render(
    <MemoryRouter initialEntries={['/chats/10']}>
      <AuthProvider>
        <Routes>
          <Route path="/chats/:id" element={<ChatPage />} />
          <Route path="/chats" element={<div>Chat list</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('ChatPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders fetched messages with mine right/blue and others left/gray', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')] });
    renderChatPage();

    const theirs = await screen.findByText('Hi from Bob');
    const mine = screen.getByText('Hi from me');

    expect(theirs.className).toContain('bg-gray-200');
    expect(mine.className).toContain('bg-[#0084ff]');
  });

  it('sends a message: POSTs { content } and appends the returned message', async () => {
    const fetchMock = stubFetch({
      messages: [msg(1, bob, 'Hi from Bob')],
      onPost: (body) => msg(50, me, (body as { content: string }).content),
    });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    await userEvent.type(screen.getByPlaceholderText('Aa'), 'A brand new message');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    // The response message is appended to the thread.
    expect(await screen.findByText('A brand new message')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => input.toString().includes('/messages') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({ content: 'A brand new message' });
  });

  it('highlights an @mention of me in an incoming message', async () => {
    const mentionMsg: MessageDTO = {
      id: 3,
      chatId: 10,
      sender: bob,
      content: 'hey @Me look',
      mentions: [me.id],
      createdAt: new Date(1_700_000_003_000).toISOString(),
    };
    stubFetch({ messages: [mentionMsg] });
    renderChatPage();

    const mention = await screen.findByText('@Me');
    // Others' bubble + mention of me → boosted color plus the subtle highlight.
    expect(mention.className).toContain('font-semibold');
    expect(mention.className).toContain('text-[#0084ff]');
    expect(mention.className).toContain('bg-[#0084ff]/10');
  });

  it('appends a message delivered live over the socket for this chat', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    // Server pushes a new message for chat 10 — no REST round-trip involved.
    act(() => {
      socket.emit('message:new', msg(7, bob, 'Live socket message'));
    });

    expect(await screen.findByText('Live socket message')).toBeInTheDocument();
  });
});
