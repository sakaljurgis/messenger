import type {
  ChatSummaryDTO,
  MessageActionDTO,
  MessageDTO,
  MessagesPage,
  UserDTO,
} from '@messenger/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';
import { messages } from '../db/schema.js';
import {
  createChatEvents,
  type ActionTriggeredEvent,
  type ChatEvents,
  type ChatNewEvent,
  type ChatUpdatedEvent,
  type MessageNewEvent,
  type MessageUpdatedEvent,
  type ReadUpdatedEvent,
} from '../events.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

function makeApp(): App {
  return createApp(createDb(':memory:'));
}

function makeAppWithEvents(): { app: App; events: ChatEvents } {
  const events = createChatEvents();
  return { app: createApp(createDb(':memory:'), events), events };
}

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

/** Fetch a single chat summary (also exercises GET /api/chats/:id). */
async function summary(actor: Actor, chatId: number): Promise<ChatSummaryDTO> {
  const res = await actor.agent.get(`/api/chats/${chatId}`);
  return res.body.chat as ChatSummaryDTO;
}

async function send(actor: Actor, chatId: number, content: string, mentions?: number[]) {
  return actor.agent.post(`/api/chats/${chatId}/messages`).send({ content, mentions });
}

describe('POST /api/chats — DM', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
  });

  it('creates a DM with both members (201)', async () => {
    const res = await alice.agent.post('/api/chats').send({ userId: bob.user.id });
    expect(res.status).toBe(201);
    const chat = res.body.chat as ChatSummaryDTO;
    expect(chat.type).toBe('dm');
    expect(chat.name).toBeNull();
    expect(new Set(chat.members.map((m) => m.id))).toEqual(
      new Set([alice.user.id, bob.user.id]),
    );
  });

  it('is idempotent: a repeat POST returns the same chat with 200', async () => {
    const first = await alice.agent.post('/api/chats').send({ userId: bob.user.id });
    const second = await alice.agent.post('/api/chats').send({ userId: bob.user.id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.chat.id).toBe(first.body.chat.id);

    // Same DM regardless of who initiates (dm_key is symmetric).
    const fromBob = await bob.agent.post('/api/chats').send({ userId: alice.user.id });
    expect(fromBob.status).toBe(200);
    expect(fromBob.body.chat.id).toBe(first.body.chat.id);
  });

  it('creates a self-DM ("notes to self") with a single member (201)', async () => {
    const res = await alice.agent.post('/api/chats').send({ userId: alice.user.id });
    expect(res.status).toBe(201);
    const chat = res.body.chat as ChatSummaryDTO;
    expect(chat.type).toBe('dm');
    expect(chat.members.map((m) => m.id)).toEqual([alice.user.id]);
  });

  it('self-DM is idempotent like any other DM', async () => {
    const first = await alice.agent.post('/api/chats').send({ userId: alice.user.id });
    const second = await alice.agent.post('/api/chats').send({ userId: alice.user.id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.chat.id).toBe(first.body.chat.id);
  });

  it('can send and read messages in a self-DM', async () => {
    const chatId = (await alice.agent.post('/api/chats').send({ userId: alice.user.id }))
      .body.chat.id as number;
    const sent = await send(alice, chatId, 'remember the milk');
    expect(sent.status).toBe(201);
    const page = (await alice.agent.get(`/api/chats/${chatId}/messages`)).body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['remember the milk']);
  });

  it('returns 404 for an unknown target user', async () => {
    const res = await alice.agent.post('/api/chats').send({ userId: 999999 });
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/chats').send({ userId: bob.user.id });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/chats — group', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
  });

  it('creates a group and auto-includes the creator (201)', async () => {
    const res = await alice.agent
      .post('/api/chats')
      .send({ name: '  Team  ', memberIds: [bob.user.id, carol.user.id] });
    expect(res.status).toBe(201);
    const chat = res.body.chat as ChatSummaryDTO;
    expect(chat.type).toBe('group');
    expect(chat.name).toBe('Team'); // trimmed
    expect(new Set(chat.members.map((m) => m.id))).toEqual(
      new Set([alice.user.id, bob.user.id, carol.user.id]),
    );
  });

  it('dedupes member ids and the creator', async () => {
    const res = await alice.agent
      .post('/api/chats')
      .send({ name: 'Dup', memberIds: [bob.user.id, bob.user.id, alice.user.id] });
    expect(res.status).toBe(201);
    expect(res.body.chat.members).toHaveLength(2);
  });

  it('rejects an empty name with 400', async () => {
    const res = await alice.agent
      .post('/api/chats')
      .send({ name: '   ', memberIds: [bob.user.id] });
    expect(res.status).toBe(400);
  });

  it('returns 404 when a member id does not exist', async () => {
    const res = await alice.agent
      .post('/api/chats')
      .send({ name: 'Ghosts', memberIds: [bob.user.id, 999999] });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/chats — list', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
  });

  it('orders chats by most recent activity', async () => {
    const a = (
      await alice.agent.post('/api/chats').send({ name: 'A', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const b = (
      await alice.agent.post('/api/chats').send({ name: 'B', memberIds: [bob.user.id] })
    ).body.chat.id as number;

    // A gets a message -> A jumps to the top.
    await send(alice, a, 'hello from A');
    let list = (await alice.agent.get('/api/chats')).body.chats as ChatSummaryDTO[];
    expect(list[0]!.id).toBe(a);

    // Then B gets a message -> B jumps to the top.
    await send(alice, b, 'hello from B');
    list = (await alice.agent.get('/api/chats')).body.chats as ChatSummaryDTO[];
    expect(list[0]!.id).toBe(b);
    expect(list.map((c) => c.id)).toEqual([b, a]);
  });

  it('tracks unread counts (others count, own do not, read clears)', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;

    // Bob sends 3 -> Alice sees 3, Bob sees 0.
    let last = 0;
    for (let i = 0; i < 3; i++) {
      last = (await send(bob, dm, `msg ${i}`)).body.message.id;
    }
    expect((await summary(alice, dm)).unreadCount).toBe(3);
    expect((await summary(bob, dm)).unreadCount).toBe(0);

    // Alice marks read -> 0.
    const read = await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: last });
    expect(read.status).toBe(204);
    expect((await summary(alice, dm)).unreadCount).toBe(0);

    // Alice's own message doesn't count for her, but does for Bob.
    await send(alice, dm, 'hi bob');
    expect((await summary(alice, dm)).unreadCount).toBe(0);
    expect((await summary(bob, dm)).unreadCount).toBe(1);
  });

  it('exposes the last message on each summary', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;
    await send(alice, dm, 'latest');
    const s = await summary(alice, dm);
    expect(s.lastMessage?.content).toBe('latest');
    expect(s.lastMessage?.sender.id).toBe(alice.user.id);
  });

  it('includes each member\'s own lastReadMessageId on the summary', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;

    const ids: number[] = [];
    for (let i = 0; i < 2; i++) ids.push((await send(bob, dm, `m${i}`)).body.message.id);
    // Bob sent both, so his own marker auto-advances to the newest; Alice hasn't read yet.
    let s = await summary(alice, dm);
    const aliceMember = s.members.find((m) => m.id === alice.user.id)!;
    const bobMember = s.members.find((m) => m.id === bob.user.id)!;
    expect(aliceMember.lastReadMessageId).toBe(0);
    expect(bobMember.lastReadMessageId).toBe(ids[1]);

    await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[0] });
    s = await summary(alice, dm);
    expect(s.members.find((m) => m.id === alice.user.id)!.lastReadMessageId).toBe(ids[0]);
  });
});

