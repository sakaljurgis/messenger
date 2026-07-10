import type { UserDTO } from '@messenger/shared';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createDb, type Db } from './db/index.js';
import { createChatEvents, type ChatEvents } from './events.js';
import { pushSubscriptions } from './db/schema.js';
import { buildPushPayload, initPush, type PushPayload } from './push.js';
import type { ChatRow } from './db/schema.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

function subsFor(db: Db, userId: number) {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

describe('push router', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bob: Actor;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
  });

  const sample = {
    endpoint: 'https://push.example.com/sub-1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
  };

  it('subscribes (201) and stores the row for the requester', async () => {
    const res = await alice.agent.post('/api/push/subscribe').send(sample);
    expect(res.status).toBe(201);

    const rows = subsFor(db, alice.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe(sample.endpoint);
    expect(rows[0]!.p256dh).toBe(sample.keys.p256dh);
    expect(rows[0]!.auth).toBe(sample.keys.auth);
  });

  it('rejects a malformed subscription with 400', async () => {
    const res = await alice.agent
      .post('/api/push/subscribe')
      .send({ endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } });
    expect(res.status).toBe(400);
  });

  it('moves ownership when the same endpoint resubscribes as another user', async () => {
    await alice.agent.post('/api/push/subscribe').send(sample);
    const moved = await bob.agent
      .post('/api/push/subscribe')
      .send({ endpoint: sample.endpoint, keys: { p256dh: 'new-p', auth: 'new-a' } });
    expect(moved.status).toBe(201);

    // Still exactly one row (upsert, not insert), now owned by Bob with fresh keys.
    expect(subsFor(db, alice.user.id)).toHaveLength(0);
    const bobRows = subsFor(db, bob.user.id);
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]!.p256dh).toBe('new-p');
  });

  it('deletes only the requester’s own subscription (204)', async () => {
    await alice.agent.post('/api/push/subscribe').send(sample);

    // Bob cannot delete Alice's subscription.
    const foreign = await bob.agent
      .delete('/api/push/subscribe')
      .send({ endpoint: sample.endpoint });
    expect(foreign.status).toBe(204);
    expect(subsFor(db, alice.user.id)).toHaveLength(1);

    // The owner can.
    const own = await alice.agent
      .delete('/api/push/subscribe')
      .send({ endpoint: sample.endpoint });
    expect(own.status).toBe(204);
    expect(subsFor(db, alice.user.id)).toHaveLength(0);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/push/vapid-key')).status).toBe(401);
    expect((await request(app).post('/api/push/subscribe').send(sample)).status).toBe(401);
  });

  describe('GET /api/push/vapid-key', () => {
    const original = process.env.VAPID_PUBLIC_KEY;
    afterEach(() => {
      if (original === undefined) delete process.env.VAPID_PUBLIC_KEY;
      else process.env.VAPID_PUBLIC_KEY = original;
    });

    it('returns null when unconfigured', async () => {
      delete process.env.VAPID_PUBLIC_KEY;
      const res = await alice.agent.get('/api/push/vapid-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: null });
    });

    it('returns the configured key', async () => {
      process.env.VAPID_PUBLIC_KEY = 'BPublicKey123';
      const res = await alice.agent.get('/api/push/vapid-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: 'BPublicKey123' });
    });
  });
});

describe('buildPushPayload', () => {
  const sender: UserDTO = { id: 1, email: 'a@x.com', displayName: 'Alice', isBot: false };
  const dm = { id: 10, type: 'dm', name: null } as ChatRow;
  const group = { id: 11, type: 'group', name: 'Team' } as ChatRow;
  const base = {
    id: 5,
    chatId: 11,
    sender,
    content: 'hi',
    mentions: [],
    attachments: [],
    reactions: [],
    replyTo: null,
    createdAt: '',
    editedAt: null,
    isDeleted: false,
  };

  it('uses the sender name as the title for a DM', () => {
    expect(buildPushPayload({ ...base, chatId: 10 }, dm, 2).title).toBe('Alice');
  });

  it('uses "<sender> in <group>" for a group message', () => {
    expect(buildPushPayload(base, group, 2).title).toBe('Alice in Team');
  });

  it('uses the mention title when the recipient is mentioned', () => {
    const p = buildPushPayload({ ...base, mentions: [2] }, group, 2);
    expect(p.title).toBe('Alice mentioned you in Team');
  });

  it('truncates the body past 120 chars with an ellipsis and carries ids in data', () => {
    const long = 'x'.repeat(200);
    const p = buildPushPayload({ ...base, content: long }, group, 2);
    expect(p.body).toBe('x'.repeat(120) + '…');
    expect(p.data).toEqual({ chatId: 11, messageId: 5 });
  });
});

