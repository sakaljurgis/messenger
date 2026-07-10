import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AttachmentDTO, ChatMemberDTO, ChatSummaryDTO } from '@messenger/shared';
import SharePage from './SharePage';
import { AuthProvider } from '../lib/auth';
import type { SharedPayload, SharePayloadStore } from '../lib/share';

// Controllable Socket.IO stand-in (useChats/AuthProvider touch it; no real
// connection in jsdom). Mirrors the ChatListPage test's mock.
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

// Mock only the network upload; compress/shouldCompress stay real (they no-op on
// the tiny non-compressible test blobs).
const uploadMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/attachments')>();
  return { ...actual, uploadAttachment: uploadMock };
});

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

const chats: ChatSummaryDTO[] = [
  { id: 10, type: 'dm', name: null, members: [me, bob], lastMessage: null, unreadCount: 0 },
  { id: 11, type: 'group', name: 'Team', members: [me, bob, carol], lastMessage: null, unreadCount: 0 },
];

const photo: AttachmentDTO = {
  id: 999,
  kind: 'image',
  originalName: 'photo.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 10,
  width: 100,
  height: 100,
  hasThumb: true,
};

/** Stub fetch: auth, chat list, and the message-send POST (captured for asserts). */
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith('/api/auth/me')) return jsonResponse(200, { user: me });
    if (url.endsWith('/api/chats')) return jsonResponse(200, { chats });
    if (/\/api\/chats\/\d+\/messages$/.test(url) && init?.method === 'POST') {
      return jsonResponse(200, { message: { id: 5000 } });
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeStore(payload: SharedPayload | null): SharePayloadStore & {
  read: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn(async () => payload),
    clear: vi.fn(async () => {}),
  };
}

function sharedPayload(over: Partial<SharedPayload> = {}): SharedPayload {
  return { title: '', text: '', url: '', files: [], ...over };
}

function imageFile(name = 'photo.jpg'): { name: string; type: string; blob: Blob } {
  return { name, type: 'image/jpeg', blob: new Blob(['tiny'], { type: 'image/jpeg' }) };
}

function renderShare(store: SharePayloadStore) {
  render(
    <MemoryRouter initialEntries={['/share']}>
      <AuthProvider>
        <Routes>
          <Route path="/share" element={<SharePage store={store} />} />
          <Route path="/chats" element={<div>Chat list</div>} />
          <Route path="/chats/:id" element={<div>Chat open</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('SharePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    uploadMock.mockReset();
  });

  it('previews the shared text/file and lists chats to send to', async () => {
    stubFetch();
    const store = makeStore(sharedPayload({ text: 'Check this out', url: 'https://example.com', files: [imageFile()] }));
    renderShare(store);

    // Prefill merges text + url into the editable message field.
    const textarea = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Check this out\nhttps://example.com');

    // The shared image shows as a thumbnail.
    expect(screen.getByAltText('photo.jpg')).toBeInTheDocument();

    // Destination chats render (title resolved once auth loads meId=1).
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
  });

  it('uploads files then posts one message with the attachment ids and content, and navigates', async () => {
    const fetchMock = stubFetch();
    uploadMock.mockResolvedValue(photo);
    const store = makeStore(sharedPayload({ text: 'Look', files: [imageFile()] }));
    renderShare(store);

    // Send is disabled until a destination is picked.
    const sendBtn = await screen.findByRole('button', { name: 'Send' });
    expect(sendBtn).toBeDisabled();

    await userEvent.click(await screen.findByText('Bob'));
    expect(sendBtn).toBeEnabled();
    await userEvent.click(sendBtn);

    // The file went through the shared upload pipeline, targeting the picked chat.
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0]![0]).toBe(10);
    expect(uploadMock.mock.calls[0]![1]).toBeInstanceOf(File);

    // Exactly one message POST, carrying the attachment id + content.
    const post = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([i, init]) => /\/api\/chats\/10\/messages$/.test(i.toString()) && init?.method === 'POST',
      );
      if (!call) throw new Error('no message POST yet');
      return call;
    });
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toEqual({ content: 'Look', attachmentIds: [999] });

    // Stash consumed exactly once, then navigate into the chat.
    await waitFor(() => expect(store.clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Chat open')).toBeInTheDocument();
  });

  it('sends a text-only share with no attachments', async () => {
    const fetchMock = stubFetch();
    const store = makeStore(sharedPayload({ text: 'Just a note' }));
    renderShare(store);

    await userEvent.click(await screen.findByText('Team'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const post = await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([i, init]) => /\/api\/chats\/11\/messages$/.test(i.toString()) && init?.method === 'POST',
      );
      if (!call) throw new Error('no message POST yet');
      return call;
    });
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toEqual({ content: 'Just a note' });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('shows a friendly empty state when nothing was shared', async () => {
    stubFetch();
    const store = makeStore(null);
    renderShare(store);

    expect(await screen.findByText('Nothing was shared.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to chats' })).toHaveAttribute('href', '/chats');
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('keeps the payload and surfaces an error when the upload fails, allowing retry', async () => {
    stubFetch();
    uploadMock.mockRejectedValue(new Error('Upload exploded'));
    const store = makeStore(sharedPayload({ text: 'Look', files: [imageFile()] }));
    renderShare(store);

    await userEvent.click(await screen.findByText('Bob'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Inline error, payload NOT cleared, and the button offers a retry.
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload exploded');
    expect(store.clear).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    // Still on the share screen — no navigation happened.
    expect(screen.queryByText('Chat open')).not.toBeInTheDocument();
  });
});
