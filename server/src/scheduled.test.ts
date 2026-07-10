import type { MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createDb, type Db } from './db/index.js';
import { createChatEvents, type ChatEvents, type MessageNewEvent } from './events.js';
import { scheduledMessages } from './db/schema.js';
import { dispatchDueScheduledMessages, startScheduledDispatcher } from './scheduled.js';

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

async function makeGroup(a: Actor, memberIds: number[]): Promise<number> {
  return (await a.agent.post('/api/chats').send({ name: 'G', memberIds })).body.chat.id as number;
}

async function send(actor: Actor, chatId: number, content: string): Promise<MessageDTO> {
  return (await actor.agent.post(`/api/chats/${chatId}/messages`).send({ content })).body
    .message as MessageDTO;
}

async function history(actor: Actor, chatId: number): Promise<MessageDTO[]> {
  return ((await actor.agent.get(`/api/chats/${chatId}/messages`)).body as MessagesPage).messages;
}

interface InsertOpts {
  chatId: number;
  senderId: number;
  content: string;
  scheduledAt: Date;
  mentions?: number[];
  replyToId?: number | null;
}

/** Direct-insert a scheduled row (bypasses the POST future-time validation so a
 *  row can be made due-in-the-past for the dispatcher to pick up). */
function insertScheduled(db: Db, opts: InsertOpts) {
  return db
    .insert(scheduledMessages)
    .values({
      chatId: opts.chatId,
      senderId: opts.senderId,
      content: opts.content,
      mentions: JSON.stringify(opts.mentions ?? []),
      replyToId: opts.replyToId ?? null,
      scheduledAt: opts.scheduledAt,
    })
    .returning()
    .get();
}

const pendingCount = (db: Db) => db.select().from(scheduledMessages).all().length;
const past = () => new Date(Date.now() - 60 * 1000);
const future = () => new Date(Date.now() + 60 * 60 * 1000);

