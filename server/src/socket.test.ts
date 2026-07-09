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

interface Harness {
  app: App;
  server: http.Server;
  port: number;
  handle: SocketHandle;
}

/** Boot a real HTTP server (app + Socket.IO on the SAME db/events) on an ephemeral port. */
async function startServer(): Promise<Harness> {
  const db = createDb(':memory:');
  const events = createChatEvents();
  const app = createApp(db, events);
  const server = http.createServer(app);
  const handle = initSocket(server, db, events);
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
    ctx = await startServer();
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.close();
    openSockets.length = 0;
    // Closing the io server also closes the underlying HTTP server.
    await new Promise<void>((resolve) => ctx.handle.io.close(() => resolve()));
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
});
