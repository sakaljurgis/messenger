import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentDTO, ChatMemberDTO, ChatSummaryDTO, MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
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
  /** nextCursor for the default (newest / ?before=) page — defaults to null. */
  nextCursor?: number | null;
  /** GET /messages?around=<id> — the centred window (both cursors). */
  onAround?: (id: number) => MessagesPage;
  /** GET /messages?after=<cursor> — the next newer page (newerCursor null at the edge). */
  onAfter?: (cursor: number) => MessagesPage;
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
      const params = new URL(url, 'http://localhost').searchParams;
      const around = params.get('around');
      const after = params.get('after');
      if (around != null && options.onAround) {
        return jsonResponse(200, options.onAround(Number(around)));
      }
      if (after != null && options.onAfter) {
        return jsonResponse(200, options.onAfter(Number(after)));
      }
      // Default (newest page or ?before=): the contract omits newerCursor here.
      return jsonResponse(200, { messages: options.messages, nextCursor: options.nextCursor ?? null });
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

function videoAttachment(id: number, name = 'clip.mp4'): AttachmentDTO {
  return {
    id,
    kind: 'video',
    originalName: name,
    mimeType: 'video/mp4',
    sizeBytes: 500_000,
    width: null,
    height: null,
    hasThumb: false,
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

/** jsdom has no Clipboard API — stub navigator.clipboard.writeText for the
 *  copy-action tests (cleaned up in the top-level afterEach). Defines just the
 *  one property on the real navigator object rather than replacing it wholesale,
 *  so userEvent's own navigator reads (userAgent, etc.) keep working. */
function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

/** Mock the scroll container's geometry and fire a scroll event reporting the
 *  viewport as far from the bottom (helper for jump-to-bottom-pill tests). */
function scrollAwayFromBottom(scrollEl: HTMLElement) {
  Object.defineProperty(scrollEl, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scrollEl, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
  fireEvent.scroll(scrollEl);
}

function renderChatPage(entry = '/chats/10') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
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
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  it('renders fetched messages with mine right/blue and others left/gray', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')] });
    renderChatPage();

    // The text sits inside the markdown renderer's <p>; climb to the bubble div.
    const theirs = (await screen.findByText('Hi from Bob')).closest('.rounded-2xl') as HTMLElement;
    const mine = screen.getByText('Hi from me').closest('.rounded-2xl') as HTMLElement;

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

  it('renders a video attachment as an inline <video> with controls', async () => {
    const vidMsg: MessageDTO = { ...msg(1, bob, ''), attachments: [videoAttachment(77)] };
    stubFetch({ messages: [vidMsg] });
    renderChatPage();

    const video = await screen.findByTestId('video-attachment');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('/api/attachments/77');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
  });

  it('renders a video as its own block, never inside the image grid', async () => {
    const mixedMsg: MessageDTO = {
      ...msg(1, bob, ''),
      attachments: [imageAttachment(42), imageAttachment(43), videoAttachment(77)],
    };
    stubFetch({ messages: [mixedMsg] });
    const { container } = renderChatPage();

    const video = await screen.findByTestId('video-attachment');
    expect(video.closest('.grid')).toBeNull();

    const grid = container.querySelector('.grid');
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll('img')).toHaveLength(2);
    expect(grid?.querySelector('video')).toBeNull();
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

  it('renders message content as markdown (bold, safe links) inside the bubble', async () => {
    stubFetch({
      messages: [msg(1, bob, 'this is **important** and [a link](https://example.com)')],
    });
    renderChatPage();

    const strong = await screen.findByText('important');
    expect(strong.tagName).toBe('STRONG');
    expect(strong.closest('.rounded-2xl')?.className).toContain('bg-gray-200');

    const link = screen.getByRole('link', { name: 'a link' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it("group: sender name label carries the sender's accent color", async () => {
    const coloredBob: ChatMemberDTO = { ...bob, color: '#ab12cd' };
    const group: ChatSummaryDTO = {
      id: 10, type: 'group', name: 'Team', members: [me, coloredBob], lastMessage: null, unreadCount: 0,
    };
    stubFetch({ messages: [msg(1, coloredBob, 'hi team')], chat: group });
    renderChatPage();

    const label = await screen.findByText('Bob');
    expect(label).toHaveStyle({ color: '#ab12cd' });
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

  it('shows a Copy row and copies the message content to the clipboard', async () => {
    stubFetch({ messages: [msg(2, me, 'copy me please')] });
    const writeText = stubClipboard();
    renderChatPage();

    await screen.findByText('copy me please');

    await userEvent.click(screen.getByLabelText('Message actions'));
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('copy me please');
    // Closes on tap like the other rows.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not show a Copy row for an attachment-only message', async () => {
    const imgMsg: MessageDTO = { ...msg(1, bob, ''), attachments: [imageAttachment(42)] };
    stubFetch({ messages: [imgMsg] });
    renderChatPage();

    await screen.findByAltText('photo.jpg');

    await userEvent.click(screen.getByLabelText('Message actions'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('shows a Copy row for received messages too, not just own', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    const writeText = stubClipboard();
    renderChatPage();

    await screen.findByText('Hi from Bob');

    await userEvent.click(screen.getByLabelText('Message actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('Hi from Bob');
  });

  it('anchors the actions popover inward: left on received messages, right on mine', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')] });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    // Received message: the popover hangs off the LEFT edge (opening rightward,
    // into the screen) — right-anchoring it to a short bubble near the left
    // screen edge pushed it off-screen.
    const theirWrap = screen.getByText('Hi from Bob').closest('.group') as HTMLElement;
    await userEvent.click(within(theirWrap).getByLabelText('Message actions'));
    const theirMenu = screen.getByRole('menu');
    expect(theirMenu.className).toContain('left-0');
    expect(theirMenu.className).not.toContain('right-0');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // My message: right-anchored, opening leftward.
    const myWrap = screen.getByText('Hi from me').closest('.group') as HTMLElement;
    await userEvent.click(within(myWrap).getByLabelText('Message actions'));
    expect(screen.getByRole('menu').className).toContain('right-0');
  });

  it('flips the popover above the bubble when it would clip the bottom of the scroll area', async () => {
    stubFetch({ messages: [msg(1, bob, 'low on screen'), msg(2, me, 'high on screen')] });
    renderChatPage();

    await screen.findByText('low on screen');

    // Fake the geometry jsdom doesn't compute: the scroll area occupies
    // y=0..640, the menu measures 160px tall, and the first bubble sits near
    // the bottom (no room below, plenty above) while the second sits at the
    // top (plenty of room below).
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(160);
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
    screen.getByTestId('message-scroll').getBoundingClientRect = () => rect(0, 640);

    const lowWrap = screen.getByText('low on screen').closest('.group') as HTMLElement;
    lowWrap.getBoundingClientRect = () => rect(600, 620);
    await userEvent.click(within(lowWrap).getByLabelText('Message actions'));
    expect(screen.getByRole('menu').className).toContain('bottom-full');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    const highWrap = screen.getByText('high on screen').closest('.group') as HTMLElement;
    highWrap.getBoundingClientRect = () => rect(20, 40);
    await userEvent.click(within(highWrap).getByLabelText('Message actions'));
    expect(screen.getByRole('menu').className).toContain('top-full');

    offsetHeightSpy.mockRestore();
  });

  it('places the hidden actions button inward so it never indents a bubble', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob'), msg(2, me, 'Hi from me')] });
    renderChatPage();

    await screen.findByText('Hi from Bob');

    // Received: bubble first, button after — an invisible button BEFORE the
    // bubble still takes flex space and shifted the bubble right of its
    // timestamp/reaction chips.
    const theirWrap = screen.getByText('Hi from Bob').closest('.group') as HTMLElement;
    expect(theirWrap.lastElementChild).toBe(within(theirWrap).getByLabelText('Message actions'));

    // Mine: button first, hanging inward off the right-aligned bubble.
    const myWrap = screen.getByText('Hi from me').closest('.group') as HTMLElement;
    expect(myWrap.firstElementChild).toBe(within(myWrap).getByLabelText('Message actions'));
  });

  it('suppresses the native long-press selection UI on the bubble wrapper', async () => {
    stubFetch({ messages: [msg(1, bob, 'Hi from Bob')] });
    renderChatPage();

    const bubble = await screen.findByText('Hi from Bob');
    // The long-press target disables the OS text-selection callout on touch
    // devices (otherwise the phone's copy/select popup opens alongside ours),
    // while pointer:coarse scoping keeps desktop mouse selection working.
    const pressTarget = bubble.closest('[class*="touch-callout"]') as HTMLElement | null;
    expect(pressTarget).not.toBeNull();
    expect(pressTarget!.className).toContain('[@media(pointer:coarse)]:select-none');
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

  describe('focus mode (windowed history, jump-to-message)', () => {
    // A five-message window centred on id 3, with more history beyond it in both
    // directions (nextCursor older, newerCursor newer → not at the live edge).
    const window: MessageDTO[] = [
      msg(1, bob, 'first'),
      msg(2, me, 'second'),
      msg(3, bob, 'target message'),
      msg(4, me, 'fourth'),
      msg(5, bob, 'fifth'),
    ];
    const windowPage: MessagesPage = { messages: window, nextCursor: null, newerCursor: 5 };
    // The next newer page reaches the present (newerCursor null → live edge).
    const newerPage: MessagesPage = {
      messages: [msg(6, me, 'sixth'), msg(7, bob, 'seventh')],
      nextCursor: 4,
      newerCursor: null,
    };

    it('opens a window around ?message=, fetching around=, centring + flashing it, with no unread divider', async () => {
      // Default `me` fixture has lastReadMessageId 0, so a NORMAL open of this
      // window would show an unread divider before bob's first message — focus
      // mode must not.
      const fetchMock = stubFetch({ messages: [], onAround: () => windowPage, onAfter: () => newerPage });
      renderChatPage('/chats/10?message=3');

      await screen.findByText('target message');

      const aroundCall = fetchMock.mock.calls.find(
        ([i, init]) => i.toString().includes('around=3') && (init?.method ?? 'GET') === 'GET',
      );
      expect(aroundCall).toBeDefined();

      // The target is flashed with the existing highlight treatment.
      await waitFor(() =>
        expect(document.getElementById('message-3')?.className).toContain('bg-[#0084ff]/10'),
      );

      // No unread divider in a windowed open, and a "Load newer" affordance is
      // present (the window hasn't reached the present).
      expect(screen.queryByRole('separator', { name: 'New messages' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load newer' })).toBeInTheDocument();
    });

    it('pages forward with "Load newer" until it reaches the live edge', async () => {
      stubFetch({ messages: [], onAround: () => windowPage, onAfter: () => newerPage });
      renderChatPage('/chats/10?message=3');

      await screen.findByText('target message');
      expect(screen.getByText('fifth')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Load newer' }));

      // Newer messages appended; now at the live edge, so the affordance is gone.
      expect(await screen.findByText('seventh')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load newer' })).not.toBeInTheDocument();
    });

    it('suppresses a live message:new while windowed but counts it, appending once back at the live edge', async () => {
      stubFetch({ messages: [], onAround: () => windowPage, onAfter: () => newerPage });
      renderChatPage('/chats/10?message=3');

      await screen.findByText('target message');

      // A live message must NOT be spliced into the middle of old history...
      await emitFromServer('message:new', msg(20, bob, 'live while windowed'));
      expect(screen.queryByText('live while windowed')).not.toBeInTheDocument();
      // ...but it drives the jump-to-bottom pill's "N new" count.
      expect(await screen.findByText('1 new')).toBeInTheDocument();

      // Page forward to the present.
      await userEvent.click(screen.getByRole('button', { name: 'Load newer' }));
      await screen.findByText('seventh');

      // At the live edge, appends resume: a further live message shows up.
      await emitFromServer('message:new', msg(21, bob, 'live at edge'));
      expect(await screen.findByText('live at edge')).toBeInTheDocument();
    });

    it('marks read only once at the live edge, never from the middle of the window', async () => {
      const fetchMock = stubFetch({ messages: [], onAround: () => windowPage, onAfter: () => newerPage });
      renderChatPage('/chats/10?message=3');

      await screen.findByText('target message');
      // Let effects flush; while windowed, no read marker is POSTed.
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([i]) => i.toString().includes('around=3')),
        ).toBe(true),
      );
      expect(fetchMock.mock.calls.filter(([i]) => i.toString().includes('/read'))).toHaveLength(0);

      // Reaching the live edge triggers the mark-read.
      await userEvent.click(screen.getByRole('button', { name: 'Load newer' }));
      await screen.findByText('seventh');
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([i]) => i.toString().includes('/read'))).toBe(true),
      );
    });

    it('jump-to-bottom pill resets a windowed view to the live newest window (refetch)', async () => {
      const fetchMock = stubFetch({
        messages: [msg(8, me, 'newest live message')], // the default newest page
        onAround: () => windowPage,
        onAfter: () => newerPage,
      });
      renderChatPage('/chats/10?message=3');

      await screen.findByText('target message');
      // The pill is visible in a windowed view (there are messages beyond it).
      const pill = await screen.findByLabelText('Jump to latest messages');

      await userEvent.click(pill);

      // Dropping the focus param refetches the newest page: the live message
      // replaces the old window.
      expect(await screen.findByText('newest live message')).toBeInTheDocument();
      expect(screen.queryByText('target message')).not.toBeInTheDocument();
      // A default (no around/after) GET fired for the reset.
      expect(
        fetchMock.mock.calls.some(
          ([i, init]) =>
            i.toString().includes('/messages') &&
            (init?.method ?? 'GET') === 'GET' &&
            !i.toString().includes('around=') &&
            !i.toString().includes('after='),
        ),
      ).toBe(true);
    });

    it('reply-jump falls back to focus mode when the quoted original is not loaded', async () => {
      const replyMsg: MessageDTO = {
        ...msg(10, me, 'my reply'),
        replyTo: { id: 1, senderId: bob.id, content: 'orig', isDeleted: false, hasAttachments: false },
      };
      // Newest page: only the reply — the original (id 1) is far up the history.
      const fetchMock = stubFetch({
        messages: [replyMsg],
        onAround: () => ({
          messages: [msg(1, bob, 'the original message body'), msg(2, me, 'x'), replyMsg],
          nextCursor: null,
          newerCursor: null,
        }),
      });
      renderChatPage();

      await screen.findByText('my reply');

      // Tapping the quote can't scroll (original not loaded) → focus-mode fallback.
      await userEvent.click(screen.getByRole('button', { name: 'Replying to Bob' }));

      expect(await screen.findByText('the original message body')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([i]) => i.toString().includes('around=1'))).toBe(true);
    });
  });
});
