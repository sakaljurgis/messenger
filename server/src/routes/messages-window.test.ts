import type { MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
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

async function send(actor: Actor, chatId: number, content: string): Promise<MessageDTO> {
  return (await actor.agent.post(`/api/chats/${chatId}/messages`).send({ content })).body
    .message as MessageDTO;
}

/** Send m1..mN, returning the created message ids in order. */
async function seed(actor: Actor, chatId: number, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) ids.push((await send(actor, chatId, `m${i}`)).id);
  return ids;
}

async function getMessages(actor: Actor, chatId: number, query: Record<string, unknown> = {}) {
  return actor.agent.get(`/api/chats/${chatId}/messages`).query(query);
}

describe('GET messages — default & ?before= remain byte-compatible', () => {
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

  it('the default (no param) page omits newerCursor entirely', async () => {
    await seed(alice, chat, 3);
    const res = await getMessages(alice, chat);
    expect(res.status).toBe(200);
    expect('newerCursor' in res.body).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it('a ?before= page omits newerCursor entirely', async () => {
    await seed(alice, chat, 60);
    const page1 = (await getMessages(alice, chat)).body as MessagesPage;
    const res = await getMessages(alice, chat, { before: page1.nextCursor });
    expect('newerCursor' in res.body).toBe(false);
  });
});

describe('GET messages — ?around=', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let chat: number;
  let ids: number[];
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    chat = await dm(alice, bob);
    ids = await seed(alice, chat, 20); // ids[i] === message "m{i+1}"
  });

  it('centres a window on the target with both cursors set', async () => {
    const target = ids[9]!; // m10
    const page = (await getMessages(alice, chat, { around: target, limit: 7 })).body as MessagesPage;
    // 3 older + target + 3 newer, ascending.
    expect(page.messages.map((m) => m.content)).toEqual([
      'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13',
    ]);
    expect(page.nextCursor).toBe(ids[6]); // m7 (older remain: m1..m6)
    expect(page.newerCursor).toBe(ids[12]); // m13 (newer remain: m14..m20)
  });

  it('nextCursor walks backward to exhaustion; newerCursor walks forward to exhaustion', async () => {
    const first = (await getMessages(alice, chat, { around: ids[9], limit: 7 }))
      .body as MessagesPage;

    // Backward via ?before=nextCursor.
    const older = (await getMessages(alice, chat, { before: first.nextCursor })).body as MessagesPage;
    expect(older.messages.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(older.nextCursor).toBeNull();

    // Forward via ?after=newerCursor.
    const newer = (await getMessages(alice, chat, { after: first.newerCursor })).body as MessagesPage;
    expect(newer.messages.map((m) => m.content)).toEqual([
      'm14', 'm15', 'm16', 'm17', 'm18', 'm19', 'm20',
    ]);
    expect(newer.newerCursor).toBeNull(); // reached the present
  });

  it('null newerCursor when the target is the newest message', async () => {
    const page = (await getMessages(alice, chat, { around: ids[19], limit: 7 }))
      .body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['m17', 'm18', 'm19', 'm20']);
    expect(page.newerCursor).toBeNull();
    expect(page.nextCursor).toBe(ids[16]); // m17
  });

  it('null nextCursor when the target is the oldest message', async () => {
    const page = (await getMessages(alice, chat, { around: ids[0], limit: 7 }))
      .body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(page.nextCursor).toBeNull();
    expect(page.newerCursor).toBe(ids[3]); // m4
  });

  it('limit=1 returns just the target with both cursors reflecting neighbours', async () => {
    const page = (await getMessages(alice, chat, { around: ids[9], limit: 1 }))
      .body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['m10']);
    expect(page.nextCursor).toBe(ids[9]); // older exist below m10
    expect(page.newerCursor).toBe(ids[9]); // newer exist above m10
  });

  it('404 when the target id is not in this chat', async () => {
    // A message that does not exist at all.
    expect((await getMessages(alice, chat, { around: 999999 })).status).toBe(404);

    // A message that exists but in a DIFFERENT chat (a separate group) — the
    // searcher is a member of both, but the id isn't in `chat`.
    const group = (await alice.agent.post('/api/chats').send({ name: 'G', memberIds: [bob.user.id] }))
      .body.chat.id as number;
    const elsewhere = await send(alice, group, 'over here');
    const res = await getMessages(alice, chat, { around: elsewhere.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
  });

  it('a non-member gets 404 (chat-level, no existence leak)', async () => {
    const carol = await register(app, 'carol@example.com', 'Carol');
    const res = await getMessages(carol, chat, { around: ids[5] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });
});

describe('GET messages — ?after=', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let chat: number;
  let ids: number[];
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    chat = await dm(alice, bob);
    ids = await seed(alice, chat, 12);
  });

  it('returns the oldest messages strictly newer than the cursor, ascending', async () => {
    const page = (await getMessages(alice, chat, { after: ids[4], limit: 3 })).body as MessagesPage;
    expect(page.messages.map((m) => m.content)).toEqual(['m6', 'm7', 'm8']);
    expect(page.newerCursor).toBe(ids[7]); // m8, more newer remain
    expect(page.nextCursor).toBe(ids[5]); // m6, older continuation available
  });

  it('walks forward to the present, ending with newerCursor null', async () => {
    let cursor: number | null | undefined = ids[4]!; // start after m5
    const collected: string[] = [];
    for (let guard = 0; guard < 20 && cursor != null; guard++) {
      const page: MessagesPage = (await getMessages(alice, chat, { after: cursor, limit: 3 }))
        .body as MessagesPage;
      collected.push(...page.messages.map((m) => m.content));
      if (page.newerCursor == null) {
        cursor = null;
      } else {
        cursor = page.newerCursor;
      }
    }
    expect(collected).toEqual(['m6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12']);
  });

  it('after the newest message returns an empty page', async () => {
    const page = (await getMessages(alice, chat, { after: ids[11] })).body as MessagesPage;
    expect(page.messages).toEqual([]);
    expect(page.newerCursor).toBeNull();
    expect(page.nextCursor).toBeNull();
  });
});

describe('GET messages — before/after/around mutual exclusion', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let chat: number;
  let ids: number[];
  beforeEach(async () => {
    app = makeApp();
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    chat = await dm(alice, bob);
    ids = await seed(alice, chat, 5);
  });

  it.each([
    [{ before: 1, after: 2 }],
    [{ before: 1, around: 2 }],
    [{ after: 1, around: 2 }],
    [{ before: 1, after: 2, around: 3 }],
  ])('rejects combined windowing params %j with 400', async (query) => {
    const res = await getMessages(alice, chat, query);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    void ids;
  });
});