describe('messages — access, validation, pagination', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let dm: number;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;
  });

  it('stores and echoes the sender timezone, and it survives a history refetch', async () => {
    const res = await alice.agent
      .post(`/api/chats/${dm}/messages`)
      .send({ content: 'remind me at 9', timezone: 'Europe/Vilnius' });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).senderTimezone).toBe('Europe/Vilnius');

    const page = await bob.agent.get(`/api/chats/${dm}/messages`);
    const stored = (page.body.messages as MessageDTO[]).find((m) => m.content === 'remind me at 9')!;
    expect(stored.senderTimezone).toBe('Europe/Vilnius');
  });

  it('sanitizes an invalid timezone to null instead of failing the send', async () => {
    const res = await alice.agent
      .post(`/api/chats/${dm}/messages`)
      .send({ content: 'hi', timezone: 'Mars/Olympus_Mons' });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).senderTimezone).toBeNull();
  });

  it('leaves senderTimezone null when the client sends none', async () => {
    const res = await send(alice, dm, 'no tz here');
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).senderTimezone).toBeNull();
  });

  it('hides the chat from non-members (404 on GET and POST)', async () => {
    const get = await carol.agent.get(`/api/chats/${dm}/messages`);
    expect(get.status).toBe(404);
    expect(get.body.error).toBe('Chat not found');
    const post = await send(carol, dm, 'sneaky');
    expect(post.status).toBe(404);
    // GET /api/chats/:id also hides it.
    expect((await carol.agent.get(`/api/chats/${dm}`)).status).toBe(404);
  });

  it('rejects empty and over-long content with 400', async () => {
    expect((await send(alice, dm, '')).status).toBe(400);
    expect((await send(alice, dm, '   ')).status).toBe(400);
    expect((await send(alice, dm, 'x'.repeat(4001))).status).toBe(400);
    expect((await send(alice, dm, 'ok')).status).toBe(201);
  });

  it('paginates newest-first pages, returned ascending, with a cursor', async () => {
    for (let i = 1; i <= 60; i++) {
      await send(alice, dm, `m${i}`);
    }

    const page1 = (await alice.agent.get(`/api/chats/${dm}/messages`)).body as MessagesPage;
    expect(page1.messages).toHaveLength(50);
    // Ascending (oldest first) within the page.
    expect(page1.messages[0]!.content).toBe('m11');
    expect(page1.messages.at(-1)!.content).toBe('m60');
    const ids = page1.messages.map((m) => m.id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    expect(page1.nextCursor).toBe(page1.messages[0]!.id);

    const page2 = (
      await alice.agent.get(`/api/chats/${dm}/messages`).query({ before: page1.nextCursor })
    ).body as MessagesPage;
    expect(page2.messages).toHaveLength(10);
    expect(page2.messages[0]!.content).toBe('m1');
    expect(page2.messages.at(-1)!.content).toBe('m10');
    expect(page2.nextCursor).toBeNull();
  });

  it('honours a custom limit (capped at 100)', async () => {
    for (let i = 1; i <= 5; i++) await send(alice, dm, `m${i}`);
    const page = (
      await alice.agent.get(`/api/chats/${dm}/messages`).query({ limit: 2 })
    ).body as MessagesPage;
    expect(page.messages).toHaveLength(2);
    expect(page.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('mentions', () => {
  it('drops non-member/duplicate mentions and persists member ones', async () => {
    const app = makeApp();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const carol = await register(app, 'carol@example.com', 'Carol'); // NOT in the group

    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;

    const res = await send(alice, group, 'hey @bob', [
      bob.user.id,
      carol.user.id, // not a member -> dropped
      bob.user.id, // duplicate -> collapsed
      999999, // nonexistent -> dropped
    ]);
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).mentions).toEqual([bob.user.id]);

    // Persisted and returned when reading history.
    const page = (await alice.agent.get(`/api/chats/${group}/messages`))
      .body as MessagesPage;
    expect(page.messages.at(-1)!.mentions).toEqual([bob.user.id]);
  });
});

describe('POST /api/chats/:id/read', () => {
  it('never lets the read marker move backwards', async () => {
    const app = makeApp();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;

    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await send(bob, dm, `m${i}`)).body.message.id);

    await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[2] });
    expect((await summary(alice, dm)).unreadCount).toBe(0);

    // Reading an older id must NOT resurface the newer messages as unread.
    const rewind = await alice.agent
      .post(`/api/chats/${dm}/read`)
      .send({ messageId: ids[0] });
    expect(rewind.status).toBe(204);
    expect((await summary(alice, dm)).unreadCount).toBe(0);
  });
});

