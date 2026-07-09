import type { MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';
import { createChatEvents, type ChatEvents, type MessageNewEvent } from '../events.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

function makeCtx(): { app: App; events: ChatEvents } {
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

async function makeDm(a: Actor, b: Actor): Promise<number> {
  return (await a.agent.post('/api/chats').send({ userId: b.user.id })).body.chat.id as number;
}

async function makeGroup(a: Actor, memberIds: number[]): Promise<number> {
  return (await a.agent.post('/api/chats').send({ name: 'G', memberIds })).body.chat.id as number;
}

/** Send a plain message; returns the created MessageDTO. */
async function send(actor: Actor, chatId: number, content: string): Promise<MessageDTO> {
  return (await actor.agent.post(`/api/chats/${chatId}/messages`).send({ content })).body
    .message as MessageDTO;
}

/** Send a reply; returns the raw supertest response so status can be asserted. */
function reply(actor: Actor, chatId: number, content: string, replyToId: number) {
  return actor.agent.post(`/api/chats/${chatId}/messages`).send({ content, replyToId });
}

async function history(actor: Actor, chatId: number): Promise<MessageDTO[]> {
  return ((await actor.agent.get(`/api/chats/${chatId}/messages`)).body as MessagesPage).messages;
}

describe('reply / quote — POST /api/chats/:id/messages { replyToId }', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let dm: number;
  let target: MessageDTO;

  beforeEach(async () => {
    ({ app, events } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    dm = await makeDm(alice, bob);
    target = await send(alice, dm, 'original message');
  });

  it('round-trips a reply with a populated snippet in the POST response and GET history', async () => {
    const res = await reply(bob, dm, 'quoting you', target.id);
    expect(res.status).toBe(201);
    const created = res.body.message as MessageDTO;
    expect(created.replyTo).toEqual({
      id: target.id,
      senderId: alice.user.id,
      content: 'original message',
      isDeleted: false,
      hasAttachments: false,
    });

    // Persisted: GET history carries the same snapshot.
    const msgs = await history(bob, dm);
    const fetched = msgs.find((m) => m.id === created.id)!;
    expect(fetched.replyTo).toEqual(created.replyTo);
    // A non-reply message has replyTo === null.
    expect(msgs.find((m) => m.id === target.id)!.replyTo).toBeNull();
  });

  it('surfaces the reply snapshot on the chat-list last-message preview', async () => {
    const created = (await reply(bob, dm, 'quoting you', target.id)).body.message as MessageDTO;
    const summary = (await alice.agent.get(`/api/chats/${dm}`)).body.chat as {
      lastMessage: MessageDTO | null;
    };
    expect(summary.lastMessage!.id).toBe(created.id);
    expect(summary.lastMessage!.replyTo!.id).toBe(target.id);
    expect(summary.lastMessage!.replyTo!.content).toBe('original message');
  });

  it('rejects a nonexistent reply target with 400 (Invalid reply target)', async () => {
    const res = await reply(bob, dm, 'reply to ghost', 999999);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('rejects a reply target that lives in another chat with 400', async () => {
    const otherChat = await makeGroup(alice, [carol.user.id]); // bob is NOT a member
    const otherMsg = await send(alice, otherChat, 'over here');
    const res = await reply(bob, dm, 'cross-chat reply', otherMsg.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('rejects replying to a tombstoned (deleted) message with 400', async () => {
    await alice.agent.delete(`/api/chats/${dm}/messages/${target.id}`);
    const res = await reply(bob, dm, 'reply to a corpse', target.id);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reply target');
  });

  it('snapshots the original CURRENT content — an edit before the reply is reflected', async () => {
    await alice.agent
      .patch(`/api/chats/${dm}/messages/${target.id}`)
      .send({ content: 'edited original' });
    const created = (await reply(bob, dm, 'quoting the edit', target.id)).body
      .message as MessageDTO;
    expect(created.replyTo!.content).toBe('edited original');
  });

  it('does NOT live-update the snapshot, but a refetch reflects the original being edited', async () => {
    const created = (await reply(bob, dm, 'quoting you', target.id)).body.message as MessageDTO;
    expect(created.replyTo!.content).toBe('original message');

    await alice.agent
      .patch(`/api/chats/${dm}/messages/${target.id}`)
      .send({ content: 'original message v2' });

    const refetched = (await history(bob, dm)).find((m) => m.id === created.id)!;
    expect(refetched.replyTo!.content).toBe('original message v2');
  });

  it('refetched snapshot reflects the original being deleted after the reply (isDeleted, empty content)', async () => {
    const created = (await reply(bob, dm, 'quoting you', target.id)).body.message as MessageDTO;
    expect(created.replyTo!.isDeleted).toBe(false);

    await alice.agent.delete(`/api/chats/${dm}/messages/${target.id}`);

    const refetched = (await history(bob, dm)).find((m) => m.id === created.id)!;
    expect(refetched.replyTo).toEqual({
      id: target.id,
      senderId: alice.user.id,
      content: '',
      isDeleted: true,
      hasAttachments: false,
    });
  });

  it('truncates a long original to at most 200 chars in the snapshot', async () => {
    const long = 'x'.repeat(500);
    const longMsg = await send(alice, dm, long);
    const created = (await reply(bob, dm, 'quoting the essay', longMsg.id)).body
      .message as MessageDTO;
    expect(created.replyTo!.content).toHaveLength(200);
    expect(created.replyTo!.content).toBe('x'.repeat(200));
  });

  it('emits message:new whose DTO carries the populated replyTo', async () => {
    const created: MessageNewEvent[] = [];
    events.on('message:new', (e) => created.push(e));

    const res = await reply(bob, dm, 'quoting you', target.id);
    expect(res.status).toBe(201);

    expect(created).toHaveLength(1);
    expect(created[0]!.message.replyTo!.id).toBe(target.id);
    expect(created[0]!.message.replyTo!.content).toBe('original message');
    expect(new Set(created[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));
  });

  it('a tombstoned reply message drops its own replyTo (neutered)', async () => {
    const created = (await reply(bob, dm, 'quoting you', target.id)).body.message as MessageDTO;
    expect(created.replyTo).not.toBeNull();

    // Bob deletes his own reply — the tombstone carries no quote.
    await bob.agent.delete(`/api/chats/${dm}/messages/${created.id}`);
    const tomb = (await history(bob, dm)).find((m) => m.id === created.id)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.replyTo).toBeNull();
  });
});
