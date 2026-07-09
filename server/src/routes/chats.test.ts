import type { ChatSummaryDTO, MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';
import {
  createChatEvents,
  type ChatEvents,
  type ChatNewEvent,
  type ChatUpdatedEvent,
  type MessageNewEvent,
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

  it('rejects a self-DM with 400', async () => {
    const res = await alice.agent.post('/api/chats').send({ userId: alice.user.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot chat with yourself');
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
