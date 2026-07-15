import type { MessageActionDTO, MessageDTO, ScheduledMessageDTO, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';
import { createChatEvents, type ChatEvents, type MessageNewEvent, type TypingEvent } from '../events.js';
import { startScheduledDispatcher } from '../scheduled.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

async function createBot(actor: Actor, name: string): Promise<{ bot: UserDTO; apiToken: string }> {
  const res = await actor.agent.post('/api/bots').send({ name });
  return { bot: res.body.bot as UserDTO, apiToken: res.body.apiToken as string };
}

/** Post to the inbound bot API as `apiToken`. */
function botSend(app: App, apiToken: string, body: object) {
  return request(app)
    .post('/api/bot/messages')
    .set('Authorization', `Bearer ${apiToken}`)
    .send(body);
}

/** Bot-API scheduling helpers (Bearer-authenticated). */
function botSchedule(app: App, apiToken: string, body: object) {
  return request(app)
    .post('/api/bot/scheduled')
    .set('Authorization', `Bearer ${apiToken}`)
    .send(body);
}
function botListScheduled(app: App, apiToken: string, chatId: number) {
  return request(app)
    .get(`/api/bot/scheduled?chatId=${chatId}`)
    .set('Authorization', `Bearer ${apiToken}`);
}
function botDeleteScheduled(app: App, apiToken: string, id: number | string) {
  return request(app)
    .delete(`/api/bot/scheduled/${id}`)
    .set('Authorization', `Bearer ${apiToken}`);
}
/** Post a human schedule (session cookie) — used to prove the cap is per-sender. */
function humanSchedule(actor: Actor, chatId: number, body: object) {
  return actor.agent.post(`/api/chats/${chatId}/scheduled`).send(body);
}

/** An ISO string `deltaMs` from now. */
const at = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();
const ONE_HOUR = 60 * 60 * 1000;

describe('POST /api/bot/messages — action buttons', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bot: UserDTO;
  let apiToken: string;
  let dmId: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot, apiToken } = await createBot(alice, 'Echo Bot'));
    dmId = (await alice.agent.post('/api/chats').send({ userId: bot.id })).body.chat.id as number;
  });

  it('accepts valid actions and returns them on the message DTO', async () => {
    const actions: MessageActionDTO[] = [
      { id: 'yes', label: 'Yes', style: 'primary' },
      { id: 'no', label: 'No', style: 'danger' },
      { id: 'meh', label: 'Maybe' },
    ];
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'Pick one:', actions });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).actions).toEqual(actions);
    expect((res.body.message as MessageDTO).sender.id).toBe(bot.id);
  });

  it('persists actions so they survive a history refetch', async () => {
    const actions: MessageActionDTO[] = [{ id: 'ok', label: 'OK' }];
    await botSend(app, apiToken, { chatId: dmId, content: 'ack?', actions });

    const page = await alice.agent.get(`/api/chats/${dmId}/messages`);
    expect(page.status).toBe(200);
    const last = (page.body.messages as MessageDTO[]).at(-1)!;
    expect(last.actions).toEqual(actions);
  });

  it('sends without actions (field absent → no actions on the DTO)', async () => {
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'plain' });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).actions).toBeUndefined();
  });

  it('treats an empty actions array as no actions', async () => {
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'plain', actions: [] });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).actions).toBeUndefined();
  });

  it('rejects more than 6 actions with 400', async () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'too many', actions });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a duplicate action id with 400', async () => {
    const actions = [
      { id: 'dup', label: 'One' },
      { id: 'dup', label: 'Two' },
    ];
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'dupes', actions });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it('rejects an empty action id with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: [{ id: '', label: 'Empty id' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an action id longer than 64 chars with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: [{ id: 'a'.repeat(65), label: 'Long id' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty label with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: [{ id: 'a', label: '' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a label longer than 40 chars with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: [{ id: 'a', label: 'L'.repeat(41) }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown style value with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: [{ id: 'a', label: 'A', style: 'rainbow' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-array actions value with 400', async () => {
    const res = await botSend(app, apiToken, {
      chatId: dmId,
      content: 'x',
      actions: { id: 'a', label: 'A' },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/bot/messages — replies', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bot: UserDTO;
  let apiToken: string;
  let dmId: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot, apiToken } = await createBot(alice, 'Echo Bot'));
    dmId = (await alice.agent.post('/api/chats').send({ userId: bot.id })).body.chat.id as number;
  });

  it('replies to a live message, carrying the replyTo snapshot', async () => {
    const target = (await alice.agent.post(`/api/chats/${dmId}/messages`).send({ content: 'ping' }))
      .body.message as MessageDTO;
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'pong', replyToId: target.id });
    expect(res.status).toBe(201);
    expect((res.body.message as MessageDTO).replyTo?.id).toBe(target.id);
  });

  it('rejects a nonexistent reply target with 400 (not a 404 chat leak)', async () => {
    const res = await botSend(app, apiToken, { chatId: dmId, content: 'x', replyToId: 999999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });
});