describe('POST /api/chats/:id/read — read:updated event', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let dm: number;
  let ids: number[];
  beforeEach(async () => {
    ({ app, events } = makeAppWithEvents());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;
    ids = [];
    for (let i = 0; i < 3; i++) ids.push((await send(bob, dm, `m${i}`)).body.message.id);
  });

  it('emits read:updated with the right payload when the marker actually advances', async () => {
    const updates: ReadUpdatedEvent[] = [];
    events.on('read:updated', (e) => updates.push(e));

    const res = await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[1] });
    expect(res.status).toBe(204);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.chat.id).toBe(dm);
    expect(updates[0]!.userId).toBe(alice.user.id);
    expect(updates[0]!.lastReadMessageId).toBe(ids[1]);
    expect(new Set(updates[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));
  });

  it('does NOT emit on a repeat read of the same id', async () => {
    const updates: ReadUpdatedEvent[] = [];
    events.on('read:updated', (e) => updates.push(e));

    await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[1] });
    expect(updates).toHaveLength(1);

    const res = await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[1] });
    expect(res.status).toBe(204);
    expect(updates).toHaveLength(1); // still just the first
  });

  it('does NOT emit when reading an older/lower id (rewind attempt)', async () => {
    await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[2] });

    const updates: ReadUpdatedEvent[] = [];
    events.on('read:updated', (e) => updates.push(e));

    const res = await alice.agent.post(`/api/chats/${dm}/read`).send({ messageId: ids[0] });
    expect(res.status).toBe(204);
    expect(updates).toHaveLength(0);
  });
});

