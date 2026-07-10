import type { MessageActionDTO, MessageDTO, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createDb, type Db } from './db/index.js';
import { createChatEvents, type ChatEvents } from './events.js';
import { initWebhooks } from './webhooks.js';

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

describe('webhook action fan-out', () => {
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

  it('POSTs an action payload to the bot webhook when a member taps a button', async () => {
    const actions: MessageActionDTO[] = [{ id: 'yes', label: 'Yes', style: 'primary' }];
    const message = await botSend(app, apiToken, groupId, 'Pick:', actions);
    // The bot's own send never webhooks the bot; start the assertion clean.
    fetchFn.mockClear();

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${message.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(204);
    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://bot.example.com/webhook');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Bot-Token']).toBe(apiToken);
    expect(headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(init!.body as string) as {
      type: string;
      action: { id: string };
      message: MessageDTO;
      user: UserDTO;
      chatId: number;
    };
    expect(payload.type).toBe('action');
    expect(payload.action).toEqual({ id: 'yes' });
    expect(payload.chatId).toBe(groupId);
    expect(payload.message.id).toBe(message.id);
    expect(payload.message.actions).toEqual(actions);
    // The tapper, as a UserDTO (no credentials leak).
    expect(payload.user.id).toBe(alice.user.id);
    expect(payload.user).not.toHaveProperty('apiToken');
    expect(payload.user).not.toHaveProperty('passwordHash');
  });

  it('retries once on failure, then gives up with a console.warn (never throws)', async () => {
    const message = await botSend(app, apiToken, groupId, 'Pick:', [{ id: 'yes', label: 'Yes' }]);
    fetchFn.mockReset();
    fetchFn.mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${message.id}/actions`)
      .send({ actionId: 'yes' });
    expect(res.status).toBe(204);
    await expect(handle.lastDispatch).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not dispatch a rejected tap (unknown actionId → 404, no webhook)', async () => {
    const message = await botSend(app, apiToken, groupId, 'Pick:', [{ id: 'yes', label: 'Yes' }]);
    fetchFn.mockClear();

    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages/${message.id}/actions`)
      .send({ actionId: 'nope' });
    expect(res.status).toBe(404);
    await handle.lastDispatch;
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps the existing message webhook payload byte-identical (no type field)', async () => {
    const res = await alice.agent
      .post(`/api/chats/${groupId}/messages`)
      .send({ content: 'hello bot' });
    expect(res.status).toBe(201);
    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://bot.example.com/webhook');
    const payload = JSON.parse(init!.body as string) as Record<string, unknown>;
    // Exactly { message, chat } — the message webhook is not tagged with a type.
    expect(Object.keys(payload).sort()).toEqual(['chat', 'message']);
    expect(payload).not.toHaveProperty('type');
    expect((payload.message as MessageDTO).content).toBe('hello bot');
    expect((payload.chat as { id: number }).id).toBe(groupId);
  });
});
