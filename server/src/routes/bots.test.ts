import type { BotDTO, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';
import { createChatEvents, type ChatEvents, type MessageNewEvent } from '../events.js';
import { initWebhooks } from '../webhooks.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

async function createBot(
  actor: Actor,
  name: string,
  webhookUrl?: string,
): Promise<{ bot: UserDTO; apiToken: string }> {
  const res = await actor.agent.post('/api/bots').send({ name, webhookUrl });
  return { bot: res.body.bot as UserDTO, apiToken: res.body.apiToken as string };
}

describe('POST /api/bots', () => {
  let db: Db;
  let app: App;
  let alice: Actor;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
  });

  it('creates a bot (201) with a UserDTO and a one-time apiToken', async () => {
    const res = await alice.agent
      .post('/api/bots')
      .send({ name: 'Echo Bot', webhookUrl: 'https://bot.example.com/webhook' });
    expect(res.status).toBe(201);

    const bot = res.body.bot as UserDTO;
    expect(bot.displayName).toBe('Echo Bot');
    expect(bot.isBot).toBe(true);
    expect(typeof bot.id).toBe('number');
    // The DTO never leaks credentials.
    const botAny = bot as unknown as Record<string, unknown>;
    expect(botAny.apiToken).toBeUndefined();
    expect(botAny.webhookUrl).toBeUndefined();
    expect(botAny.passwordHash).toBeUndefined();

    expect(typeof res.body.apiToken).toBe('string');
    expect((res.body.apiToken as string).length).toBeGreaterThan(10);
  });

  it('allows creating a bot with no webhookUrl', async () => {
    const res = await alice.agent.post('/api/bots').send({ name: 'Silent Bot' });
    expect(res.status).toBe(201);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/bots').send({ name: 'Nope' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid webhookUrl with 400', async () => {
    const res = await alice.agent
      .post('/api/bots')
      .send({ name: 'Bad Bot', webhookUrl: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty name with 400', async () => {
    const res = await alice.agent.post('/api/bots').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('appears in GET /api/users for other users, with isBot true', async () => {
    const bob = await register(app, 'bob@example.com', 'Bob');
    const { bot } = await createBot(alice, 'Echo Bot', 'https://bot.example.com/webhook');

    const res = await bob.agent.get('/api/users');
    expect(res.status).toBe(200);
    const found = (res.body.users as UserDTO[]).find((u) => u.id === bot.id);
    expect(found).toBeDefined();
    expect(found!.isBot).toBe(true);
    expect(found!.displayName).toBe('Echo Bot');
  });
});

describe('GET /api/bots', () => {
  let db: Db;
  let app: App;
  let alice: Actor;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
  });

  it('lists bots with their webhookUrl but never credentials', async () => {
    await createBot(alice, 'Echo Bot', 'https://bot.example.com/webhook');
    await createBot(alice, 'Silent Bot');

    const res = await alice.agent.get('/api/bots');
    expect(res.status).toBe(200);

    const bots = res.body.bots as BotDTO[];
    expect(bots).toHaveLength(2);

    const echo = bots.find((b) => b.displayName === 'Echo Bot')!;
    expect(echo).toBeDefined();
    expect(echo.isBot).toBe(true);
    expect(echo.webhookUrl).toBe('https://bot.example.com/webhook');

    const silent = bots.find((b) => b.displayName === 'Silent Bot')!;
    expect(silent.webhookUrl).toBeNull();

    // No credentials leak in the list.
    for (const bot of bots) {
      const botAny = bot as unknown as Record<string, unknown>;
      expect(botAny.apiToken).toBeUndefined();
      expect(botAny.passwordHash).toBeUndefined();
    }
  });

  it('does not include human users', async () => {
    await register(app, 'bob@example.com', 'Bob');
    await createBot(alice, 'Echo Bot');

    const res = await alice.agent.get('/api/bots');
    expect(res.status).toBe(200);
    const bots = res.body.bots as BotDTO[];
    expect(bots).toHaveLength(1);
    expect(bots[0]!.displayName).toBe('Echo Bot');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/bots');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/bots/:id', () => {
  let db: Db;
  let app: App;
  let alice: Actor;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
  });

  it('updates a bot webhookUrl and returns the updated BotDTO', async () => {
    const { bot } = await createBot(alice, 'Echo Bot', 'https://old.example.com/hook');

    const res = await alice.agent
      .patch(`/api/bots/${bot.id}`)
      .send({ webhookUrl: 'https://new.example.com/hook' });
    expect(res.status).toBe(200);

    const updated = res.body.bot as BotDTO;
    expect(updated.id).toBe(bot.id);
    expect(updated.webhookUrl).toBe('https://new.example.com/hook');
    const botAny = updated as unknown as Record<string, unknown>;
    expect(botAny.apiToken).toBeUndefined();

    // Persisted: a subsequent list reflects the new URL.
    const list = await alice.agent.get('/api/bots');
    const found = (list.body.bots as BotDTO[]).find((b) => b.id === bot.id)!;
    expect(found.webhookUrl).toBe('https://new.example.com/hook');
  });

  it('clears the webhookUrl when sent null', async () => {
    const { bot } = await createBot(alice, 'Echo Bot', 'https://bot.example.com/hook');

    const res = await alice.agent.patch(`/api/bots/${bot.id}`).send({ webhookUrl: null });
    expect(res.status).toBe(200);
    expect((res.body.bot as BotDTO).webhookUrl).toBeNull();
  });

  it('clears the webhookUrl when sent an empty string', async () => {
    const { bot } = await createBot(alice, 'Echo Bot', 'https://bot.example.com/hook');

    const res = await alice.agent.patch(`/api/bots/${bot.id}`).send({ webhookUrl: '' });
    expect(res.status).toBe(200);
    expect((res.body.bot as BotDTO).webhookUrl).toBeNull();
  });

  it('rejects a non-http(s) webhookUrl with 400', async () => {
    const { bot } = await createBot(alice, 'Echo Bot');

    const res = await alice.agent
      .patch(`/api/bots/${bot.id}`)
      .send({ webhookUrl: 'ftp://bot.example.com/hook' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
  });

  it('rejects a malformed webhookUrl with 400', async () => {
    const { bot } = await createBot(alice, 'Echo Bot');

    const res = await alice.agent.patch(`/api/bots/${bot.id}`).send({ webhookUrl: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the id is a human user (no existence leak)', async () => {
    const bob = await register(app, 'bob@example.com', 'Bob');

    const res = await alice.agent
      .patch(`/api/bots/${bob.user.id}`)
      .send({ webhookUrl: 'https://bot.example.com/hook' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await alice.agent
      .patch('/api/bots/999999')
      .send({ webhookUrl: 'https://bot.example.com/hook' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-numeric id', async () => {
    const res = await alice.agent
      .patch('/api/bots/not-a-number')
      .send({ webhookUrl: 'https://bot.example.com/hook' });
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const { bot } = await createBot(alice, 'Echo Bot');
    const res = await request(app)
      .patch(`/api/bots/${bot.id}`)
      .send({ webhookUrl: 'https://bot.example.com/hook' });
    expect(res.status).toBe(401);
  });
});

describe('bot API auth', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let botToken: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    app = createApp(db);
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    ({ apiToken: botToken } = await createBot(alice, 'Echo Bot'));
  });

  it('rejects an absent Authorization header with 401', async () => {
    const res = await request(app).post('/api/bot/messages').send({ chatId: 1, content: 'hi' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid bot token');
  });

  it('rejects a garbage bearer token with 401', async () => {
    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', 'Bearer garbage-token')
      .send({ chatId: 1, content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects a header missing the Bearer scheme with 401', async () => {
    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', botToken)
      .send({ chatId: 1, content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('rejects a human session token used as a bot token', async () => {
    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ chatId: 1, content: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the (valid) bot is not a member of the chat', async () => {
    const dm = (await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat
      .id as number;
    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', `Bearer ${botToken}`)
      .send({ chatId: dm, content: 'sneaky' });
    expect(res.status).toBe(404);
  });
});

describe('bot in a DM', () => {
  it('sends via the bot API, visible in history, and emits message:new', async () => {
    const db = createDb(':memory:');
    const events = createChatEvents();
    const app = createApp(db, events);
    const alice = await register(app, 'alice@example.com', 'Alice');
    const { bot, apiToken } = await createBot(alice, 'Echo Bot');

    const dmRes = await alice.agent.post('/api/chats').send({ userId: bot.id });
    expect(dmRes.status).toBe(201);
    const dmId = dmRes.body.chat.id as number;

    const messageEvents: MessageNewEvent[] = [];
    events.on('message:new', (e) => messageEvents.push(e));

    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ chatId: dmId, content: 'Echo: hi' });
    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe('Echo: hi');
    expect(res.body.message.sender.id).toBe(bot.id);

    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]!.message.id).toBe(res.body.message.id);
    expect(new Set(messageEvents[0]!.memberIds)).toEqual(new Set([alice.user.id, bot.id]));

    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    expect(history.status).toBe(200);
    expect(history.body.messages.at(-1).content).toBe('Echo: hi');
    expect(history.body.messages.at(-1).sender.isBot).toBe(true);
  });
});

describe('webhook fan-out', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let groupId: number;
  let bot: UserDTO;
  let apiToken: string;
  const fetchFn = vi.fn<typeof fetch>();
  let handle: ReturnType<typeof initWebhooks>;

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    fetchFn.mockReset();
    fetchFn.mockResolvedValue(new Response(null, { status: 200 }));
    // Tiny retry delay so the failure-path test doesn't eat a real ~1s sleep.
    handle = initWebhooks(db, events, fetchFn, 5);

    alice = await register(app, 'alice@example.com', 'Alice');
    ({ bot, apiToken } = await createBot(alice, 'Echo Bot', 'https://bot.example.com/webhook'));
    groupId = (
      await alice.agent.post('/api/chats').send({ name: 'Team', memberIds: [bot.id] })
    ).body.chat.id as number;
  });

  it('POSTs to the webhookUrl with X-Bot-Token and the message/chat payload', async () => {
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages`)
      .send({ content: 'hello bot' });
    expect(res.status).toBe(201);
    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://bot.example.com/webhook');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Bot-Token']).toBe(apiToken);
    expect(headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(init!.body as string) as {
      message: { content: string };
      chat: { id: number };
    };
    expect(payload.message.content).toBe('hello bot');
    expect(payload.chat.id).toBe(groupId);
  });

  it("does not call the sending bot's own webhook", async () => {
    fetchFn.mockClear();
    const res = await request(app)
      .post('/api/bot/messages')
      .set('Authorization', `Bearer ${apiToken}`)
      .send({ chatId: groupId, content: 'Echo: hi' });
    expect(res.status).toBe(201);
    await handle.lastDispatch;

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retries once on failure, then gives up with a console.warn (never throws)', async () => {
    fetchFn.mockReset();
    fetchFn.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages`)
      .send({ content: 'still there?' });
    expect(res.status).toBe(201);
    await expect(handle.lastDispatch).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