describe('PATCH /api/chats/:id/members', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  beforeEach(async () => {
    ({ app, events } = makeAppWithEvents());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
  });

  it('adds members and emits chat:updated with the new ids', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;

    const updates: ChatUpdatedEvent[] = [];
    events.on('chat:updated', (e) => updates.push(e));

    const res = await alice.agent
      .patch(`/api/chats/${group}/members`)
      .send({ memberIds: [carol.user.id, bob.user.id] }); // bob already a member
    expect(res.status).toBe(200);
    expect(new Set(res.body.chat.members.map((m: UserDTO) => m.id))).toEqual(
      new Set([alice.user.id, bob.user.id, carol.user.id]),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.addedMemberIds).toEqual([carol.user.id]);
    expect(new Set(updates[0]!.memberIds)).toEqual(
      new Set([alice.user.id, bob.user.id, carol.user.id]),
    );
  });

  it('does nothing (no event) when all ids are already members', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const updates: ChatUpdatedEvent[] = [];
    events.on('chat:updated', (e) => updates.push(e));

    const res = await alice.agent
      .patch(`/api/chats/${group}/members`)
      .send({ memberIds: [bob.user.id] });
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(0);
  });

  it('rejects adding members to a DM with 400', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;
    const res = await alice.agent
      .patch(`/api/chats/${dm}/members`)
      .send({ memberIds: [carol.user.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot add members to a DM');
  });

  it('hides the group from non-members (404)', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const res = await carol.agent
      .patch(`/api/chats/${group}/members`)
      .send({ memberIds: [carol.user.id] });
    expect(res.status).toBe(404);
  });

  it('returns 404 when adding a nonexistent user', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const res = await alice.agent
      .patch(`/api/chats/${group}/members`)
      .send({ memberIds: [999999] });
    expect(res.status).toBe(404);
  });

  it('lets a newly added member read the full pre-join history', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    await send(alice, group, 'before carol 1');
    await send(bob, group, 'before carol 2');

    await alice.agent.patch(`/api/chats/${group}/members`).send({ memberIds: [carol.user.id] });

    const res = await carol.agent.get(`/api/chats/${group}/messages`);
    expect(res.status).toBe(200);
    const page = res.body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['before carol 1', 'before carol 2']);
  });
});

