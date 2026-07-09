import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ChatSummaryDTO,
  ClientToServerEvents,
  MessageDTO,
  ServerToClientEvents,
  UserDTO,
} from '@messenger/shared';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createDb } from './db/index.js';
import { createChatEvents } from './events.js';
import { initSocket, type SocketHandle } from './socket.js';

type App = ReturnType<typeof createApp>;
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Short offline-presence grace so the debounce resolves within the test (prod default is 5s). */
const GRACE_MS = 200;

interface Harness {
  app: App;
  server: http.Server;
  port: number;
  handle: SocketHandle;
}

/**
 * Boot a real HTTP server (app + Socket.IO on the SAME db/events) on an ephemeral
 * port. `presenceGraceMs` is shortened in presence tests so the offline debounce
 * resolves within the test rather than the 5s production default.
 */
async function startServer(presenceGraceMs?: number): Promise<Harness> {
  const db = createDb(':memory:');
  const events = createChatEvents();
  const app = createApp(db, events);
  const server = http.createServer(app);
  const handle = initSocket(server, db, events, presenceGraceMs);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { app, server, port, handle };
}

interface Actor {
  user: UserDTO;
  /** The `sid=<token>` cookie pair, ready to drop into a Cookie header. */
  cookie: string;
}

/** Register through REST (same server/db) and capture the session cookie. */
async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  const sid = setCookie.find((c) => c.startsWith('sid='))!.split(';')[0]!;
  return { user: res.body.user as UserDTO, cookie: sid };
}

