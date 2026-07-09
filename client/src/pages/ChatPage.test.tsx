import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentDTO, ChatMemberDTO, ChatSummaryDTO, MessageDTO, UserDTO } from '@messenger/shared';
import ChatPage from './ChatPage';
import { AuthProvider } from '../lib/auth';
import { formatBytes } from '../lib/attachments';

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

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return { id, chatId: 10, sender, content, mentions: [], attachments: [], reactions: [], replyTo: null, createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(), editedAt: null, isDeleted: false };
}

const dmChat: ChatSummaryDTO = {
  id: 10,
  type: 'dm',
  name: null,
  members: [me, bob],
  lastMessage: null,
  unreadCount: 0,
};

/** Mock covering every endpoint ChatPage touches; POST/PATCH /messages are customizable. */
function stubFetch(options: {
  messages: MessageDTO[];
  chat?: ChatSummaryDTO;
  /** Directory returned by GET /api/users (for the group-info add-members picker). */
  users?: UserDTO[];
  onPost?: (body: unknown) => MessageDTO;
  onPatch?: (body: { content: string; mentions?: number[] }, id: number) => MessageDTO;
  /** POST /messages/:id/reactions — return the updated message for the toggled emoji. */
  onReact?: (body: { emoji: string }, id: number) => MessageDTO;
}) {
  const chat = options.chat ?? dmChat;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
    if (url.endsWith('/api/users')) return jsonResponse(200, { users: options.users ?? [] });
    if (url.endsWith('/leave') && method === 'POST') return jsonResponse(204, {});
    if (url.endsWith('/members') && method === 'PATCH') return jsonResponse(200, { chat });
    if (url.match(/\/api\/chats\/\d+$/)) return jsonResponse(200, { chat });
    if (url.endsWith('/reactions') && method === 'POST') {
      const body = JSON.parse(init?.body as string) as { emoji: string };
      // .../messages/<id>/reactions -> the id is the second-to-last path segment.
      const id = Number(url.split('/').at(-2));
      const message = options.onReact
        ? options.onReact(body, id)
        : { ...msg(id, me, 'x'), reactions: [{ emoji: body.emoji, userIds: [me.id] }] };
      return jsonResponse(200, { message });
    }
    if (url.includes('/messages') && method === 'GET') {
      return jsonResponse(200, { messages: options.messages, nextCursor: null });
    }
    if (url.includes('/messages') && method === 'POST') {
      const body = JSON.parse(init?.body as string);
      const message = options.onPost ? options.onPost(body) : msg(99, me, body.content);
      return jsonResponse(201, { message });
    }
    if (url.includes('/messages') && method === 'PATCH') {
      const body = JSON.parse(init?.body as string) as { content: string; mentions?: number[] };
      const id = Number(url.split('/').pop());
      const message = options.onPatch
        ? options.onPatch(body, id)
        : { ...msg(id, me, body.content), editedAt: new Date().toISOString() };
      return jsonResponse(200, { message });
    }
    if (url.includes('/messages') && method === 'DELETE') {
      return jsonResponse(204, {});
    }
    if (url.includes('/read')) return jsonResponse(204, {});
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function imageAttachment(id: number, name = 'photo.jpg'): AttachmentDTO {
  return {
    id,
    kind: 'image',
    originalName: name,
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    width: 800,
    height: 600,
    hasThumb: true,
  };
}

function fileAttachment(id: number, name = 'report.pdf', sizeBytes = 3_355_443): AttachmentDTO {
  return {
    id,
    kind: 'file',
    originalName: name,
    mimeType: 'application/pdf',
    sizeBytes,
    width: null,
    height: null,
    hasThumb: false,
  };
}

/** Mock the scroll container's geometry and fire a scroll event reporting the
 *  viewport as far from the bottom (helper for jump-to-bottom-pill tests). */
function scrollAwayFromBottom(scrollEl: HTMLElement) {
  Object.defineProperty(scrollEl, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
  fireEvent.scroll(scrollEl);
}

function renderChatPage() {
  return render(
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
      attachments: [],
      reactions: [],
      replyTo: null,
      createdAt: new Date(1_700_000_003_000).toISOString(),
      editedAt: null,
      isDeleted: false,
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
    await emitFromServer('message:new', msg(7, bob, 'Live socket message'));

    expect(await screen.findByText('Live socket message')).toBeInTheDocument();
  });

  it('renders an image attachment as a thumbnail and opens the lightbox on click', async () => {
    const imgMsg: MessageDTO = { ...msg(1, bob, ''), attachments: [imageAttachment(42)] };
    stubFetch({ messages: [imgMsg] });
    renderChatPage();

    // The bubble uses the thumbnail variant.
    const thumb = await screen.findByAltText('photo.jpg');
    expect(thumb.getAttribute('src')).toBe('/api/attachments/42?thumb=1');
    expect(thumb.getAttribute('loading')).toBe('lazy');

    await userEvent.click(thumb);

    // The lightbox shows the full (non-thumb) image plus a download link.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByAltText('photo.jpg').getAttribute('src')).toBe('/api/attachments/42');
    expect(within(dialog).getByRole('link', { name: /download/i }).getAttribute('href')).toBe(
      '/api/attachments/42?download=1',
    );

    // Escape closes it.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders a file attachment as a download card with name and size', async () => {
    const fileMsg: MessageDTO = { ...msg(1, bob, ''), attachments: [fileAttachment(9)] };
    stubFetch({ messages: [fileMsg] });
    renderChatPage();

    const name = await screen.findByText('report.pdf');
    expect(screen.getByText(formatBytes(3_355_443))).toBeInTheDocument();
    expect(name.closest('a')?.getAttribute('href')).toBe('/api/attachments/9?download=1');
  });

  it('renders an attachment-only image message without a text bubble', async () => {
    const imgMsg: MessageDTO = { ...msg(1, bob, ''), attachments: [imageAttachment(42)] };
    stubFetch({ messages: [imgMsg] });
    const { container } = renderChatPage();

    const thumb = await screen.findByAltText('photo.jpg');
    // Bare image (Messenger style): the image is not wrapped in a text bubble,
    // and no empty gray bubble is rendered anywhere in the thread.
    expect(thumb.closest('.bg-gray-200')).toBeNull();
    expect(container.querySelector('.bg-gray-200')).toBeNull();
  });

  it('renders a deleted message as a "Message deleted" tombstone with no actions menu', async () => {
    const deleted: MessageDTO = { ...msg(2, me, 'was here'), content: '', isDeleted: true };
    stubFetch({ messages: [deleted] });
    renderChatPage();

    expect(await screen.findByText('Message deleted')).toBeInTheDocument();
    // Tombstones expose no edit/delete affordance, even for my own message.
    expect(screen.queryByLabelText('Message actions')).not.toBeInTheDocument();
  });

  it('shows an "(edited)" label next to the timestamp for an edited message', async () => {
    const edited: MessageDTO = { ...msg(2, me, 'v2'), editedAt: new Date().toISOString() };
    stubFetch({ messages: [edited] });
    renderChatPage();

    await screen.findByText('v2');
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('edit flow: open menu → Edit → banner shows, save PATCHes the new body and updates the bubble', async () => {
    const fetchMock = stubFetch({
      messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Original text')],
      onPatch: (body, id) => ({ ...msg(id, me, body.content), editedAt: new Date().toISOString() }),
    });
    renderChatPage();

    await screen.findByText('Original text');

    // Open the actions menu on my own message and pick Edit. Both messages now
    // carry an actions affordance (received ones expose the reaction picker), so
    // scope to my bubble's wrapper to grab the right button.
    const myWrap = screen.getByText('Original text').closest('.group') as HTMLElement;
    await userEvent.click(within(myWrap).getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));

    // Banner appears and the input is prefilled with the original text.
    expect(screen.getByText('Editing message')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Aa') as HTMLInputElement;
    expect(input.value).toBe('Original text');

    await userEvent.clear(input);
    await userEvent.type(input, 'Edited text');
    await userEvent.click(screen.getByRole('button', { name: /save edit/i }));

    // PATCH went to the message with just the new content.
    const patchCall = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().includes('/messages/2') && init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({ content: 'Edited text' });

    // Bubble now shows the edited text and edit mode has exited.
    expect(await screen.findByText('Edited text')).toBeInTheDocument();
    expect(screen.queryByText('Editing message')).not.toBeInTheDocument();
  });

  it('delete flow: confirm → DELETE and the bubble becomes a tombstone', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = stubFetch({ messages: [msg(2, me, 'Delete me')] });
    renderChatPage();

    await screen.findByText('Delete me');

    await userEvent.click(screen.getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    expect(confirmSpy).toHaveBeenCalled();
    const deleteCall = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().includes('/messages/2') && init?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();

    // Optimistic tombstone replaces the bubble.
    expect(await screen.findByText('Message deleted')).toBeInTheDocument();
    expect(screen.queryByText('Delete me')).not.toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('replaces a bubble live when a message:updated (edit) arrives over the socket', async () => {
    stubFetch({ messages: [msg(7, bob, 'before edit')] });
    renderChatPage();

    await screen.findByText('before edit');

    await emitFromServer('message:updated', {
      ...msg(7, bob, 'after edit'),
      editedAt: new Date().toISOString(),
    });

    expect(await screen.findByText('after edit')).toBeInTheDocument();
    expect(screen.queryByText('before edit')).not.toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('turns a bubble into a tombstone live when a message:updated (delete) arrives', async () => {
    stubFetch({ messages: [msg(7, bob, 'doomed')] });
    renderChatPage();

    await screen.findByText('doomed');

    await emitFromServer('message:updated', { ...msg(7, bob, ''), content: '', isDeleted: true });

    expect(await screen.findByText('Message deleted')).toBeInTheDocument();
    expect(screen.queryByText('doomed')).not.toBeInTheDocument();
  });

  it('renders an xs read-receipt avatar under the message the other member has read up to', async () => {
    const bobRead: ChatMemberDTO = { ...bob, lastReadMessageId: 2 }; // newest loaded message
    stubFetch({
      messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')],
      chat: { ...dmChat, members: [me, bobRead] },
    });
    renderChatPage();

    await screen.findByText('Hi from me');

    // Bob's receipt anchors on message 2 (the newest), rendered as a single xs
    // avatar with a hover title naming him.
    const receipt = screen.getByTitle('Bob');
    expect(receipt).toBeInTheDocument();
    expect(screen.getAllByTitle('Bob')).toHaveLength(1);
  });

  it('does not render a receipt for a member who has not read anything yet', async () => {
    stubFetch({
      messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')],
      chat: { ...dmChat, members: [me, { ...bob, lastReadMessageId: 0 }] },
    });
    renderChatPage();

    await screen.findByText('Hi from me');
    expect(screen.queryByTitle('Bob')).not.toBeInTheDocument();
  });

  it('shows the read-receipt avatar live when a read:updated event arrives over the socket', async () => {
    stubFetch({
      messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')],
      chat: { ...dmChat, members: [me, { ...bob, lastReadMessageId: 0 }] },
    });
    renderChatPage();

    await screen.findByText('Hi from me');
    expect(screen.queryByTitle('Bob')).not.toBeInTheDocument();

    // Server pushes Bob's advanced read marker — the avatar appears without a refetch.
    await emitFromServer('read:updated', { chatId: 10, userId: bob.id, lastReadMessageId: 2 });

    expect(await screen.findByTitle('Bob')).toBeInTheDocument();
  });

  it('shows a typing indicator on a socket typing event and hides it after expiry', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();
    await screen.findByText('Hi from Bob');

    // Fake timers fire the 1s prune interval; an explicit Date.now spy (installed
    // after useFakeTimers so it governs the clock the prune reads) makes the 4s
    // expiry deterministic.
    await waitFor(() => expect(socket.listenerCount('typing')).toBeGreaterThan(0));
    let now = 100_000;
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      act(() => {
        socket.emit('typing', { chatId: 10, userId: bob.id }); // expiresAt = now + 4000
      });
      expect(screen.getByText('Bob is typing…')).toBeInTheDocument();

      now += 5000; // past the 4s expiry
      act(() => {
        vi.advanceTimersByTime(5000); // let the 1s sweep run
      });
      expect(screen.queryByText('Bob is typing…')).not.toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ignores my own id in typing events', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();
    await screen.findByText('Hi from Bob');

    await emitFromServer('typing', { chatId: 10, userId: me.id });
    expect(screen.queryByText(/is typing…/)).not.toBeInTheDocument();
  });

  it('labels two simultaneous typers together', async () => {
    const carol: ChatMemberDTO = {
      id: 3, email: 'carol@example.com', displayName: 'Carol', isBot: false, lastReadMessageId: 0,
    };
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob, carol], lastMessage: null, unreadCount: 0,
    };
    stubFetch({ messages: [msg(1, bob, 'hi team')], chat: group });
    renderChatPage();
    await screen.findByText('hi team');

    await emitFromServer('typing', { chatId: 10, userId: bob.id });
    await emitFromServer('typing', { chatId: 10, userId: carol.id });

    expect(screen.getByText('Bob and Carol are typing…')).toBeInTheDocument();
  });

  it('renders received DM bubbles without the avatar gutter (full-width rows)', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    const { container } = renderChatPage();
    await screen.findByText('Hi from Bob');

    // The w-8 spacer column exists only in groups (it holds the sender avatar).
    expect(container.querySelector('.w-8.flex-shrink-0')).toBeNull();
  });

  it('group: sender avatar has a hover title and tapping it reveals the name', async () => {
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob], lastMessage: null, unreadCount: 0,
    };
    stubFetch({ messages: [msg(1, bob, 'hi team'), msg(2, bob, 'again')], chat: group });
    const { container } = renderChatPage();
    await screen.findByText('hi team');

    // Gutter present in groups; sender label only on the first message of the run.
    expect(container.querySelector('.w-8.flex-shrink-0')).not.toBeNull();
    expect(screen.getAllByText('Bob')).toHaveLength(1);

    const avatarButton = screen.getByRole('button', { name: 'Sent by Bob' });
    expect(avatarButton).toHaveAttribute('title', 'Bob');

    // Tap (mobile has no hover): the name appears on the avatar's own row too.
    await userEvent.click(avatarButton);
    expect(screen.getAllByText('Bob')).toHaveLength(2);
  });

  it('group info: lists members and PATCHes newly added ones', async () => {
    const carol: ChatMemberDTO = {
      id: 3, email: 'carol@example.com', displayName: 'Carol', isBot: false, lastReadMessageId: 0,
    };
    const dave: UserDTO = { id: 4, email: 'dave@example.com', displayName: 'Dave', isBot: false };
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob, carol], lastMessage: null, unreadCount: 0,
    };
    const fetchMock = stubFetch({
      messages: [msg(1, bob, 'hi team')],
      chat: group,
      users: [bob, carol, dave],
    });
    renderChatPage();
    await screen.findByText('hi team');

    await userEvent.click(screen.getByRole('button', { name: 'Group info' }));
    expect(await screen.findByText('(you)')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();

    // Dave isn't a member yet — select him and add.
    await userEvent.click(screen.getByRole('button', { name: /Dave/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Add/ }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([input, init]) => input.toString().endsWith('/members') && init?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ memberIds: [4] });
    });
  });

  it('group info: leaving POSTs /leave and navigates back to the chat list', async () => {
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob], lastMessage: null, unreadCount: 0,
    };
    const fetchMock = stubFetch({ messages: [msg(1, bob, 'hi team')], chat: group, users: [bob] });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderChatPage();
      await screen.findByText('hi team');

      await userEvent.click(screen.getByRole('button', { name: 'Group info' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Leave group' }));

      expect(await screen.findByText('Chat list')).toBeInTheDocument();
      const leave = fetchMock.mock.calls.find(
        ([input, init]) => input.toString().endsWith('/leave') && init?.method === 'POST',
      );
      expect(leave).toBeDefined();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('group info: explains when there is nobody left to add (section never vanishes)', async () => {
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob], lastMessage: null, unreadCount: 0,
    };
    // The whole directory is already in the group.
    stubFetch({ messages: [msg(1, bob, 'hi team')], chat: group, users: [bob] });
    renderChatPage();
    await screen.findByText('hi team');

    await userEvent.click(screen.getByRole('button', { name: 'Group info' }));

    expect(await screen.findByText('Add members')).toBeInTheDocument();
    expect(await screen.findByText('Everyone is already in this group.')).toBeInTheDocument();
  });

  it('group info: renaming PATCHes the trimmed name and closes the form', async () => {
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, bob], lastMessage: null, unreadCount: 0,
    };
    const fetchMock = stubFetch({ messages: [msg(1, bob, 'hi team')], chat: group, users: [bob] });
    renderChatPage();
    await screen.findByText('hi team');

    await userEvent.click(screen.getByRole('button', { name: 'Group info' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Rename group' }));

    const input = screen.getByLabelText('Group name');
    await userEvent.clear(input);
    await userEvent.type(input, '  Renamed Team  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([i, init]) => i.toString().endsWith('/api/chats/10') && init?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ name: 'Renamed Team' });
    });
    // The form closes after a successful save (the live name arrives via chat:updated).
    await waitFor(() => expect(screen.queryByLabelText('Group name')).not.toBeInTheDocument());
  });

  it('navigates away when the server signals chat:removed (left in another tab)', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();
    await screen.findByText('Hi from Bob');

    await emitFromServer('chat:removed', { chatId: 10 });

    expect(await screen.findByText('Chat list')).toBeInTheDocument();
  });

  it('renders reaction chips with counts and highlights the one I reacted with', async () => {
    // 👍 by Bob + me (mine, highlighted); ❤️ by Bob only (not mine).
    const reacted: MessageDTO = {
      ...msg(2, bob, 'nice one'),
      reactions: [
        { emoji: '👍', userIds: [bob.id, me.id] },
        { emoji: '❤️', userIds: [bob.id] },
      ],
    };
    stubFetch({ messages: [reacted] });
    renderChatPage();

    await screen.findByText('nice one');

    // My reaction: count 2, "including you" and the highlighted (blue) styling.
    const mineChip = screen.getByRole('button', { name: '👍 2, including you' });
    expect(mineChip.className).toContain('bg-[#0084ff]/10');
    expect(mineChip).toHaveAttribute('aria-pressed', 'true');

    // Not-my reaction: count 1, no "including you", muted styling.
    const otherChip = screen.getByRole('button', { name: '❤️ 1' });
    expect(otherChip.className).toContain('bg-gray-100');
    expect(otherChip).toHaveAttribute('aria-pressed', 'false');
  });

  it('tapping a reaction chip POSTs the toggle to the reactions endpoint', async () => {
    const reacted: MessageDTO = {
      ...msg(2, bob, 'nice one'),
      reactions: [{ emoji: '👍', userIds: [bob.id] }],
    };
    const fetchMock = stubFetch({
      messages: [reacted],
      onReact: (body, id) => ({ ...msg(id, bob, 'nice one'), reactions: [{ emoji: body.emoji, userIds: [bob.id, me.id] }] }),
    });
    renderChatPage();

    await userEvent.click(await screen.findByRole('button', { name: '👍 1' }));

    const call = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().endsWith('/messages/2/reactions') && init?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ emoji: '👍' });

    // The server's updated DTO patches the chip in place (now 2, including me).
    expect(await screen.findByRole('button', { name: '👍 2, including you' })).toBeInTheDocument();
  });

  it('opens the picker from the actions menu and toggles a reaction', async () => {
    const fetchMock = stubFetch({
      messages: [msg(2, bob, 'react to me')],
      onReact: (body, id) => ({ ...msg(id, bob, 'react to me'), reactions: [{ emoji: body.emoji, userIds: [me.id] }] }),
    });
    renderChatPage();

    await screen.findByText('react to me');

    // Open the message actions and pick an emoji from the reaction picker.
    await userEvent.click(screen.getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'React 👍' }));

    const call = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().endsWith('/messages/2/reactions') && init?.method === 'POST',
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ emoji: '👍' });

    // The new chip appears (highlighted, since it's now mine).
    expect(await screen.findByRole('button', { name: '👍 1, including you' })).toBeInTheDocument();
  });

  it('reply action opens the reply banner naming the target sender', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    await userEvent.click(screen.getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));

    expect(screen.getByText('Replying to Bob')).toBeInTheDocument();
  });

  it('replying POSTs the message with replyToId and clears the banner on success', async () => {
    const fetchMock = stubFetch({
      messages: [msg(1, bob, 'Hi from Bob')],
      onPost: (body) => ({
        ...msg(50, me, (body as { content: string }).content),
        replyTo: { id: 1, senderId: bob.id, content: 'Hi from Bob', isDeleted: false, hasAttachments: false },
      }),
    });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    await userEvent.click(screen.getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    await userEvent.type(screen.getByPlaceholderText('Aa'), 'my reply');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    const postCall = fetchMock.mock.calls.find(
      ([i, init]) => i.toString().includes('/messages') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({ content: 'my reply', replyToId: 1 });

    // Banner clears once the send resolves.
    await waitFor(() => expect(screen.queryByText('Replying to Bob')).not.toBeInTheDocument());
  });

  it('renders a quoted reply block above the bubble content', async () => {
    const replyMsg: MessageDTO = {
      ...msg(2, me, 'see my reply'),
      replyTo: { id: 1, senderId: bob.id, content: 'the quoted snippet', isDeleted: false, hasAttachments: false },
    };
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob'), replyMsg] });
    renderChatPage();

    await screen.findByText('see my reply');
    const quote = screen.getByRole('button', { name: 'Replying to Bob' });
    expect(within(quote).getByText('the quoted snippet')).toBeInTheDocument();
  });

  it('renders a deleted-original quote as "Message deleted"', async () => {
    const replyMsg: MessageDTO = {
      ...msg(2, me, 'reply to a deleted one'),
      replyTo: { id: 1, senderId: bob.id, content: '', isDeleted: true, hasAttachments: false },
    };
    stubFetch({ messages: [replyMsg] });
    renderChatPage();

    await screen.findByText('reply to a deleted one');
    const quote = screen.getByRole('button', { name: 'Replying to Bob' });
    expect(within(quote).getByText('Message deleted')).toBeInTheDocument();
  });

  it('renders an attachment-only original quote as "📎 Attachment"', async () => {
    const replyMsg: MessageDTO = {
      ...msg(2, me, 'reply to a photo'),
      replyTo: { id: 1, senderId: bob.id, content: '', isDeleted: false, hasAttachments: true },
    };
    stubFetch({ messages: [replyMsg] });
    renderChatPage();

    await screen.findByText('reply to a photo');
    const quote = screen.getByRole('button', { name: 'Replying to Bob' });
    expect(within(quote).getByText('📎 Attachment')).toBeInTheDocument();
  });

  it('falls back to "Unknown" when the quoted sender is no longer a member', async () => {
    const replyMsg: MessageDTO = {
      ...msg(2, me, 'reply to a ghost'),
      replyTo: { id: 1, senderId: 999, content: 'gone', isDeleted: false, hasAttachments: false },
    };
    stubFetch({ messages: [replyMsg] });
    renderChatPage();

    await screen.findByText('reply to a ghost');
    expect(screen.getByRole('button', { name: 'Replying to Unknown' })).toBeInTheDocument();
  });

  it('tapping the quote scrolls to the loaded original message', async () => {
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    try {
      const replyMsg: MessageDTO = {
        ...msg(2, me, 'reply body'),
        replyTo: { id: 1, senderId: bob.id, content: 'orig', isDeleted: false, hasAttachments: false },
      };
      stubFetch({ messages: [msg(1, bob, 'the original bubble'), replyMsg] });
      renderChatPage();

      await screen.findByText('reply body');
      scrollSpy.mockClear(); // ignore the initial auto-scroll-to-bottom

      await userEvent.click(screen.getByRole('button', { name: 'Replying to Bob' }));
      expect(scrollSpy).toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it('applies a reaction live when a message:updated with reactions arrives', async () => {
    stubFetch({ messages: [msg(7, bob, 'live react')] });
    renderChatPage();

    await screen.findByText('live react');
    expect(screen.queryByRole('button', { name: /😂/ })).not.toBeInTheDocument();

    // Server relays the reaction as a message:updated (no new socket handling needed).
    await emitFromServer('message:updated', {
      ...msg(7, bob, 'live react'),
      reactions: [{ emoji: '😂', userIds: [bob.id] }],
    });

    expect(await screen.findByRole('button', { name: '😂 1' })).toBeInTheDocument();
  });

  describe('unread divider', () => {
    it('renders immediately before the first unread message from another member', async () => {
      const meRead: ChatMemberDTO = { ...me, lastReadMessageId: 2 };
      stubFetch({
        messages: [
          msg(1, bob, 'read one'),
          msg(2, me, 'read two'),
          msg(3, bob, 'first unread'),
          msg(4, bob, 'second unread'),
        ],
        chat: { ...dmChat, members: [meRead, bob] },
      });
      renderChatPage();

      await screen.findByText('second unread');

      const divider = screen.getByRole('separator', { name: 'New messages' });
      const lastRead = screen.getByText('read two');
      const firstUnread = screen.getByText('first unread');

      // Divider sits strictly between the last read message and the first
      // unread one — after "read two", before "first unread".
      expect(
        lastRead.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        divider.compareDocumentPosition(firstUnread) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('renders no divider when everything is already read', async () => {
      const meRead: ChatMemberDTO = { ...me, lastReadMessageId: 5 };
      stubFetch({
        messages: [msg(1, bob, 'old'), msg(2, bob, 'older still')],
        chat: { ...dmChat, members: [meRead, bob] },
      });
      renderChatPage();

      await screen.findByText('older still');
      expect(screen.queryByRole('separator', { name: 'New messages' })).not.toBeInTheDocument();
    });

    it('anchors on the first other-sender message when I have read nothing yet', async () => {
      // lastReadMessageId 0 (the default `me` fixture) means "read nothing":
      // everything from Bob is unread, so the boundary is his first message.
      stubFetch({ messages: [msg(1, bob, 'brand new chat'), msg(2, bob, 'second')] });
      renderChatPage();

      await screen.findByText('second');
      const divider = screen.getByRole('separator', { name: 'New messages' });
      const first = screen.getByText('brand new chat');
      expect(divider.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('stays visible after the automatic mark-read read:updated echo arrives (the freeze bug)', async () => {
      const meRead: ChatMemberDTO = { ...me, lastReadMessageId: 1 };
      stubFetch({
        messages: [msg(1, bob, 'already read'), msg(2, bob, 'unread one')],
        chat: { ...dmChat, members: [meRead, bob] },
      });
      renderChatPage();

      await screen.findByText('unread one');
      expect(screen.getByRole('separator', { name: 'New messages' })).toBeInTheDocument();

      // Simulate the mark-read echo: the server confirms MY OWN read position
      // advanced to the newest message (fired the instant the chat opened).
      // A naively live-computed divider would vanish here; the frozen one
      // must not.
      await emitFromServer('read:updated', { chatId: 10, userId: me.id, lastReadMessageId: 2 });

      expect(screen.getByRole('separator', { name: 'New messages' })).toBeInTheDocument();
    });
  });

  describe('jump-to-bottom pill', () => {
    it('is hidden by default and appears once a scroll event reports the viewport away from the bottom', async () => {
      stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
      const { container } = renderChatPage();
      await screen.findByText('Hi from Bob');

      expect(screen.queryByLabelText('Jump to latest messages')).not.toBeInTheDocument();

      const scrollEl = container.querySelector('[data-testid="message-scroll"]') as HTMLElement;
      scrollAwayFromBottom(scrollEl);

      expect(await screen.findByLabelText('Jump to latest messages')).toBeInTheDocument();
    });

    it('increments its "N new" count on a live message from another member while scrolled up, and never for my own', async () => {
      const fetchMock = stubFetch({
        messages: [msg(1, bob, 'Hi from Bob')],
        onPost: (body) => msg(50, me, (body as { content: string }).content),
      });
      const { container } = renderChatPage();
      await screen.findByText('Hi from Bob');

      const scrollEl = container.querySelector('[data-testid="message-scroll"]') as HTMLElement;
      scrollAwayFromBottom(scrollEl);
      const pill = await screen.findByLabelText('Jump to latest messages');
      // No count yet — just the arrow.
      expect(within(pill).queryByText(/new/)).not.toBeInTheDocument();

      await emitFromServer('message:new', msg(2, bob, 'a new one while scrolled up'));
      expect(await screen.findByText('1 new')).toBeInTheDocument();

      await emitFromServer('message:new', msg(3, bob, 'another'));
      expect(await screen.findByText('2 new')).toBeInTheDocument();

      // My own send appends too, but must never bump the count.
      await userEvent.type(screen.getByPlaceholderText('Aa'), 'mine');
      await userEvent.click(screen.getByRole('button', { name: /send/i }));
      await screen.findByText('mine');
      expect(fetchMock).toHaveBeenCalled();
      expect(screen.getByText('2 new')).toBeInTheDocument();
    });

    it('clicking scrolls to the bottom sentinel, resets the count and hides the pill', async () => {
      const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
      try {
        stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
        const { container } = renderChatPage();
        await screen.findByText('Hi from Bob');
        scrollSpy.mockClear(); // ignore the initial auto-scroll-to-bottom

        const scrollEl = container.querySelector('[data-testid="message-scroll"]') as HTMLElement;
        scrollAwayFromBottom(scrollEl);
        await emitFromServer('message:new', msg(2, bob, 'while scrolled up'));
        const pill = await screen.findByLabelText('Jump to latest messages');
        expect(within(pill).getByText('1 new')).toBeInTheDocument();

        await userEvent.click(pill);

        expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
        expect(screen.queryByLabelText('Jump to latest messages')).not.toBeInTheDocument();
      } finally {
        scrollSpy.mockRestore();
      }
    });

    it('resets the count once the viewport scrolls back near the bottom', async () => {
      stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
      const { container } = renderChatPage();
      await screen.findByText('Hi from Bob');

      const scrollEl = container.querySelector('[data-testid="message-scroll"]') as HTMLElement;
      scrollAwayFromBottom(scrollEl);
      await emitFromServer('message:new', msg(2, bob, 'while scrolled up'));
      await screen.findByText('1 new');

      // Scroll back near the bottom.
      Object.defineProperty(scrollEl, 'scrollHeight', { value: 2000, configurable: true });
      Object.defineProperty(scrollEl, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(scrollEl, 'scrollTop', { value: 1650, configurable: true }); // 2000-1650-400=-50 < 100
      fireEvent.scroll(scrollEl);

      await waitFor(() =>
        expect(screen.queryByLabelText('Jump to latest messages')).not.toBeInTheDocument(),
      );
    });
  });
});