describe('PATCH /api/chats/:id — rename', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  beforeEach(async () => {
    ({ app, events } = makeAppWithEvents());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
  });

  it('renames a group (trimmed) and emits chat:updated', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'Old Name', memberIds: [bob.user.id] })
    ).body.chat.id as number;

    const updates: ChatUpdatedEvent[] = [];
    events.on('chat:updated', (e) => updates.push(e));

    const res = await bob.agent.patch(`/api/chats/${group}`).send({ name: '  New Name  ' });
    expect(res.status).toBe(200);
    expect(res.body.chat.name).toBe('New Name');

    expect(updates).toHaveLength(1);
    expect(updates[0]!.chat.name).toBe('New Name');
    expect(updates[0]!.addedMemberIds).toEqual([]);
    expect(new Set(updates[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));

    // Persisted for everyone.
    expect((await summary(alice, group)).name).toBe('New Name');
  });

  it('rejects renaming a DM with 400', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;
    const res = await alice.agent.patch(`/api/chats/${dm}`).send({ name: 'Us' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot rename a DM');
  });

  it('rejects an empty name with 400', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const res = await alice.agent.patch(`/api/chats/${group}`).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('hides the group from non-members (404)', async () => {
    const carol = await register(app, 'carol@example.com', 'Carol');
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const res = await carol.agent.patch(`/api/chats/${group}`).send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/chats/:id/mute', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let dm: number;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;
  });

  it('mutes for the caller only (204), persisted across GET /api/chats', async () => {
    const res = await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: true });
    expect(res.status).toBe(204);

    // Alice's own summary reflects it; Bob's own view of the same chat does not.
    expect((await summary(alice, dm)).muted).toBe(true);
    expect((await summary(bob, dm)).muted).toBeFalsy();

    const list = (await alice.agent.get('/api/chats')).body.chats as ChatSummaryDTO[];
    expect(list.find((c) => c.id === dm)!.muted).toBe(true);
  });

  it('unmutes (204) and is idempotent — repeating the same value still 204s', async () => {
    await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: true });
    const off = await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: false });
    expect(off.status).toBe(204);
    expect((await summary(alice, dm)).muted).toBe(false);

    const repeat = await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: false });
    expect(repeat.status).toBe(204);
    expect((await summary(alice, dm)).muted).toBe(false);
  });

  it('rejects a non-boolean/missing muted field with 400', async () => {
    expect((await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: 'yes' })).status).toBe(
      400,
    );
    expect((await alice.agent.put(`/api/chats/${dm}/mute`).send({})).status).toBe(400);
  });

  it('hides the chat from non-members (404, no existence leak)', async () => {
    const carol = await register(app, 'carol@example.com', 'Carol');
    const res = await carol.agent.put(`/api/chats/${dm}/mute`).send({ muted: true });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown chat id', async () => {
    const res = await alice.agent.put('/api/chats/999999/mute').send({ muted: true });
    expect(res.status).toBe(404);
  });

  it('survives unrelated message traffic (no accidental reset)', async () => {
    await alice.agent.put(`/api/chats/${dm}/mute`).send({ muted: true });
    await send(bob, dm, 'hello');
    const reply = await send(alice, dm, 'hi back');
    await alice.agent
      .post(`/api/chats/${dm}/read`)
      .send({ messageId: reply.body.message.id });

    expect((await summary(alice, dm)).muted).toBe(true);
  });

  it('requires authentication', async () => {
    const res = await request(app).put(`/api/chats/${dm}/mute`).send({ muted: true });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/chats/:id/leave', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  beforeEach(async () => {
    ({ app, events } = makeAppWithEvents());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
  });

  async function makeGroup(): Promise<number> {
    return (
      await alice.agent
        .post('/api/chats')
        .send({ name: 'G', memberIds: [bob.user.id, carol.user.id] })
    ).body.chat.id as number;
  }

  it('removes the leaver and emits chat:updated with removedMemberIds', async () => {
    const group = await makeGroup();
    const updates: ChatUpdatedEvent[] = [];
    events.on('chat:updated', (e) => updates.push(e));

    const res = await bob.agent.post(`/api/chats/${group}/leave`);
    expect(res.status).toBe(204);

    // Bob is out: the chat 404s for him but still exists for the others.
    expect((await bob.agent.get(`/api/chats/${group}`)).status).toBe(404);
    const forAlice = await summary(alice, group);
    expect(new Set(forAlice.members.map((m) => m.id))).toEqual(
      new Set([alice.user.id, carol.user.id]),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.removedMemberIds).toEqual([bob.user.id]);
    expect(new Set(updates[0]!.memberIds)).toEqual(
      new Set([alice.user.id, carol.user.id]),
    );
    expect(updates[0]!.addedMemberIds).toEqual([]);
  });

  it('deletes the chat when the last member leaves', async () => {
    const group = await makeGroup();
    await bob.agent.post(`/api/chats/${group}/leave`);
    await carol.agent.post(`/api/chats/${group}/leave`);

    const updates: ChatUpdatedEvent[] = [];
    events.on('chat:updated', (e) => updates.push(e));
    const res = await alice.agent.post(`/api/chats/${group}/leave`);
    expect(res.status).toBe(204);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.memberIds).toEqual([]);
    expect(updates[0]!.removedMemberIds).toEqual([alice.user.id]);

    // Gone for good — even re-joining is impossible (the chat no longer exists).
    expect((await alice.agent.get(`/api/chats/${group}`)).status).toBe(404);
    const list = (await alice.agent.get('/api/chats')).body.chats as ChatSummaryDTO[];
    expect(list.find((c) => c.id === group)).toBeUndefined();
  });

  it('rejects leaving a DM with 400', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body
      .chat.id as number;
    const res = await alice.agent.post(`/api/chats/${dm}/leave`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot leave a DM');
  });

  it('hides the group from non-members (404)', async () => {
    const group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] })
    ).body.chat.id as number;
    const res = await carol.agent.post(`/api/chats/${group}/leave`);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const group = await makeGroup();
    const res = await request(app).post(`/api/chats/${group}/leave`);
    expect(res.status).toBe(401);
  });
});

