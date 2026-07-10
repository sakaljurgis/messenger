import type { MessageDTO, ScheduledMessageDTO, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';
import { createChatEvents } from '../events.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

function makeApp(): App {
  return createApp(createDb(':memory:'), createChatEvents());
}

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

async function makeDm(a: Actor, b: Actor): Promise<number> {
  return (await a.agent.post('/api/chats').send({ userId: b.user.id })).body.chat.id as number;
}

async function makeGroup(a: Actor, memberIds: number[]): Promise<number> {
  return (await a.agent.post('/api/chats').send({ name: 'G', memberIds })).body.chat.id as number;
}

async function send(actor: Actor, chatId: number, content: string): Promise<MessageDTO> {
  return (await actor.agent.post(`/api/chats/${chatId}/messages`).send({ content })).body
    .message as MessageDTO;
}

/** An ISO string `deltaMs` from now. */
const at = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();
const ONE_HOUR = 60 * 60 * 1000;

/** POST a schedule; returns the raw supertest response so status can be asserted. */
function schedule(
  actor: Actor,
  chatId: number,
  body: Record<string, unknown>,
) {
  return actor.agent.post(`/api/chats/${chatId}/scheduled`).send(body);
}

async function listScheduled(actor: Actor, chatId: number): Promise<ScheduledMessageDTO[]> {
  return (await actor.agent.get(`/api/chats/${chatId}/scheduled`)).body
    .scheduled as ScheduledMessageDTO[];
}

describe('scheduled messages — POST /api/chats/:id/scheduled', () => {
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
    dm = await makeDm(alice, bob);
  });

  it('queues a message and echoes the DTO', async () => {
    const when = at(ONE_HOUR);
    const res = await schedule(alice, dm, { content: '  hi later  ', scheduledAt: when });
    expect(res.status).toBe(201);
    const dto = res.body.scheduled as ScheduledMessageDTO;
    expect(dto.chatId).toBe(dm);
    expect(dto.content).toBe('hi later'); // trimmed
    expect(dto.mentions).toEqual([]);
    expect(dto.replyToId).toBeNull();
    // The column is a `timestamp` (second-granularity), so the echoed ISO is the
    // request time floored to the second — same instant to within 1s.
    expect(Math.abs(Date.parse(dto.scheduledAt) - Date.parse(when))).toBeLessThan(1000);
    expect(typeof dto.createdAt).toBe('string');
  });

  it('stores deduped mentions and a valid reply target', async () => {
    const group = await makeGroup(alice, [bob.user.id, carol.user.id]);
    const target = await send(alice, group, 'original');
    const res = await schedule(alice, group, {
      content: 'reply later @bob',
      mentions: [bob.user.id, bob.user.id, carol.user.id],
      replyToId: target.id,
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(201);
    const dto = res.body.scheduled as ScheduledMessageDTO;
    expect(dto.mentions).toEqual([bob.user.id, carol.user.id]);
    expect(dto.replyToId).toBe(target.id);
  });

  it('rejects empty content (400)', async () => {
    const res = await schedule(alice, dm, { content: '   ', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(400);
  });

  it('rejects content over 4000 chars (400)', async () => {
    const res = await schedule(alice, dm, { content: 'x'.repeat(4001), scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(400);
  });

  it('rejects an unparseable scheduledAt (400)', async () => {
    const res = await schedule(alice, dm, { content: 'hi', scheduledAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid scheduled time');
  });

  it('rejects a time under 1 minute in the future (400)', async () => {
    const res = await schedule(alice, dm, { content: 'hi', scheduledAt: at(30 * 1000) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 1 minute/i);
  });

  it('rejects a time in the past (400)', async () => {
    const res = await schedule(alice, dm, { content: 'hi', scheduledAt: at(-ONE_HOUR) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 1 minute/i);
  });

  it('rejects a time more than 1 year out (400)', async () => {
    const res = await schedule(alice, dm, { content: 'hi', scheduledAt: at(366 * 24 * ONE_HOUR) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/within 1 year/i);
  });

  it('accepts a time just inside 1 minute (201)', async () => {
    // 90s out clears the 60s minimum even after request latency.
    const res = await schedule(alice, dm, { content: 'hi', scheduledAt: at(90 * 1000) });
    expect(res.status).toBe(201);
  });

  it('returns 404 for a non-member (no existence leak)', async () => {
    const res = await schedule(carol, dm, { content: 'hi', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('returns 404 for a nonexistent chat', async () => {
    const res = await schedule(alice, 999999, { content: 'hi', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(404);
  });

  it('rejects a nonexistent reply target (400 Invalid reply target)', async () => {
    const res = await schedule(alice, dm, {
      content: 'hi',
      replyToId: 999999,
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('rejects a reply target from another chat (400)', async () => {
    const other = await makeGroup(alice, [carol.user.id]); // bob not a member
    const otherMsg = await send(alice, other, 'over here');
    const res = await schedule(alice, dm, {
      content: 'cross-chat',
      replyToId: otherMsg.id,
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('rejects a reply to a tombstoned message (400)', async () => {
    const target = await send(alice, dm, 'delete me');
    await alice.agent.delete(`/api/chats/${dm}/messages/${target.id}`);
    const res = await schedule(alice, dm, {
      content: 'hi',
      replyToId: target.id,
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('caps pending rows at 20 per user per chat (400 on the 21st)', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await schedule(alice, dm, { content: `m${i}`, scheduledAt: at(ONE_HOUR) });
      expect(res.status).toBe(201);
    }
    const over = await schedule(alice, dm, { content: 'too many', scheduledAt: at(ONE_HOUR) });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/too many/i);

    // The cap is per chat: another chat is unaffected.
    const dm2 = await makeDm(alice, carol);
    expect((await schedule(alice, dm2, { content: 'fresh', scheduledAt: at(ONE_HOUR) })).status).toBe(
      201,
    );
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post(`/api/chats/${dm}/scheduled`)
      .send({ content: 'hi', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(401);
  });
});

describe('scheduled messages — GET /api/chats/:id/scheduled (mine only)', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let group: number;

  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    group = await makeGroup(alice, [bob.user.id, carol.user.id]);
  });

  it('lists my rows for the chat, soonest first', async () => {
    await schedule(alice, group, { content: 'third', scheduledAt: at(3 * ONE_HOUR) });
    await schedule(alice, group, { content: 'first', scheduledAt: at(1 * ONE_HOUR) });
    await schedule(alice, group, { content: 'second', scheduledAt: at(2 * ONE_HOUR) });

    const mine = await listScheduled(alice, group);
    expect(mine.map((s) => s.content)).toEqual(['first', 'second', 'third']);
  });

  it('never returns another user’s scheduled rows (per-user isolation)', async () => {
    await schedule(alice, group, { content: 'alice-only', scheduledAt: at(ONE_HOUR) });
    await schedule(bob, group, { content: 'bob-only', scheduledAt: at(ONE_HOUR) });

    const aliceList = await listScheduled(alice, group);
    expect(aliceList.map((s) => s.content)).toEqual(['alice-only']);

    const bobList = await listScheduled(bob, group);
    expect(bobList.map((s) => s.content)).toEqual(['bob-only']);
  });

  it('is scoped to the chat (rows from another chat are excluded)', async () => {
    const dm = await makeDm(alice, bob);
    await schedule(alice, group, { content: 'in-group', scheduledAt: at(ONE_HOUR) });
    await schedule(alice, dm, { content: 'in-dm', scheduledAt: at(ONE_HOUR) });

    expect((await listScheduled(alice, group)).map((s) => s.content)).toEqual(['in-group']);
    expect((await listScheduled(alice, dm)).map((s) => s.content)).toEqual(['in-dm']);
  });

  it('returns 404 for a non-member', async () => {
    const dm = await makeDm(alice, bob); // carol is not in this DM
    const res = await carol.agent.get(`/api/chats/${dm}/scheduled`);
    expect(res.status).toBe(404);
  });

  it('returns an empty array when there are none', async () => {
    expect(await listScheduled(alice, group)).toEqual([]);
  });
});

describe('scheduled messages — DELETE /api/chats/:id/scheduled/:scheduledId (mine only)', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let group: number;

  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    group = await makeGroup(alice, [bob.user.id]);
  });

  it('cancels my own row (204) and removes it from the list', async () => {
    const dto = (await schedule(alice, group, { content: 'bye', scheduledAt: at(ONE_HOUR) })).body
      .scheduled as ScheduledMessageDTO;
    const del = await alice.agent.delete(`/api/chats/${group}/scheduled/${dto.id}`);
    expect(del.status).toBe(204);
    expect(await listScheduled(alice, group)).toEqual([]);
  });

  it('does not let another member cancel my row (404), leaving it intact', async () => {
    const dto = (await schedule(alice, group, { content: 'mine', scheduledAt: at(ONE_HOUR) })).body
      .scheduled as ScheduledMessageDTO;
    const del = await bob.agent.delete(`/api/chats/${group}/scheduled/${dto.id}`);
    expect(del.status).toBe(404);
    expect((await listScheduled(alice, group)).map((s) => s.id)).toEqual([dto.id]);
  });

  it('returns 404 for a nonexistent scheduled id', async () => {
    const del = await alice.agent.delete(`/api/chats/${group}/scheduled/999999`);
    expect(del.status).toBe(404);
  });

  it('returns 404 when the requester is not a chat member', async () => {
    const carol = await register(app, 'carol@example.com', 'Carol');
    const dto = (await schedule(alice, group, { content: 'x', scheduledAt: at(ONE_HOUR) })).body
      .scheduled as ScheduledMessageDTO;
    const del = await carol.agent.delete(`/api/chats/${group}/scheduled/${dto.id}`);
    expect(del.status).toBe(404);
  });
});
