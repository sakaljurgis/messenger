import type { MessageDTO, SearchResponse, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

function makeApp(): App {
  return createApp(createDb(':memory:'));
}

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

async function dm(a: Actor, b: Actor): Promise<number> {
  return (await a.agent.post('/api/chats').send({ userId: b.user.id })).body.chat.id as number;
}

async function send(actor: Actor, chatId: number, content: string, mentions?: number[]) {
  return actor.agent.post(`/api/chats/${chatId}/messages`).send({ content, mentions });
}

async function search(actor: Actor, q: string, extra: Record<string, unknown> = {}) {
  return actor.agent.get('/api/search').query({ q, ...extra });
}

describe('GET /api/search — basics', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let chat: number;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    chat = await dm(alice, bob);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/search').query({ q: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for empty / whitespace q', async () => {
    expect((await search(alice, '')).status).toBe(400);
    expect((await search(alice, '   ')).status).toBe(400);
    expect((await alice.agent.get('/api/search')).status).toBe(400); // missing q entirely
  });

  it('finds messages by whole word and by prefix', async () => {
    await send(alice, chat, 'the quick brown fox');
    await send(bob, chat, 'wonderful weather today');

    const whole = (await search(alice, 'brown')).body as SearchResponse;
    expect(whole.messages.map((m) => m.content)).toEqual(['the quick brown fox']);

    // Prefix: "wond" matches "wonderful".
    const prefix = (await search(alice, 'wond')).body as SearchResponse;
    expect(prefix.messages.map((m) => m.content)).toEqual(['wonderful weather today']);
  });

  it('multiple terms are AND-combined (all must match)', async () => {
    await send(alice, chat, 'alpha beta gamma');
    await send(alice, chat, 'alpha delta');
    const res = (await search(alice, 'alpha beta')).body as SearchResponse;
    expect(res.messages.map((m) => m.content)).toEqual(['alpha beta gamma']);
  });

  it('returns matches newest-first with cursor pagination', async () => {
    for (let i = 1; i <= 5; i++) await send(alice, chat, `apple number ${i}`);
    const page1 = (await search(alice, 'apple', { limit: 2 })).body as SearchResponse;
    expect(page1.messages.map((m) => m.content)).toEqual(['apple number 5', 'apple number 4']);
    expect(page1.nextCursor).toBe(page1.messages.at(-1)!.id);

    const page2 = (await search(alice, 'apple', { limit: 2, before: page1.nextCursor })).body as SearchResponse;
    expect(page2.messages.map((m) => m.content)).toEqual(['apple number 3', 'apple number 2']);

    const page3 = (await search(alice, 'apple', { limit: 2, before: page2.nextCursor })).body as SearchResponse;
    expect(page3.messages.map((m) => m.content)).toEqual(['apple number 1']);
    expect(page3.nextCursor).toBeNull();
  });

  it('assembles reactions, replyTo and attachments identically to the history endpoint', async () => {
    const original = (await send(alice, chat, 'searchable original')).body.message as MessageDTO;
    // React to the original.
    await bob.agent.post(`/api/chats/${chat}/messages/${original.id}/reactions`).send({ emoji: '👍' });
    // Reply to it.
    await bob.agent
      .post(`/api/chats/${chat}/messages`)
      .send({ content: 'searchable reply', replyToId: original.id });

    const originalHit = (await search(alice, 'original')).body as SearchResponse;
    expect(originalHit.messages).toHaveLength(1);
    expect(originalHit.messages[0]!.reactions).toEqual([{ emoji: '👍', userIds: [bob.user.id] }]);

    const replyHit = (await search(alice, 'reply')).body as SearchResponse;
    expect(replyHit.messages).toHaveLength(1);
    expect(replyHit.messages[0]!.replyTo).toMatchObject({
      id: original.id,
      content: 'searchable original',
      isDeleted: false,
    });
  });
});