describe('event bus fan-out', () => {
  it('emits chat:new on group creation and message:new on send', async () => {
    const { app, events } = makeAppWithEvents();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');

    const chatNew: ChatNewEvent[] = [];
    const messageNew: MessageNewEvent[] = [];
    events.on('chat:new', (e) => chatNew.push(e));
    events.on('message:new', (e) => messageNew.push(e));

    const group = await alice.agent
      .post('/api/chats')
      .send({ name: 'Team', memberIds: [bob.user.id] });
    expect(group.status).toBe(201);
    const chatId = group.body.chat.id as number;

    expect(chatNew).toHaveLength(1);
    expect(new Set(chatNew[0]!.memberIds)).toEqual(
      new Set([alice.user.id, bob.user.id]),
    );

    const msg = await send(alice, chatId, 'hi team');
    expect(msg.status).toBe(201);
    expect(messageNew).toHaveLength(1);
    expect(messageNew[0]!.message.content).toBe('hi team');
    expect(messageNew[0]!.message.id).toBe(msg.body.message.id);
    expect(new Set(messageNew[0]!.memberIds)).toEqual(
      new Set([alice.user.id, bob.user.id]),
    );
  });

  it('emits chat:new on DM creation but not when returning an existing DM', async () => {
    const { app, events } = makeAppWithEvents();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const chatNew: ChatNewEvent[] = [];
    events.on('chat:new', (e) => chatNew.push(e));

    await alice.agent.post('/api/chats').send({ userId: bob.user.id }); // created
    await alice.agent.post('/api/chats').send({ userId: bob.user.id }); // existing
    expect(chatNew).toHaveLength(1);
  });
});

/** Create a bot owned by `actor`, returning its DTO + one-time apiToken. */
async function createBot(actor: Actor, name: string, webhookUrl?: string) {
  const res = await actor.agent.post('/api/bots').send({ name, webhookUrl });
  return { bot: res.body.bot as UserDTO, apiToken: res.body.apiToken as string };
}