describe('dispatchDueScheduledMessages', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let seen: MessageNewEvent[];

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    seen = [];
    events.on('message:new', (e) => seen.push(e));
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
  });

  it('sends a due row through createMessage (bus event + history) and deletes the row', async () => {
    const dm = await makeDm(alice, bob);
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'due now', scheduledAt: past() });

    const count = dispatchDueScheduledMessages(db, events);

    expect(count).toBe(1);
    // Fanned out on the shared bus exactly like a live send.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message.content).toBe('due now');
    expect(seen[0]!.message.sender.id).toBe(alice.user.id);
    expect(new Set(seen[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));
    // Row consumed.
    expect(pendingCount(db)).toBe(0);
    // Lands in real history.
    const msgs = await history(bob, dm);
    expect(msgs.map((m) => m.content)).toContain('due now');
  });

  it('filters mentions to chat members via the shared createMessage path', async () => {
    const group = await makeGroup(alice, [bob.user.id]); // carol NOT a member
    insertScheduled(db, {
      chatId: group,
      senderId: alice.user.id,
      content: 'hi',
      mentions: [bob.user.id, carol.user.id],
      scheduledAt: past(),
    });

    dispatchDueScheduledMessages(db, events);
    expect(seen[0]!.message.mentions).toEqual([bob.user.id]); // carol dropped
  });

  it('does not send a row whose time has not come', async () => {
    const dm = await makeDm(alice, bob);
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'later', scheduledAt: future() });

    const count = dispatchDueScheduledMessages(db, events);

    expect(count).toBe(0);
    expect(seen).toHaveLength(0);
    expect(pendingCount(db)).toBe(1);
  });

  it('sends only the due rows in a mixed pool, soonest first', async () => {
    const dm = await makeDm(alice, bob);
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'due-2', scheduledAt: new Date(Date.now() - 30 * 1000) });
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'due-1', scheduledAt: new Date(Date.now() - 90 * 1000) });
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'not-due', scheduledAt: future() });

    const count = dispatchDueScheduledMessages(db, events);

    expect(count).toBe(2);
    expect(seen.map((e) => e.message.content)).toEqual(['due-1', 'due-2']); // oldest-first
    expect(pendingCount(db)).toBe(1); // the not-due row survives
  });

  it('drops a row silently when the sender has left the chat (no send)', async () => {
    const group = await makeGroup(alice, [bob.user.id, carol.user.id]);
    insertScheduled(db, { chatId: group, senderId: carol.user.id, content: 'ghost', scheduledAt: past() });
    // Carol leaves after scheduling.
    await carol.agent.post(`/api/chats/${group}/leave`);

    const count = dispatchDueScheduledMessages(db, events);

    expect(count).toBe(0);
    expect(seen).toHaveLength(0);
    expect(pendingCount(db)).toBe(0); // dropped
    const msgs = await history(alice, group);
    expect(msgs.map((m) => m.content)).not.toContain('ghost');
  });

  it('sends a reply when its target is still live', async () => {
    const dm = await makeDm(alice, bob);
    const target = await send(alice, dm, 'original');
    insertScheduled(db, {
      chatId: dm,
      senderId: bob.user.id,
      content: 'quoting you',
      replyToId: target.id,
      scheduledAt: past(),
    });

    seen.length = 0; // drop the setup send's message:new
    dispatchDueScheduledMessages(db, events);

    expect(seen[0]!.message.replyTo?.id).toBe(target.id);
  });

  it('degrades to a plain send (does NOT drop) when the reply target was deleted', async () => {
    const dm = await makeDm(alice, bob);
    const target = await send(alice, dm, 'delete me');
    insertScheduled(db, {
      chatId: dm,
      senderId: bob.user.id,
      content: 'reply to a corpse',
      replyToId: target.id,
      scheduledAt: past(),
    });
    // Target is tombstoned before dispatch.
    await alice.agent.delete(`/api/chats/${dm}/messages/${target.id}`);

    seen.length = 0; // drop the setup send's message:new
    const count = dispatchDueScheduledMessages(db, events);

    expect(count).toBe(1); // still sent
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message.content).toBe('reply to a corpse');
    expect(seen[0]!.message.replyTo).toBeNull(); // but without the reply reference
    expect(pendingCount(db)).toBe(0);
  });

  it('contains a throwing subscriber so every due row is still processed', async () => {
    const dm = await makeDm(alice, bob);
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'first', scheduledAt: past() });
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'second', scheduledAt: past() });

    // A subscriber that throws on every message:new (createMessage commits the
    // row before it emits, so the message persists even though emit blows up).
    const boom: ChatEvents = {
      on: () => {},
      off: () => {},
      emit: () => {
        throw new Error('subscriber boom');
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    dispatchDueScheduledMessages(db, boom);

    errSpy.mockRestore();
    // Both rows were claimed despite the throwing subscriber...
    expect(pendingCount(db)).toBe(0);
    // ...and both messages still landed in history.
    const msgs = await history(bob, dm);
    expect(msgs.map((m) => m.content)).toEqual(expect.arrayContaining(['first', 'second']));
  });
});

describe('startScheduledDispatcher', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let dm: number;

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dm = await makeDm(alice, bob);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches at boot, repeats on the interval, and stop() halts it', () => {
    vi.useFakeTimers();

    // A row already due when the process starts goes out on the boot pass.
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'boot', scheduledAt: past() });
    const handle = startScheduledDispatcher(db, events, 1000);
    expect(pendingCount(db)).toBe(0);

    // A new due row is picked up one interval later.
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'tick', scheduledAt: past() });
    vi.advanceTimersByTime(1000);
    expect(pendingCount(db)).toBe(0);

    // After stop(), the interval no longer fires.
    handle.stop();
    insertScheduled(db, { chatId: dm, senderId: alice.user.id, content: 'after-stop', scheduledAt: past() });
    vi.advanceTimersByTime(5000);
    expect(pendingCount(db)).toBe(1);
  });

  it('returns an unref’d timer whose stop() never throws', () => {
    const handle = startScheduledDispatcher(db, events, 1000);
    expect(() => handle.stop()).not.toThrow();
  });
});