describe('push fan-out', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let groupId: number;
  const connected = new Set<number>();
  const send = vi.fn<typeof import('web-push').sendNotification>();
  let handle: ReturnType<typeof initPush>;

  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;

  beforeEach(async () => {
    // initPush reads keys at init; fake values are fine because `send` is stubbed.
    process.env.VAPID_PUBLIC_KEY = 'test-public';
    process.env.VAPID_PRIVATE_KEY = 'test-private';

    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    connected.clear();
    send.mockReset();
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    handle = initPush(db, events, (id) => connected.has(id), send);

    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');

    groupId = (
      await alice.agent
        .post('/api/chats')
        .send({ name: 'Team', memberIds: [bob.user.id, carol.user.id] })
    ).body.chat.id as number;

    // Both Bob and Carol have a subscription; only Carol is currently online.
    db.insert(pushSubscriptions)
      .values([
        { userId: bob.user.id, endpoint: 'https://push.example.com/bob', p256dh: 'pb', auth: 'ab' },
        { userId: carol.user.id, endpoint: 'https://push.example.com/carol', p256dh: 'pc', auth: 'ac' },
      ])
      .run();
    connected.add(carol.user.id);
  });

  afterEach(() => {
    if (savedPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = savedPriv;
  });

  it('pushes only to offline members, with the mention-aware payload', async () => {
    await alice.agent
      .post(`/api/chats/${groupId}/messages`)
      .send({ content: 'hey team', mentions: [bob.user.id] });
    await handle.lastDispatch;

    // Carol is online (socket), Alice is the sender → Bob is the only recipient.
    expect(send).toHaveBeenCalledTimes(1);
    const [subscription, payloadJson] = send.mock.calls[0]!;
    expect(subscription.endpoint).toBe('https://push.example.com/bob');
    const payload = JSON.parse(payloadJson as string) as PushPayload;
    expect(payload.title).toBe('Alice mentioned you in Team');
    expect(payload.data.chatId).toBe(groupId);
  });

  it('prunes a subscription the push service reports as gone (410)', async () => {
    send.mockReset();
    send.mockRejectedValue({ statusCode: 410 });

    await alice.agent.post(`/api/chats/${groupId}/messages`).send({ content: 'still here?' });
    await handle.lastDispatch;

    expect(send).toHaveBeenCalledTimes(1);
    expect(subsFor(db, bob.user.id)).toHaveLength(0);
    // Carol was online, so hers is untouched.
    expect(subsFor(db, carol.user.id)).toHaveLength(1);
  });
});

describe('push fan-out — mute', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let groupId: number;
  const connected = new Set<number>();
  const send = vi.fn<typeof import('web-push').sendNotification>();
  let handle: ReturnType<typeof initPush>;

  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;

  beforeEach(async () => {
    process.env.VAPID_PUBLIC_KEY = 'test-public';
    process.env.VAPID_PRIVATE_KEY = 'test-private';

    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    connected.clear();
    send.mockReset();
    send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    handle = initPush(db, events, (id) => connected.has(id), send);

    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');

    groupId = (
      await alice.agent
        .post('/api/chats')
        .send({ name: 'Team', memberIds: [bob.user.id, carol.user.id] })
    ).body.chat.id as number;

    // Bob and Carol are both offline and subscribed — the baseline recipient
    // set before any mute filtering is applied.
    db.insert(pushSubscriptions)
      .values([
        { userId: bob.user.id, endpoint: 'https://push.example.com/bob', p256dh: 'pb', auth: 'ab' },
        { userId: carol.user.id, endpoint: 'https://push.example.com/carol', p256dh: 'pc', auth: 'ac' },
      ])
      .run();
  });

  afterEach(() => {
    if (savedPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = savedPriv;
  });

  it('skips a muted member but still delivers to an unmuted one', async () => {
    expect((await bob.agent.put(`/api/chats/${groupId}/mute`).send({ muted: true })).status).toBe(
      204,
    );

    await alice.agent.post(`/api/chats/${groupId}/messages`).send({ content: 'hey team' });
    await handle.lastDispatch;

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]!.endpoint).toBe('https://push.example.com/carol');
  });

  it('skips a muted member even when @mentioned — a mute is a mute', async () => {
    await bob.agent.put(`/api/chats/${groupId}/mute`).send({ muted: true });

    await alice.agent
      .post(`/api/chats/${groupId}/messages`)
      .send({ content: 'hey @bob', mentions: [bob.user.id] });
    await handle.lastDispatch;

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]!.endpoint).toBe('https://push.example.com/carol');
  });

  it('does not affect the socket relay or unread count for the muted member', async () => {
    await bob.agent.put(`/api/chats/${groupId}/mute`).send({ muted: true });

    await alice.agent.post(`/api/chats/${groupId}/messages`).send({ content: 'hey team' });
    await handle.lastDispatch;

    const bobSummary = (await bob.agent.get(`/api/chats/${groupId}`)).body.chat as {
      unreadCount: number;
    };
    expect(bobSummary.unreadCount).toBe(1);
  });

  it('resumes delivery after unmuting (mute state survives intervening traffic)', async () => {
    await bob.agent.put(`/api/chats/${groupId}/mute`).send({ muted: true });
    await alice.agent.post(`/api/chats/${groupId}/messages`).send({ content: 'while muted' });
    await handle.lastDispatch;
    expect(send).toHaveBeenCalledTimes(1); // only Carol

    send.mockClear();
    await bob.agent.put(`/api/chats/${groupId}/mute`).send({ muted: false });

    await alice.agent.post(`/api/chats/${groupId}/messages`).send({ content: 'unmuted now' });
    await handle.lastDispatch;

    const endpoints = send.mock.calls.map(([sub]) => sub.endpoint).sort();
    expect(endpoints).toEqual(['https://push.example.com/bob', 'https://push.example.com/carol']);
  });
});
