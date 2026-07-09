import { REACTION_EMOJIS, type MessageDTO, type MessagesPage, type UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';
import { createChatEvents, type ChatEvents, type MessageUpdatedEvent } from '../events.js';

const THUMBS_UP = REACTION_EMOJIS[0]; // 👍
const HEART = REACTION_EMOJIS[1]; //    ❤️

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

async function send(actor: Actor, chatId: number, content: string) {
  return actor.agent.post(`/api/chats/${chatId}/messages`).send({ content });
}

function react(actor: Actor, chatId: number, messageId: number, emoji: string) {
  return actor.agent.post(`/api/chats/${chatId}/messages/${messageId}/reactions`).send({ emoji });
}

async function history(actor: Actor, chatId: number): Promise<MessagesPage> {
  return (await actor.agent.get(`/api/chats/${chatId}/messages`)).body as MessagesPage;
}

describe('POST /api/chats/:id/messages/:messageId/reactions', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let dm: number;
  let msgId: number;

  beforeEach(async () => {
    ({ app, events } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    dm = await makeDm(alice, bob);
    // Alice's message — Bob (the other member) reacts to it below.
    msgId = (await send(alice, dm, 'react to me')).body.message.id as number;
  });

  it('toggles a reaction on, then off, on a repeat call (round-trip)', async () => {
    const add = await react(bob, dm, msgId, THUMBS_UP);
    expect(add.status).toBe(200);
    expect((add.body.message as MessageDTO).reactions).toEqual([
      { emoji: THUMBS_UP, userIds: [bob.user.id] },
    ]);

    // Same emoji again removes my reaction.
    const remove = await react(bob, dm, msgId, THUMBS_UP);
    expect(remove.status).toBe(200);
    expect((remove.body.message as MessageDTO).reactions).toEqual([]);

    // Persisted: history shows none.
    const page = await history(bob, dm);
    expect(page.messages.find((m) => m.id === msgId)!.reactions).toEqual([]);
  });

  it('groups reactors by emoji in reaction order in GET history', async () => {
    // Insertion order: bob 👍, alice 👍, alice ❤️ →
    //   groups ordered by first-reaction time: [👍 {bob, alice}, ❤️ {alice}].
    await react(bob, dm, msgId, THUMBS_UP);
    await react(alice, dm, msgId, THUMBS_UP);
    await react(alice, dm, msgId, HEART);

    const page = await history(alice, dm);
    const msg = page.messages.find((m) => m.id === msgId)!;
    expect(msg.reactions).toEqual([
      { emoji: THUMBS_UP, userIds: [bob.user.id, alice.user.id] },
      { emoji: HEART, userIds: [alice.user.id] },
    ]);
  });

  it('also surfaces reactions on the chat-list last-message preview', async () => {
    await react(bob, dm, msgId, HEART);
    const s = (await alice.agent.get(`/api/chats/${dm}`)).body.chat as {
      lastMessage: MessageDTO | null;
    };
    expect(s.lastMessage!.reactions).toEqual([{ emoji: HEART, userIds: [bob.user.id] }]);
  });

  it('emits message:updated carrying the reactions to the full member list', async () => {
    const updates: MessageUpdatedEvent[] = [];
    events.on('message:updated', (e) => updates.push(e));

    await react(bob, dm, msgId, THUMBS_UP);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.message.id).toBe(msgId);
    expect(updates[0]!.message.reactions).toEqual([{ emoji: THUMBS_UP, userIds: [bob.user.id] }]);
    expect(new Set(updates[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));
  });

  it('preserves reactions across an edit of the same message', async () => {
    await react(bob, dm, msgId, THUMBS_UP);
    const edited = await alice.agent
      .patch(`/api/chats/${dm}/messages/${msgId}`)
      .send({ content: 'react to me (edited)' });
    expect(edited.status).toBe(200);
    expect((edited.body.message as MessageDTO).reactions).toEqual([
      { emoji: THUMBS_UP, userIds: [bob.user.id] },
    ]);
  });

  it('drops reactions when the message is deleted (tombstone)', async () => {
    await react(bob, dm, msgId, THUMBS_UP);
    await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    const page = await history(alice, dm);
    const tomb = page.messages.find((m) => m.id === msgId)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.reactions).toEqual([]);
  });

  it('rejects an emoji outside the whitelist with 400', async () => {
    const res = await react(alice, dm, msgId, '🚀');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid reaction');
  });

  it('rejects reacting to a deleted message with 400 (Message deleted)', async () => {
    await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    const res = await react(alice, dm, msgId, THUMBS_UP);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message deleted');
  });

  it('hides the chat from a non-member with 404 (Chat not found)', async () => {
    const res = await react(carol, dm, msgId, THUMBS_UP);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('404s (Message not found) when the message is not in the given chat', async () => {
    const other = await makeGroup(alice, [bob.user.id]);
    const res = await react(alice, other, msgId, THUMBS_UP);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
  });

  it('requires authentication (401)', async () => {
    const res = await request(app)
      .post(`/api/chats/${dm}/messages/${msgId}/reactions`)
      .send({ emoji: THUMBS_UP });
    expect(res.status).toBe(401);
  });
});
