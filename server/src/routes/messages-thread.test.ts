import type { MessageDTO, ThreadResponse, UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

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

async function send(
  actor: Actor,
  chatId: number,
  content: string,
  replyToId?: number,
): Promise<MessageDTO> {
  return (await actor.agent.post(`/api/chats/${chatId}/messages`).send({ content, replyToId }))
    .body.message as MessageDTO;
}

function getThread(actor: Actor, chatId: number, messageId: number) {
  return actor.agent.get(`/api/chats/${chatId}/messages/${messageId}/thread`);
}

describe('thread — GET /api/chats/:id/messages/:messageId/thread', () => {
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let dm: number;
  let root: MessageDTO;

  beforeEach(async () => {
    app = createApp(createDb(':memory:'));
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dm = await makeDm(alice, bob);
    root = await send(alice, dm, 'thread root');
  });

  it('collects a linear chain from ANY of its messages, oldest-first with rootId', async () => {
    // root <- a <- b <- c, with unrelated chatter interleaved.
    await send(bob, dm, 'unrelated one');
    const a = await send(bob, dm, 'first reply', root.id);
    const b = await send(alice, dm, 'second reply', a.id);
    await send(alice, dm, 'unrelated two');
    const c = await send(bob, dm, 'third reply', b.id);

    const expected = [root.id, a.id, b.id, c.id];
    // Anchor at the root, a middle link, and the leaf — identical thread.
    for (const anchor of [root.id, b.id, c.id]) {
      const res = await getThread(alice, dm, anchor);
      expect(res.status).toBe(200);
      const thread = res.body as ThreadResponse;
      expect(thread.rootId).toBe(root.id);
      expect(thread.messages.map((m) => m.id)).toEqual(expected);
    }
  });

  it('collects the whole connected component across branches, not just one path', async () => {
    // Two branches off the root; one branch goes a level deeper.
    const a = await send(bob, dm, 'branch A', root.id);
    const b = await send(alice, dm, 'branch B', root.id);
    const deep = await send(alice, dm, 'deeper in A', a.id);

    const res = await getThread(bob, dm, b.id); // anchored in branch B
    const thread = res.body as ThreadResponse;
    expect(thread.rootId).toBe(root.id);
    expect(thread.messages.map((m) => m.id)).toEqual([root.id, a.id, b.id, deep.id]);
  });

  it('a message with no replies and no target is a single-message thread', async () => {
    const res = await getThread(alice, dm, root.id);
    const thread = res.body as ThreadResponse;
    expect(thread.rootId).toBe(root.id);
    expect(thread.messages.map((m) => m.id)).toEqual([root.id]);
  });

  it('keeps a tombstoned mid-chain message in the thread as a tombstone', async () => {
    const a = await send(bob, dm, 'will be deleted', root.id);
    const b = await send(alice, dm, 'reply to the deleted one', a.id);
    await bob.agent.delete(`/api/chats/${dm}/messages/${a.id}`);

    const thread = (await getThread(alice, dm, b.id)).body as ThreadResponse;
    expect(thread.messages.map((m) => m.id)).toEqual([root.id, a.id, b.id]);
    const tomb = thread.messages.find((m) => m.id === a.id)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.content).toBe('');
  });

  it('carries full DTOs — reactions and reply snapshots come through', async () => {
    const a = await send(bob, dm, 'first reply', root.id);
    await alice.agent.post(`/api/chats/${dm}/messages/${a.id}/reactions`).send({ emoji: '❤️' });

    const thread = (await getThread(alice, dm, a.id)).body as ThreadResponse;
    const fetched = thread.messages.find((m) => m.id === a.id)!;
    expect(fetched.replyTo!.id).toBe(root.id);
    expect(fetched.replyTo!.content).toBe('thread root');
    expect(fetched.reactions).toHaveLength(1);
    expect(fetched.reactions[0]!.emoji).toBe('❤️');
  });

  it('404s for a non-member (chat not found — no existence leak)', async () => {
    const carol = await register(app, 'carol@example.com', 'Carol');
    const res = await getThread(carol, dm, root.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('404s for an unknown message id and for a message from another chat', async () => {
    const ghost = await getThread(alice, dm, 999999);
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('Message not found');

    const carol = await register(app, 'carol@example.com', 'Carol');
    const otherChat = await makeDm(alice, carol);
    const otherMsg = await send(alice, otherChat, 'elsewhere');
    const crossChat = await getThread(bob, dm, otherMsg.id);
    expect(crossChat.status).toBe(404);
    expect(crossChat.body.error).toBe('Message not found');
  });

  it('requires auth', async () => {
    const res = await request(app).get(`/api/chats/${dm}/messages/${root.id}/thread`);
    expect(res.status).toBe(401);
  });
});
