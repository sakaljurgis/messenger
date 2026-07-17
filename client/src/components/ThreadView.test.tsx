import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MessageDTO, UserDTO } from '@messenger/shared';
import ThreadView from './ThreadView';

// Hand-rolled fake socket (same pattern as ChatPage.test.tsx): tests deliver
// server events via emitFromServer, which waits for the component to subscribe.
const socket = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    _listeners: listeners,
  };
});

vi.mock('../lib/socket', () => ({
  getSocket: () => socket,
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn(),
}));

/** Emit a server->client event AFTER the component has subscribed (a too-early
 *  emit is silently lost — see CLAUDE.md test hygiene). */
async function emitFromServer(event: string, ...args: unknown[]) {
  await waitFor(() => expect(socket.listenerCount(event)).toBeGreaterThan(0));
  act(() => socket.emit(event, ...args));
}

const me: UserDTO = { id: 1, email: 'me@x.com', displayName: 'Me', color: null, isBot: false };
const bob: UserDTO = { id: 2, email: 'bob@x.com', displayName: 'Bob', color: null, isBot: false };

function msg(id: number, sender: UserDTO, content: string): MessageDTO {
  return {
    id,
    chatId: 1,
    sender,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyTo: null,
    createdAt: new Date(2026, 6, 17, 12, 0, id).toISOString(),
    editedAt: null,
    isDeleted: false,
  };
}

/** A thread chain: root(1, bob) <- reply(2, me) <- reply(3, bob). */
function chain(): MessageDTO[] {
  const root = msg(1, bob, 'root message');
  const a: MessageDTO = {
    ...msg(2, me, 'first reply'),
    replyTo: { id: 1, senderId: bob.id, content: 'root message', isDeleted: false, hasAttachments: false },
  };
  const b: MessageDTO = {
    ...msg(3, bob, 'second reply'),
    replyTo: { id: 2, senderId: me.id, content: 'first reply', isDeleted: false, hasAttachments: false },
  };
  return [root, a, b];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stub the two endpoints ThreadView (and its embedded Composer) touch. */
function stubFetch(thread: { rootId: number; messages: MessageDTO[] }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.match(/\/messages\/\d+\/thread$/)) return jsonResponse(200, thread);
    if (url.endsWith('/scheduled')) return jsonResponse(200, { scheduled: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderThread(overrides: Partial<Parameters<typeof ThreadView>[0]> = {}) {
  const props = {
    chatId: 1,
    anchorId: 2,
    members: [me, bob],
    meId: me.id,
    isGroup: false,
    onClose: vi.fn(),
    onShowInChat: vi.fn(),
    sendMessage: vi.fn(async () => null),
    editMessage: vi.fn(),
    deleteMessage: vi.fn(async () => {}),
    toggleReaction: vi.fn(),
    onTriggerAction: vi.fn(async () => {}),
    ...overrides,
  };
  render(<ThreadView {...props} />);
  return props;
}

beforeEach(() => {
  socket._listeners.clear();
  vi.unstubAllGlobals();
});

describe('ThreadView', () => {
  it('renders the fetched chain oldest-first with a reply-count divider and no quote chips', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    renderThread();

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('root message');
    expect(within(dialog).getByText('first reply')).toBeInTheDocument();
    expect(within(dialog).getByText('second reply')).toBeInTheDocument();
    // Header subtitle + the divider after the root both carry the count.
    expect(within(dialog).getAllByText('2 replies').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('separator', { name: '2 replies' })).toBeInTheDocument();
    // The chain is the context — the replies' quote chips are stripped.
    expect(within(dialog).queryByRole('button', { name: /Replying to/ })).not.toBeInTheDocument();
  });

  it('offers Show in chat but no Reply in the message actions menu', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    const props = renderThread();

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('second reply');

    // Open the actions menu on Bob's second reply (id 3).
    const bubbleWrap = within(dialog).getByText('second reply').closest('.group')!;
    await userEvent.click(within(bubbleWrap as HTMLElement).getByLabelText('Message actions'));

    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Reply' })).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Show in chat' }));
    expect(props.onShowInChat).toHaveBeenCalledWith(3);
  });

  it('sends composer text as a reply to the thread ROOT and shows it immediately', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    const sent: MessageDTO = {
      ...msg(4, me, 'a fresh thread reply'),
      replyTo: { id: 1, senderId: bob.id, content: 'root message', isDeleted: false, hasAttachments: false },
    };
    const sendMessage = vi.fn(async () => sent);
    renderThread({ sendMessage });

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('second reply');

    await userEvent.type(screen.getByRole('textbox'), 'a fresh thread reply');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // replyToId = the ROOT (1), not the anchor (2) or the newest (3).
    expect(sendMessage).toHaveBeenCalledWith('a fresh thread reply', [], [], 1);
    expect(await within(dialog).findByText('a fresh thread reply')).toBeInTheDocument();
  });

  it('falls back to the newest live message as reply target when the root is deleted', async () => {
    const [root, a, b] = chain();
    const deadRoot: MessageDTO = {
      ...root!,
      content: '',
      isDeleted: true,
    };
    stubFetch({ rootId: 1, messages: [deadRoot, a!, b!] });
    const sendMessage = vi.fn(async () => null);
    renderThread({ sendMessage });

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('second reply');

    await userEvent.type(screen.getByRole('textbox'), 'still alive');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Replying to the tombstoned root would 400 — target the newest live (3).
    expect(sendMessage).toHaveBeenCalledWith('still alive', [], [], 3);
  });

  it('appends a live message:new that replies into the thread, ignores unrelated traffic', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    renderThread();

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('second reply');

    // Bob replies to the thread's newest message — joins the thread live.
    await emitFromServer('message:new', {
      ...msg(5, bob, 'live thread reply'),
      replyTo: { id: 3, senderId: bob.id, content: 'second reply', isDeleted: false, hasAttachments: false },
    });
    expect(await within(dialog).findByText('live thread reply')).toBeInTheDocument();

    // A plain chat message (no reply) never enters the thread.
    await emitFromServer('message:new', msg(6, bob, 'unrelated chatter'));
    expect(within(dialog).queryByText('unrelated chatter')).not.toBeInTheDocument();
    // The count followed the join: 2 -> 3 replies.
    expect(within(dialog).getAllByText('3 replies').length).toBeGreaterThan(0);
  });

  it('patches a live edit of a thread message in place', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    renderThread();

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('first reply');

    await emitFromServer('message:updated', {
      ...msg(2, me, 'first reply (edited)'),
      editedAt: new Date().toISOString(),
    });
    expect(await within(dialog).findByText('first reply (edited)')).toBeInTheDocument();
    expect(within(dialog).queryByText('first reply')).not.toBeInTheDocument();
  });

  it('closes via the ✕ and via Escape', async () => {
    stubFetch({ rootId: 1, messages: chain() });
    const props = renderThread();

    const dialog = await screen.findByRole('dialog', { name: 'Thread' });
    await within(dialog).findByText('root message');

    await userEvent.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close thread' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
