import type { MessageActionDTO, MessageDTO, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';

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