describe('GET /api/search — security: no cross-chat leakage', () => {
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

  it('never returns messages from a chat the searcher is not a member of', async () => {
    const aliceBob = await dm(alice, bob);
    await send(alice, aliceBob, 'topsecret pineapple plans');

    // Carol is not a member of alice<->bob. She must find nothing.
    const carolView = (await search(carol, 'topsecret')).body as SearchResponse;
    expect(carolView.messages).toEqual([]);
    expect(carolView.nextCursor).toBeNull();
    const carolPineapple = (await search(carol, 'pineapple')).body as SearchResponse;
    expect(carolPineapple.messages).toEqual([]);

    // Both members can find it.
    expect(((await search(alice, 'topsecret')).body as SearchResponse).messages).toHaveLength(1);
    expect(((await search(bob, 'topsecret')).body as SearchResponse).messages).toHaveLength(1);
  });

  it('only returns the searcher own matches when the same word exists in two disjoint chats', async () => {
    const aliceBob = await dm(alice, bob);
    const carolChat = await dm(carol, carol); // carol's notes-to-self
    await send(alice, aliceBob, 'shared keyword from alice');
    const carolMsg = (await send(carol, carolChat, 'shared keyword from carol')).body
      .message as MessageDTO;

    const carolHits = (await search(carol, 'keyword')).body as SearchResponse;
    expect(carolHits.messages.map((m) => m.id)).toEqual([carolMsg.id]);
    expect(carolHits.messages[0]!.content).toBe('shared keyword from carol');
  });

  it('after leaving a group, past messages stop matching', async () => {
    const group = (
      await alice.agent
        .post('/api/chats')
        .send({ name: 'G', memberIds: [bob.user.id, carol.user.id] })
    ).body.chat.id as number;
    await send(alice, group, 'groupsecret discussed here');
    // Carol can see it while a member.
    expect(((await search(carol, 'groupsecret')).body as SearchResponse).messages).toHaveLength(1);
    // She leaves; the message must no longer be searchable for her.
    await carol.agent.post(`/api/chats/${group}/leave`);
    expect(((await search(carol, 'groupsecret')).body as SearchResponse).messages).toEqual([]);
    // Alice (still a member) can still find it.
    expect(((await search(alice, 'groupsecret')).body as SearchResponse).messages).toHaveLength(1);
  });
});

describe('GET /api/search — tombstones excluded', () => {
  it('a soft-deleted message never matches', async () => {
    const app = makeApp();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const chat = await dm(alice, bob);

    const msg = (await send(alice, chat, 'ephemeral deletable content')).body.message as MessageDTO;
    expect(((await search(alice, 'deletable')).body as SearchResponse).messages).toHaveLength(1);

    await alice.agent.delete(`/api/chats/${chat}/messages/${msg.id}`);
    const after = (await search(alice, 'deletable')).body as SearchResponse;
    expect(after.messages).toEqual([]);
    expect(after.nextCursor).toBeNull();
  });

  it('an edited message matches its new text, not the old', async () => {
    const app = makeApp();
    const alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    const chat = await dm(alice, bob);

    const msg = (await send(alice, chat, 'originalword here')).body.message as MessageDTO;
    await alice.agent
      .patch(`/api/chats/${chat}/messages/${msg.id}`)
      .send({ content: 'replacementword here' });

    expect(((await search(alice, 'originalword')).body as SearchResponse).messages).toEqual([]);
    expect(((await search(alice, 'replacementword')).body as SearchResponse).messages).toHaveLength(1);
  });
});

describe('GET /api/search — hostile input is sanitized (never 500s)', () => {
  let app: App;
  let alice: Actor;
  let chat: number;
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    const bob = await register(app, 'bob@example.com', 'Bob');
    chat = await dm(alice, bob);
  });

  it.each([
    ['"); DROP TABLE messages;--'],
    ['foo* (bar) "baz"'],
    ['-hello'],
    ['NEAR(a b)'],
    ['col:value'],
    ['***'],
    ['((()))'],
    ['a AND b OR c'],
    ['"""""'],
    ['^caret'],
  ])('handles %j without error', async (q) => {
    const res = await search(alice, q);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as SearchResponse).messages)).toBe(true);
  });

  it('quoted operators are treated as literal text, not FTS operators', async () => {
    // A message literally containing the word "NEAR" is matched by searching NEAR,
    // and the input is not interpreted as the NEAR() operator.
    await send(alice, chat, 'sit NEAR the window');
    const res = (await search(alice, 'NEAR')).body as SearchResponse;
    expect(res.messages.map((m) => m.content)).toEqual(['sit NEAR the window']);
  });

  it('a query that reduces to no usable terms returns an empty result set (not 400)', async () => {
    await send(alice, chat, 'anything at all');
    const res = await search(alice, '"""');
    expect(res.status).toBe(200);
    expect((res.body as SearchResponse).messages).toEqual([]);
    expect((res.body as SearchResponse).nextCursor).toBeNull();
  });
});