describe('bot scheduled messages — /api/bot/scheduled (CRUD + isolation)', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let botA: UserDTO;
  let tokenA: string;
  let botB: UserDTO;
  let tokenB: string;
  // A group with alice + both bots (for isolation), plus a DM alice↔botB (botA
  // is NOT a member — for non-member 404s from botA's perspective).
  let group: number;
  let dmWithoutBotA: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot: botA, apiToken: tokenA } = await createBot(alice, 'Bot A'));
    ({ bot: botB, apiToken: tokenB } = await createBot(alice, 'Bot B'));
    group = (
      await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [botA.id, botB.id] })
    ).body.chat.id as number;
    dmWithoutBotA = (await alice.agent.post('/api/chats').send({ userId: botB.id })).body.chat
      .id as number;
  });

  // ── Auth (mirrors the existing bot-api 401 behavior) ──────────────────────
  it('rejects a missing token with 401', async () => {
    const res = await request(app)
      .post('/api/bot/scheduled')
      .send({ chatId: group, content: 'x', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(401);
  });

  it('rejects a bad token with 401', async () => {
    const res = await request(app)
      .post('/api/bot/scheduled')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ chatId: group, content: 'x', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(401);
  });

  // ── POST ──────────────────────────────────────────────────────────────────
  it('queues a message for a chat the bot belongs to and echoes the DTO', async () => {
    const when = at(ONE_HOUR);
    const res = await botSchedule(app, tokenA, { chatId: group, content: '  soon  ', scheduledAt: when });
    expect(res.status).toBe(201);
    const dto = res.body.scheduled as ScheduledMessageDTO;
    expect(dto.chatId).toBe(group);
    expect(dto.content).toBe('soon'); // trimmed by the shared schema
    expect(dto.replyToId).toBeNull();
    expect(Math.abs(Date.parse(dto.scheduledAt) - Date.parse(when))).toBeLessThan(1000);
  });

  it('requires chatId in the body (400)', async () => {
    const res = await botSchedule(app, tokenA, { content: 'x', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chatId/i);
  });

  it('returns 404 (no leak) when the bot is not a member of chatId', async () => {
    const res = await botSchedule(app, tokenA, {
      chatId: dmWithoutBotA,
      content: 'x',
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('returns 404 for a nonexistent chatId', async () => {
    const res = await botSchedule(app, tokenA, {
      chatId: 999999,
      content: 'x',
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(404);
  });

  // Spot-checks of the shared validation (the human suite covers the full matrix).
  it('rejects empty content (400)', async () => {
    const res = await botSchedule(app, tokenA, { chatId: group, content: '   ', scheduledAt: at(ONE_HOUR) });
    expect(res.status).toBe(400);
  });

  it('rejects a time under 1 minute out (400)', async () => {
    const res = await botSchedule(app, tokenA, {
      chatId: group,
      content: 'too soon',
      scheduledAt: at(30 * 1000),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 1 minute/i);
  });

  it('rejects a reply target from another chat (400)', async () => {
    // A live message in a chat botA is not part of → not a valid reply target.
    const otherMsg = (await alice.agent.post(`/api/chats/${dmWithoutBotA}/messages`).send({ content: 'over here' }))
      .body.message as MessageDTO;
    const res = await botSchedule(app, tokenA, {
      chatId: group,
      content: 'cross-chat',
      replyToId: otherMsg.id,
      scheduledAt: at(ONE_HOUR),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  // ── Cap: keyed per sender, so each bot has its own 20 independent of humans ─
  it('gives each bot its own 20-cap, independent of humans and other bots', async () => {
    // A human fills their own 20-cap in this chat...
    for (let i = 0; i < 20; i++) {
      expect(
        (await humanSchedule(alice, group, { content: `h${i}`, scheduledAt: at(ONE_HOUR) })).status,
      ).toBe(201);
    }
    // ...which does not touch botA's budget: botA queues a full 20 of its own.
    for (let i = 0; i < 20; i++) {
      expect(
        (await botSchedule(app, tokenA, { chatId: group, content: `a${i}`, scheduledAt: at(ONE_HOUR) }))
          .status,
      ).toBe(201);
    }
    // botA's 21st is capped.
    const over = await botSchedule(app, tokenA, {
      chatId: group,
      content: 'over',
      scheduledAt: at(ONE_HOUR),
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/too many/i);
    // botB still has a full budget of its own.
    expect(
      (await botSchedule(app, tokenB, { chatId: group, content: 'b0', scheduledAt: at(ONE_HOUR) }))
        .status,
    ).toBe(201);
  });

  // ── GET ─────────────────────────────────────────────────────────────────
  it('requires the chatId query param (400)', async () => {
    const res = await request(app)
      .get('/api/bot/scheduled')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chatId/i);
  });

  it('returns 404 when the bot is not a member of the queried chat', async () => {
    const res = await botListScheduled(app, tokenA, dmWithoutBotA);
    expect(res.status).toBe(404);
  });

  it('lists the bot’s own rows soonest-first, excluding humans and other bots', async () => {
    await botSchedule(app, tokenA, { chatId: group, content: 'a-third', scheduledAt: at(3 * ONE_HOUR) });
    await botSchedule(app, tokenA, { chatId: group, content: 'a-first', scheduledAt: at(1 * ONE_HOUR) });
    await botSchedule(app, tokenA, { chatId: group, content: 'a-second', scheduledAt: at(2 * ONE_HOUR) });
    // Noise from another bot and a human in the same chat.
    await botSchedule(app, tokenB, { chatId: group, content: 'b-only', scheduledAt: at(ONE_HOUR) });
    await humanSchedule(alice, group, { content: 'human-only', scheduledAt: at(ONE_HOUR) });

    const res = await botListScheduled(app, tokenA, group);
    expect(res.status).toBe(200);
    expect((res.body.scheduled as ScheduledMessageDTO[]).map((s) => s.content)).toEqual([
      'a-first',
      'a-second',
      'a-third',
    ]);
  });

  it('returns an empty list when the bot has nothing scheduled', async () => {
    const res = await botListScheduled(app, tokenA, group);
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toEqual([]);
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────
  it('cancels the bot’s own row (204) and removes it from the list', async () => {
    const dto = (
      await botSchedule(app, tokenA, { chatId: group, content: 'bye', scheduledAt: at(ONE_HOUR) })
    ).body.scheduled as ScheduledMessageDTO;
    const del = await botDeleteScheduled(app, tokenA, dto.id);
    expect(del.status).toBe(204);
    expect((await botListScheduled(app, tokenA, group)).body.scheduled).toEqual([]);
  });

  it('does not let a bot delete another bot’s row (404), leaving it intact', async () => {
    const dto = (
      await botSchedule(app, tokenA, { chatId: group, content: 'mine', scheduledAt: at(ONE_HOUR) })
    ).body.scheduled as ScheduledMessageDTO;
    const del = await botDeleteScheduled(app, tokenB, dto.id);
    expect(del.status).toBe(404);
    expect((await botListScheduled(app, tokenA, group)).body.scheduled.map((s: ScheduledMessageDTO) => s.id)).toEqual([
      dto.id,
    ]);
  });

  it('does not let a bot delete a human’s row (404)', async () => {
    const dto = (await humanSchedule(alice, group, { content: 'human', scheduledAt: at(ONE_HOUR) }))
      .body.scheduled as ScheduledMessageDTO;
    const del = await botDeleteScheduled(app, tokenA, dto.id);
    expect(del.status).toBe(404);
    // The human's row survives.
    expect((await humanSchedule(alice, group, { content: 'check', scheduledAt: at(ONE_HOUR) })).status).toBe(
      201,
    );
  });

  it('returns 404 for a nonexistent scheduled id', async () => {
    const del = await botDeleteScheduled(app, tokenA, 999999);
    expect(del.status).toBe(404);
  });
});

describe('bot scheduled messages — end-to-end dispatch', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bot: UserDTO;
  let apiToken: string;
  let dmId: number;
  let seen: MessageNewEvent[];

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    seen = [];
    events.on('message:new', (e) => seen.push(e));
    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot, apiToken } = await createBot(alice, 'Echo Bot'));
    dmId = (await alice.agent.post('/api/chats').send({ userId: bot.id })).body.chat.id as number;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a bot-scheduled message: bot is the sender, fans out on the bus, lands in history', async () => {
    // Schedule ~90s out (clears the 60s minimum even after request latency).
    const res = await botSchedule(app, apiToken, {
      chatId: dmId,
      content: 'later, from a bot',
      scheduledAt: at(90 * 1000),
    });
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(0); // scheduling does NOT send yet

    // A fake-timer dispatcher tick past the due time sends it exactly like a
    // live send — the dispatcher treats the bot sender like any other member.
    vi.useFakeTimers();
    const handle = startScheduledDispatcher(db, events, 30 * 1000);
    vi.advanceTimersByTime(2 * 60 * 1000);
    handle.stop();
    vi.useRealTimers();

    // Fanned out on the shared bus, with the bot as the sender.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message.content).toBe('later, from a bot');
    expect(seen[0]!.message.sender.id).toBe(bot.id);
    expect(seen[0]!.message.sender.isBot).toBe(true);
    expect(new Set(seen[0]!.memberIds)).toEqual(new Set([alice.user.id, bot.id]));

    // And it lands in real history for the human member.
    const page = await alice.agent.get(`/api/chats/${dmId}/messages`);
    expect((page.body.messages as MessageDTO[]).map((m) => m.content)).toContain('later, from a bot');
  });
});

describe('POST /api/bot/typing', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bot: UserDTO;
  let apiToken: string;
  let dmId: number;

  function botTyping(token: string, body: object) {
    return request(app)
      .post('/api/bot/typing')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot, apiToken } = await createBot(alice, 'Reminder'));
    dmId = (await alice.agent.post('/api/chats').send({ userId: bot.id })).body.chat.id as number;
  });

  it('emits a typing bus event with the full member list and returns 204', async () => {
    const seen: TypingEvent[] = [];
    events.on('typing', (e) => seen.push(e));

    const res = await botTyping(apiToken, { chatId: dmId });

    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userId).toBe(bot.id);
    expect(seen[0]!.chat.id).toBe(dmId);
    expect(new Set(seen[0]!.memberIds)).toEqual(new Set([alice.user.id, bot.id]));
  });

  it('requires chatId (400)', async () => {
    const res = await botTyping(apiToken, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('chatId is required');
  });

  it('returns 404 (no leak) for a chat the bot is not a member of', async () => {
    const bob = await register(app, 'bob@example.com', 'Bob');
    const otherDm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;

    const seen: TypingEvent[] = [];
    events.on('typing', (e) => seen.push(e));

    const res = await botTyping(apiToken, { chatId: otherDm });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
    expect(seen).toHaveLength(0);
  });

  it('rejects a bad token with 401', async () => {
    const res = await botTyping('garbage', { chatId: dmId });
    expect(res.status).toBe(401);
  });
});