/** Send a message as the bot (inbound API), returning the created MessageDTO. */
async function botSend(
  app: App,
  apiToken: string,
  chatId: number,
  content: string,
  actions?: MessageActionDTO[],
): Promise<MessageDTO> {
  const res = await request(app)
    .post('/api/bot/messages')
    .set('Authorization', `Bearer ${apiToken}`)
    .send({ chatId, content, actions });
  return res.body.message as MessageDTO;
}

describe('POST /api/chats/:id/messages — human send ignores actions', () => {
  it('drops an actions field from a human client (message has no actions)', async () => {
    const app = makeApp();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const chatId = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;

    const res = await alice.agent
      .post(`/api/chats/${chatId}/messages`)
      .send({ content: 'sneaky buttons', actions: [{ id: 'x', label: 'X', style: 'primary' }] });
    // Accepted (old clients shouldn't break) but the actions are simply ignored.
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).actions).toBeUndefined();

    // And nothing was persisted onto the row either.
    const page = await alice.agent.get(`/api/chats/${chatId}/messages`);
    expect((page.body.messages as MessageDTO[]).at(-1)!.actions).toBeUndefined();
  });
});

describe('POST /api/chats/:id/messages/:messageId/actions — tap a bot action', () => {
  let db: Db;
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let groupId: number;
  let bot: UserDTO;
  let apiToken: string;
  let actionMsg: MessageDTO;

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    ({ bot, apiToken } = await createBot(alice, 'Echo Bot', 'https://bot.example.com/webhook'));
    groupId = (
      await alice.agent.post('/api/chats').send({ name: 'Team', memberIds: [bob.user.id, bot.id] })
    ).body.chat.id as number;
    actionMsg = await botSend(app, apiToken, groupId, 'Pick one:', [
      { id: 'yes', label: 'Yes', style: 'primary' },
      { id: 'no', label: 'No', style: 'danger' },
    ]);
  });

  it('204s and emits action:triggered with the actionId, tapper, and message', async () => {
    const triggered: ActionTriggeredEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(204);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.actionId).toBe('yes');
    expect(triggered[0]!.user.id).toBe(alice.user.id);
    expect(triggered[0]!.message.id).toBe(actionMsg.id);
    expect(triggered[0]!.bot.id).toBe(bot.id);
    expect(triggered[0]!.chat.id).toBe(groupId);
  });

  it('lets any member (not just the message recipient) tap', async () => {
    const res = await bob.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'no' });
    expect(res.status).toBe(204);
  });

  it('404s for a non-member (no existence leak) and emits nothing', async () => {
    const mallory = await register(app, 'mallory@example.com', 'Mallory');
    const triggered: ActionTriggeredEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));

    const res = await mallory.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
    expect(triggered).toHaveLength(0);
  });

  it('404s (Chat not found) for an unknown chat id', async () => {
    const res = await alice.agent
      .post(`/api/chats/999999/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('404s (Message not found) when the message is in another chat', async () => {
    const otherId = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;
    const res = await alice.agent
      .post(`/api/chats/${otherId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
  });

  it('404s (Action not found) for an actionId the message does not carry', async () => {
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'maybe' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Action not found');
  });

  it('404s (Action not found) when tapping a human message (no actions)', async () => {
    const human = await send(alice, groupId, 'just text');
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${human.body.message.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Action not found');
  });

  it('400s (Message deleted) once the bot message is a tombstone — actions are dropped', async () => {
    // Bots can't delete via the human endpoint (and have no session), so tombstone
    // the row directly to model a delete; the DTO then drops its actions and the
    // tap must reject before dispatching.
    db.update(messages)
      .set({ deletedAt: new Date() })
      .where(eq(messages.id, actionMsg.id))
      .run();
    const triggered: ActionTriggeredEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message deleted');
    expect(triggered).toHaveLength(0);

    // The tombstone also serializes without actions over the wire.
    const page = await alice.agent.get(`/api/chats/${groupId}/messages`);
    const tomb = (page.body.messages as MessageDTO[]).find((m) => m.id === actionMsg.id)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.actions).toBeUndefined();
  });

  it('400s on an invalid body (empty actionId)', async () => {
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: '' });
    expect(res.status).toBe(400);
  });

  it('400s (Bot unavailable) when the sending bot was deleted (deletedAt set)', async () => {
    // Soft-delete the bot (revokes its token, removes memberships) — its old
    // action message survives but the callback can no longer be delivered.
    await alice.agent.delete(`/api/bots/${bot.id}`);
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bot unavailable');
  });

  it('400s (Bot unavailable) when the sending bot has no webhookUrl', async () => {
    const { bot: silent, apiToken: silentToken } = await createBot(alice, 'Silent Bot');
    await alice.agent.patch(`/api/chats/${groupId}/members`).send({ memberIds: [silent.id] });
    const silentMsg = await botSend(app, silentToken, groupId, 'Pick:', [{ id: 'ok', label: 'OK' }]);

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${silentMsg.id}/actions`)
      .send({ actionId: 'ok' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bot unavailable');
  });

  it('first tap claims the action: 204, persists actionTaken, emits message:updated + webhook', async () => {
    const triggered: ActionTriggeredEvent[] = [];
    const updated: MessageUpdatedEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));
    events.on('message:updated', (e) => updated.push(e));

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(204);

    // The webhook event still fires, and its embedded DTO now carries the record.
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.message.actionTaken).toEqual({ actionId: 'yes', userId: alice.user.id });

    // A message:updated rode the bus carrying the freshly-claimed record so the
    // socket relay can live-swap the buttons for a record line.
    expect(updated).toHaveLength(1);
    expect(updated[0]!.message.id).toBe(actionMsg.id);
    expect(updated[0]!.message.actionTaken).toEqual({ actionId: 'yes', userId: alice.user.id });
    // The buttons persist on the DTO (only the client swaps them for the record).
    expect(updated[0]!.message.actions).toHaveLength(2);

    // GET history shows it persisted; the internal `at` never leaks over the wire.
    const page = await alice.agent.get(`/api/chats/${groupId}/messages`);
    const persisted = (page.body.messages as MessageDTO[]).find((m) => m.id === actionMsg.id)!;
    expect(persisted.actionTaken).toEqual({ actionId: 'yes', userId: alice.user.id });
  });

  it('is one-shot: a second tap by the same member 409s and emits nothing new', async () => {
    const first = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(first.status).toBe(204);

    const triggered: ActionTriggeredEvent[] = [];
    const updated: MessageUpdatedEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));
    events.on('message:updated', (e) => updated.push(e));

    const second = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('Action already taken');
    expect(triggered).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('is one-shot across members AND actions: a different member tapping a different action 409s', async () => {
    await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });

    const res = await bob.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'no' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Action already taken');

    // The original tapper's record is untouched by the rejected second tap.
    const page = await alice.agent.get(`/api/chats/${groupId}/messages`);
    const persisted = (page.body.messages as MessageDTO[]).find((m) => m.id === actionMsg.id)!;
    expect(persisted.actionTaken).toEqual({ actionId: 'yes', userId: alice.user.id });
  });

  it('409s on a lost claim race (column already set out-of-band) and emits nothing', async () => {
    // Simulate a concurrent writer having already won the atomic claim.
    db.update(messages)
      .set({ actionTaken: JSON.stringify({ actionId: 'no', userId: bob.user.id, at: Date.now() }) })
      .where(eq(messages.id, actionMsg.id))
      .run();
    const triggered: ActionTriggeredEvent[] = [];
    const updated: MessageUpdatedEvent[] = [];
    events.on('action:triggered', (e) => triggered.push(e));
    events.on('message:updated', (e) => updated.push(e));

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Action already taken');
    expect(triggered).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post(`/api/chats/${groupId}/messages/${actionMsg.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(401);
  });
});