describe('Socket.IO real-time', () => {
  let ctx: Harness;
  const openSockets: ClientSocket[] = [];

  function connect(cookie?: string): ClientSocket {
    const socket = ioClient(`http://localhost:${ctx.port}`, {
      extraHeaders: cookie ? { cookie } : {},
      reconnection: false,
      forceNew: true,
    });
    openSockets.push(socket);
    return socket;
  }

  /** Resolve on the next `event`, or reject after `timeoutMs`. */
  function waitFor<T>(socket: ClientSocket, event: keyof ServerToClientEvents, timeoutMs = 3000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
      socket.once(event as never, ((payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      }) as never);
    });
  }

  /** Resolve when the socket connects; reject on connect_error (or timeout). */
  function waitConnect(socket: ClientSocket, timeoutMs = 3000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timed out')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Poll a predicate until true (server-side effects lag the client callback). */
  async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('condition never became true');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeEach(async () => {
    ctx = await startServer(GRACE_MS);
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.close();
    openSockets.length = 0;
    // Closing the io server also closes the underlying HTTP server.
    await new Promise<void>((resolve) => ctx.handle.io.close(() => resolve()));
    // Cancel any offline-presence timers parked by the forced disconnects above
    // so no unref'd timer lingers past the test.
    ctx.handle.clearPresenceTimers();
  });

  it('rejects a connection with no cookie', async () => {
    const socket = connect();
    await expect(waitConnect(socket)).rejects.toThrow(/unauthorized/i);
  });

  it('rejects a connection with a garbage sid cookie', async () => {
    const socket = connect('sid=totally-bogus-token');
    await expect(waitConnect(socket)).rejects.toThrow(/unauthorized/i);
  });

  it('accepts a connection carrying a valid session cookie', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const socket = connect(alice.cookie);
    await expect(waitConnect(socket)).resolves.toBeUndefined();
    expect(socket.connected).toBe(true);
  });

  it('delivers message:new to a connected member when another member POSTs a message', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const dm = await request(ctx.app)
      .post('/api/chats')
      .set('Cookie', alice.cookie)
      .send({ userId: bob.user.id });
    const chatId = dm.body.chat.id as number;

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    const received = waitFor<MessageDTO>(bobSocket, 'message:new');
    await request(ctx.app)
      .post(`/api/chats/${chatId}/messages`)
      .set('Cookie', alice.cookie)
      .send({ content: 'hello bob' });

    const message = await received;
    expect(message.content).toBe('hello bob');
    expect(message.chatId).toBe(chatId);
    expect(message.sender.id).toBe(alice.user.id);
  });

  it('delivers a personalized chat:new when a group is created including the member', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    const received = waitFor<ChatSummaryDTO>(bobSocket, 'chat:new');
    await request(ctx.app)
      .post('/api/chats')
      .set('Cookie', alice.cookie)
      .send({ name: 'Team', memberIds: [bob.user.id] });

    const chat = await received;
    expect(chat.type).toBe('group');
    expect(chat.name).toBe('Team');
    // Personalized summary carries the (zero) unread count and the full roster.
    expect(chat).toHaveProperty('unreadCount', 0);
    expect(new Set(chat.members.map((m) => m.id))).toEqual(
      new Set([alice.user.id, bob.user.id]),
    );
  });

  it('delivers read:updated to a connected member when another member POSTs /read', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const dm = await request(ctx.app)
      .post('/api/chats')
      .set('Cookie', alice.cookie)
      .send({ userId: bob.user.id });
    const chatId = dm.body.chat.id as number;

    const msg = await request(ctx.app)
      .post(`/api/chats/${chatId}/messages`)
      .set('Cookie', bob.cookie)
      .send({ content: 'hi alice' });
    const messageId = msg.body.message.id as number;

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    const received = waitFor<{ chatId: number; userId: number; lastReadMessageId: number }>(
      bobSocket,
      'read:updated',
    );
    await request(ctx.app)
      .post(`/api/chats/${chatId}/read`)
      .set('Cookie', alice.cookie)
      .send({ messageId });

    const payload = await received;
    expect(payload).toEqual({ chatId, userId: alice.user.id, lastReadMessageId: messageId });
  });

  it('reports presence via isUserConnected: true while connected, false after disconnect', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const socket = connect(alice.cookie);
    await waitConnect(socket);

    await waitUntil(() => ctx.handle.isUserConnected(alice.user.id));
    expect(ctx.handle.isUserConnected(alice.user.id)).toBe(true);

    socket.close();
    await waitUntil(() => !ctx.handle.isUserConnected(alice.user.id));
    expect(ctx.handle.isUserConnected(alice.user.id)).toBe(false);
  });

  it('relays typing to the other member of a chat but not back to the sender', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const dm = await request(ctx.app)
      .post('/api/chats')
      .set('Cookie', alice.cookie)
      .send({ userId: bob.user.id });
    const chatId = dm.body.chat.id as number;

    const aliceSocket = connect(alice.cookie);
    const bobSocket = connect(bob.cookie);
    await Promise.all([waitConnect(aliceSocket), waitConnect(bobSocket)]);

    // The sender must NOT receive an echo of their own typing signal.
    let aliceGotTyping = false;
    aliceSocket.on('typing', () => {
      aliceGotTyping = true;
    });

    const bobReceived = waitFor<{ chatId: number; userId: number }>(bobSocket, 'typing');
    aliceSocket.emit('typing', chatId);

    expect(await bobReceived).toEqual({ chatId, userId: alice.user.id });
    expect(aliceGotTyping).toBe(false);
  });

  it('ignores a typing signal for a chat the sender is not a member of', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');
    const carol = await register(ctx.app, 'carol@example.com', 'Carol');

    // A DM between Bob and Carol; Alice is deliberately NOT a member.
    const dm = await request(ctx.app)
      .post('/api/chats')
      .set('Cookie', bob.cookie)
      .send({ userId: carol.user.id });
    const chatId = dm.body.chat.id as number;

    const aliceSocket = connect(alice.cookie);
    const bobSocket = connect(bob.cookie);
    await Promise.all([waitConnect(aliceSocket), waitConnect(bobSocket)]);

    let bobGotTyping = false;
    bobSocket.on('typing', () => {
      bobGotTyping = true;
    });

    aliceSocket.emit('typing', chatId);
    // Bounded negative wait: a non-member's typing must produce nothing.
    await new Promise((r) => setTimeout(r, 150));
    expect(bobGotTyping).toBe(false);
  });

  it('sends a presence:state snapshot that lists an already-connected user', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const aliceSocket = connect(alice.cookie);
    await waitConnect(aliceSocket);
    await waitUntil(() => ctx.handle.isUserConnected(alice.user.id));

    // Bob's snapshot (pushed on connect) should already include Alice.
    const bobSocket = connect(bob.cookie);
    const snapshot = waitFor<number[]>(bobSocket, 'presence:state');
    await waitConnect(bobSocket);

    expect(await snapshot).toContain(alice.user.id);
  });

  it('broadcasts presence online to connected users when a user first connects', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    // Bob is already online; Alice connecting fires a fresh online broadcast.
    const aliceOnline = waitFor<{ userId: number; online: boolean }>(bobSocket, 'presence');
    const aliceSocket = connect(alice.cookie);
    await waitConnect(aliceSocket);

    expect(await aliceOnline).toEqual({ userId: alice.user.id, online: true });
  });

  it('broadcasts presence offline after the last socket disconnects past the grace window', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    // Sync on Alice's online event first so the next 'presence' is unambiguously offline.
    const aliceOnline = waitFor<{ userId: number; online: boolean }>(bobSocket, 'presence');
    const aliceSocket = connect(alice.cookie);
    await waitConnect(aliceSocket);
    expect(await aliceOnline).toEqual({ userId: alice.user.id, online: true });

    const aliceOffline = waitFor<{ userId: number; online: boolean }>(bobSocket, 'presence');
    aliceSocket.close();
    expect(await aliceOffline).toEqual({ userId: alice.user.id, online: false });
  });

  it('does not broadcast offline when a user reconnects within the grace window', async () => {
    const alice = await register(ctx.app, 'alice@example.com', 'Alice');
    const bob = await register(ctx.app, 'bob@example.com', 'Bob');

    const bobSocket = connect(bob.cookie);
    await waitConnect(bobSocket);

    // Get Alice online (and observed by Bob) before we start watching for flicker.
    const aliceOnline = waitFor<{ userId: number; online: boolean }>(bobSocket, 'presence');
    const aliceSocket = connect(alice.cookie);
    await waitConnect(aliceSocket);
    await aliceOnline;

    // Record every subsequent presence event about Alice.
    const events: Array<{ userId: number; online: boolean }> = [];
    bobSocket.on('presence', (p) => {
      if (p.userId === alice.user.id) events.push(p);
    });

    // Drop and immediately reconnect within the grace window (a page reload).
    aliceSocket.close();
    const aliceReconnect = connect(alice.cookie);
    await waitConnect(aliceReconnect);

    // Wait past the grace window: no offline (nor a spurious re-online) should fire.
    await new Promise((r) => setTimeout(r, GRACE_MS + 150));
    expect(events).toEqual([]);
  });
});
