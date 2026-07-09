import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';
import { attachments, pushSubscriptions } from '../db/schema.js';
import { createChatEvents, type ChatEvents, type MessageUpdatedEvent } from '../events.js';
import { initPush } from '../push.js';
import { createStorage, type Storage } from '../storage.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

let scratchDir: string;

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-edit-'));
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function makeCtx(): { db: Db; storage: Storage; events: ChatEvents; app: App } {
  const db = createDb(':memory:');
  const storage = createStorage(scratchDir);
  storage.ensureDir();
  const events = createChatEvents();
  const app = createApp(db, events, storage);
  return { db, storage, events, app };
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

async function send(actor: Actor, chatId: number, content: string, mentions?: number[]) {
  return actor.agent.post(`/api/chats/${chatId}/messages`).send({ content, mentions });
}

function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function summary(actor: Actor, chatId: number) {
  return (await actor.agent.get(`/api/chats/${chatId}`)).body.chat as {
    unreadCount: number;
    lastMessage: MessageDTO | null;
  };
}

describe('PATCH /api/chats/:id/messages/:messageId — edit', () => {
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let group: number;
  let msgId: number;

  beforeEach(async () => {
    ({ app, events } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    group = await makeGroup(alice, [bob.user.id, carol.user.id]);
    msgId = (await send(alice, group, 'hey @Bob', [bob.user.id])).body.message.id as number;
  });

  it('edits own message: 200, editedAt set, content changed, mentions replaced', async () => {
    const updates: MessageUpdatedEvent[] = [];
    events.on('message:updated', (e) => updates.push(e));

    const res = await alice.agent
      .patch(`/api/chats/${group}/messages/${msgId}`)
      .send({ content: 'hey @Carol instead', mentions: [carol.user.id] });

    expect(res.status).toBe(200);
    const msg = res.body.message as MessageDTO;
    expect(msg.content).toBe('hey @Carol instead');
    expect(msg.editedAt).not.toBeNull();
    expect(msg.isDeleted).toBe(false);
    // Old mention gone, new mention present.
    expect(msg.mentions).toEqual([carol.user.id]);

    // Persisted: history reflects the replaced text + mentions.
    const page = (await alice.agent.get(`/api/chats/${group}/messages`)).body as MessagesPage;
    const last = page.messages.at(-1)!;
    expect(last.content).toBe('hey @Carol instead');
    expect(last.mentions).toEqual([carol.user.id]);
    expect(last.editedAt).not.toBeNull();

    // Event emitted with the full member list.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.message.content).toBe('hey @Carol instead');
    expect(new Set(updates[0]!.memberIds)).toEqual(
      new Set([alice.user.id, bob.user.id, carol.user.id]),
    );
  });

  it("rejects editing someone else's message with 403", async () => {
    const res = await bob.agent
      .patch(`/api/chats/${group}/messages/${msgId}`)
      .send({ content: 'not mine' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not your message');
  });

  it('hides the chat from a non-member with 404 (Chat not found)', async () => {
    const dave = await register(app, 'dave@example.com', 'Dave');
    const res = await dave.agent
      .patch(`/api/chats/${group}/messages/${msgId}`)
      .send({ content: 'sneaky' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('404s (Message not found) when the message is in another chat', async () => {
    const other = await makeGroup(alice, [bob.user.id]);
    const res = await alice.agent
      .patch(`/api/chats/${other}/messages/${msgId}`)
      .send({ content: 'wrong chat' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Message not found');
  });

  it('rejects empty content with 400', async () => {
    expect((await alice.agent.patch(`/api/chats/${group}/messages/${msgId}`).send({ content: '' })).status).toBe(400);
    expect((await alice.agent.patch(`/api/chats/${group}/messages/${msgId}`).send({ content: '   ' })).status).toBe(400);
    expect(
      (await alice.agent.patch(`/api/chats/${group}/messages/${msgId}`).send({ content: 'x'.repeat(4001) }))
        .status,
    ).toBe(400);
  });

  it('rejects editing a deleted message with 400 (Message deleted)', async () => {
    await alice.agent.delete(`/api/chats/${group}/messages/${msgId}`);
    const res = await alice.agent
      .patch(`/api/chats/${group}/messages/${msgId}`)
      .send({ content: 'resurrect' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Message deleted');
  });

  it('requires authentication (401)', async () => {
    const res = await request(app)
      .patch(`/api/chats/${group}/messages/${msgId}`)
      .send({ content: 'anon' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/chats/:id/messages/:messageId — soft delete', () => {
  let db: Db;
  let storage: Storage;
  let app: App;
  let events: ChatEvents;
  let alice: Actor;
  let bob: Actor;
  let dm: number;

  beforeEach(async () => {
    ({ db, storage, app, events } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dm = await makeDm(alice, bob);
  });

  it('soft-deletes: 204 + a tombstone in GET messages, and emits message:updated', async () => {
    const updates: MessageUpdatedEvent[] = [];
    events.on('message:updated', (e) => updates.push(e));

    const msgId = (await send(alice, dm, 'secret plans')).body.message.id as number;
    const res = await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    expect(res.status).toBe(204);

    const page = (await alice.agent.get(`/api/chats/${dm}/messages`)).body as MessagesPage;
    const tomb = page.messages.find((m) => m.id === msgId)!;
    expect(tomb.isDeleted).toBe(true);
    expect(tomb.content).toBe(''); // original text never leaks
    expect(tomb.mentions).toEqual([]);
    expect(tomb.attachments).toEqual([]);
    expect(tomb.editedAt).toBeNull();

    expect(updates).toHaveLength(1);
    expect(updates[0]!.message.isDeleted).toBe(true);
    expect(updates[0]!.message.content).toBe('');
    expect(new Set(updates[0]!.memberIds)).toEqual(new Set([alice.user.id, bob.user.id]));
  });

  it('removes the attachment file + thumb from disk on delete', async () => {
    const png = await makePng(1200, 800); // large enough to get a thumbnail
    const att = (
      await alice.agent
        .post(`/api/chats/${dm}/attachments`)
        .attach('file', png, { filename: 'plan.png', contentType: 'image/png' })
    ).body.attachment as { id: number };
    const msgId = (
      await alice.agent.post(`/api/chats/${dm}/messages`).send({ content: '', attachmentIds: [att.id] })
    ).body.message.id as number;

    // Capture the on-disk paths before the row is gone.
    const row = db.select().from(attachments).where(eq(attachments.id, att.id)).get()!;
    const fullPath = storage.filePath(row.storagePath);
    const thumbPath = storage.filePath(row.thumbPath!);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.existsSync(thumbPath)).toBe(true);

    const res = await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    expect(res.status).toBe(204);

    // File, thumb, and metadata row are all gone.
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(fs.existsSync(thumbPath)).toBe(false);
    expect(db.select().from(attachments).where(eq(attachments.id, att.id)).get()).toBeUndefined();
  });

  it('is idempotent: a second delete still returns 204', async () => {
    const msgId = (await send(alice, dm, 'once')).body.message.id as number;
    expect((await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`)).status).toBe(204);
    expect((await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`)).status).toBe(204);
  });

  it("rejects deleting someone else's message with 403", async () => {
    const msgId = (await send(alice, dm, 'mine')).body.message.id as number;
    const res = await bob.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not your message');
  });

  it('excludes deleted messages from unread counts', async () => {
    // Alice sends 2 → Bob has 2 unread.
    const first = (await send(alice, dm, 'one')).body.message.id as number;
    await send(alice, dm, 'two');
    expect((await summary(bob, dm)).unreadCount).toBe(2);

    // Alice deletes one of hers → Bob sees 1.
    await alice.agent.delete(`/api/chats/${dm}/messages/${first}`);
    expect((await summary(bob, dm)).unreadCount).toBe(1);
  });

  it('keeps the deleted message as a tombstone in the chat-list preview', async () => {
    const msgId = (await send(alice, dm, 'last word')).body.message.id as number;
    await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    const s = await summary(alice, dm);
    expect(s.lastMessage!.id).toBe(msgId);
    expect(s.lastMessage!.isDeleted).toBe(true);
    expect(s.lastMessage!.content).toBe('');
  });
});

describe('push does not fire for edits or deletes', () => {
  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  const sendSpy = vi.fn<typeof import('web-push').sendNotification>();

  afterEach(() => {
    if (savedPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = savedPriv;
  });

  it('pushes on message:new but not on PATCH/DELETE', async () => {
    process.env.VAPID_PUBLIC_KEY = 'test-public';
    process.env.VAPID_PRIVATE_KEY = 'test-private';

    const db = createDb(':memory:');
    const events = createChatEvents();
    const app = createApp(db, events, createStorage(scratchDir));
    sendSpy.mockReset();
    sendSpy.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    // No one is "connected", so a normal send would push to the other member.
    const handle = initPush(db, events, () => false, sendSpy);

    const alice = await register(app, 'alice2@example.com', 'Alice');
    const bob = await register(app, 'bob2@example.com', 'Bob');
    db.insert(pushSubscriptions)
      .values({ userId: bob.user.id, endpoint: 'https://push.example.com/bob2', p256dh: 'pb', auth: 'ab' })
      .run();
    const dm = await makeDm(alice, bob);

    const msgId = (await send(alice, dm, 'hi bob')).body.message.id as number;
    await handle.lastDispatch;
    expect(sendSpy).toHaveBeenCalledTimes(1); // the create pushed

    sendSpy.mockClear();
    await alice.agent.patch(`/api/chats/${dm}/messages/${msgId}`).send({ content: 'hi bob (edited)' });
    await alice.agent.delete(`/api/chats/${dm}/messages/${msgId}`);
    await handle.lastDispatch; // unchanged since neither reassigns it

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
