import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AttachmentDTO, MessageDTO, MessagesPage, UserDTO } from '@messenger/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb, type Db } from '../db/index.js';
import { attachments, type ChatRow } from '../db/schema.js';
import { createChatEvents } from '../events.js';
import { buildPushPayload } from '../push.js';
import { createStorage, type Storage } from '../storage.js';

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

let scratchDir: string;

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-attach-'));
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function makeCtx(): { db: Db; storage: Storage; app: App } {
  const db = createDb(':memory:');
  const storage = createStorage(scratchDir);
  storage.ensureDir();
  const app = createApp(db, createChatEvents(), storage);
  return { db, storage, app };
}

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

/** A real, decodable PNG of the given dimensions. */
function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .png()
    .toBuffer();
}

function upload(
  actor: Actor,
  chatId: number,
  buffer: Buffer,
  filename: string,
  contentType: string,
) {
  return actor.agent
    .post(`/api/chats/${chatId}/attachments`)
    .attach('file', buffer, { filename, contentType });
}

/** Buffers a binary response body so we can assert on exact bytes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
  res.on('error', (err: Error) => cb(err, Buffer.alloc(0)));
}

async function makeDm(a: Actor, b: Actor): Promise<number> {
  const res = await a.agent.post('/api/chats').send({ userId: b.user.id });
  return res.body.chat.id as number;
}

async function makeGroup(a: Actor, memberIds: number[]): Promise<number> {
  const res = await a.agent.post('/api/chats').send({ name: 'G', memberIds });
  return res.body.chat.id as number;
}

describe('POST /api/chats/:chatId/attachments — upload', () => {
  let db: Db;
  let storage: Storage;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let dm: number;

  beforeEach(async () => {
    ({ db, storage, app } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    dm = await makeDm(alice, bob);
  });

  it('accepts a large image (201): DTO shape, dims, thumb on disk ≤512px', async () => {
    const png = await makePng(1200, 800);
    const res = await upload(alice, dm, png, 'photo.png', 'image/png');

    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('image');
    expect(a.originalName).toBe('photo.png');
    expect(a.mimeType).toBe('image/png');
    expect(a.sizeBytes).toBe(png.length);
    expect(a.width).toBe(1200);
    expect(a.height).toBe(800);
    expect(a.hasThumb).toBe(true);
    expect(typeof a.id).toBe('number');

    const row = db.select().from(attachments).where(eq(attachments.id, a.id)).get()!;
    expect(row.thumbPath).not.toBeNull();
    const thumbPath = storage.filePath(row.thumbPath!);
    expect(fs.existsSync(thumbPath)).toBe(true);
    const meta = await sharp(thumbPath).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512);
  });

  it('does not thumbnail a small image (hasThumb false)', async () => {
    const png = await makePng(100, 100);
    const res = await upload(alice, dm, png, 'small.png', 'image/png');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('image');
    expect(a.width).toBe(100);
    expect(a.height).toBe(100);
    expect(a.hasThumb).toBe(false);

    const row = db.select().from(attachments).where(eq(attachments.id, a.id)).get()!;
    expect(row.thumbPath).toBeNull();
  });

  it('stores an SVG as a plain file (never inline image)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>',
    );
    const res = await upload(alice, dm, svg, 'vector.svg', 'image/svg+xml');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('file');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
    expect(a.hasThumb).toBe(false);
  });

  it('keeps a corrupt "image" but downgrades it to a file', async () => {
    const junk = randomBytes(4096);
    const res = await upload(alice, dm, junk, 'broken.png', 'image/png');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('file');
    expect(a.mimeType).toBe('image/png');
    expect(a.originalName).toBe('broken.png');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
    expect(a.hasThumb).toBe(false);
    expect(a.sizeBytes).toBe(junk.length);
  });

  it('classifies mp4/webm as video (no thumbnail, no dimensions)', async () => {
    const mp4 = randomBytes(2048);
    const res = await upload(alice, dm, mp4, 'clip.mp4', 'video/mp4');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('video');
    expect(a.mimeType).toBe('video/mp4');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
    expect(a.hasThumb).toBe(false);
    expect(a.sizeBytes).toBe(mp4.length);

    const webm = randomBytes(2048);
    const res2 = await upload(alice, dm, webm, 'clip.webm', 'video/webm');
    expect(res2.status).toBe(201);
    const a2 = res2.body.attachment as AttachmentDTO;
    expect(a2.kind).toBe('video');
    expect(a2.mimeType).toBe('video/webm');
  });

  it('classifies quicktime (.mov, iPhone recordings) as inline video', async () => {
    const mov = randomBytes(2048);
    const res = await upload(alice, dm, mov, 'clip.mov', 'video/quicktime');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('video');
    expect(a.mimeType).toBe('video/quicktime');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
  });

  it('rescues a .mov reported as octet-stream via the extension fallback', async () => {
    // Re-downloaded/re-uploaded videos commonly arrive with a useless mime —
    // the extension decides, and the STORED mime is fixed up so playback gets
    // a real video/* Content-Type.
    const mov = randomBytes(2048);
    const res = await upload(alice, dm, mov, 'clip.mov', 'application/octet-stream');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('video');
    expect(a.mimeType).toBe('video/quicktime');
  });

  it('strips codec parameters and lowercases the reported mime', async () => {
    const mp4 = randomBytes(2048);
    const res = await upload(alice, dm, mp4, 'clip.mp4', 'video/mp4; codecs="avc1.42E01E"');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('video');
    expect(a.mimeType).toBe('video/mp4');
  });

  it('classifies the browser-safe audio mimes as inline audio (no thumbnail/dimensions)', async () => {
    const cases: Array<[string, string]> = [
      ['note.webm', 'audio/webm'],
      ['note.m4a', 'audio/mp4'],
      ['note.mp3', 'audio/mpeg'],
      ['note.ogg', 'audio/ogg'],
    ];
    for (const [name, mime] of cases) {
      const bytes = randomBytes(2048);
      const res = await upload(alice, dm, bytes, name, mime);
      expect(res.status).toBe(201);
      const a = res.body.attachment as AttachmentDTO;
      expect(a.kind).toBe('audio');
      expect(a.mimeType).toBe(mime);
      expect(a.width).toBeNull();
      expect(a.height).toBeNull();
      expect(a.hasThumb).toBe(false);
      expect(a.sizeBytes).toBe(bytes.length);
    }
  });

  it('strips codec parameters from a voice-note mime (audio/webm;codecs=opus → audio)', async () => {
    const bytes = randomBytes(2048);
    const res = await upload(alice, dm, bytes, 'voice-1.webm', 'audio/webm;codecs=opus');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('audio');
    expect(a.mimeType).toBe('audio/webm');
  });

  it('rescues a .m4a reported as octet-stream via the extension fallback (audio/mp4)', async () => {
    const bytes = randomBytes(2048);
    const res = await upload(alice, dm, bytes, 'voice.m4a', 'application/octet-stream');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('audio');
    expect(a.mimeType).toBe('audio/mp4');
  });

  it('does NOT flip an octet-stream .webm to audio (ambiguous extension stays video)', async () => {
    const bytes = randomBytes(2048);
    const res = await upload(alice, dm, bytes, 'clip.webm', 'application/octet-stream');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('video');
    expect(a.mimeType).toBe('video/webm');
  });

  it('classifies any other audio/* mime as a plain file (no inline rendering)', async () => {
    const wav = randomBytes(2048);
    const res = await upload(alice, dm, wav, 'sound.wav', 'audio/wav');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('file');
    expect(a.mimeType).toBe('audio/wav');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
  });

  it('leaves a non-video octet-stream upload as a plain file', async () => {
    const blob = randomBytes(2048);
    const res = await upload(alice, dm, blob, 'data.bin', 'application/octet-stream');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('file');
    expect(a.mimeType).toBe('application/octet-stream');
  });

  it('classifies any other video/* mime as a plain file (no inline rendering)', async () => {
    const avi = randomBytes(2048);
    const res = await upload(alice, dm, avi, 'clip.avi', 'video/x-msvideo');
    expect(res.status).toBe(201);
    const a = res.body.attachment as AttachmentDTO;
    expect(a.kind).toBe('file');
    expect(a.mimeType).toBe('video/x-msvideo');
    expect(a.width).toBeNull();
    expect(a.height).toBeNull();
  });

  it('hides the chat from a non-member (404)', async () => {
    const png = await makePng(100, 100);
    const res = await upload(carol, dm, png, 'sneaky.png', 'image/png');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
  });

  it('requires authentication (401)', async () => {
    const png = await makePng(100, 100);
    const res = await request(app)
      .post(`/api/chats/${dm}/attachments`)
      .attach('file', png, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects a file larger than 25MB (413)', async () => {
    const tooBig = Buffer.alloc(26 * 1024 * 1024);
    const res = await upload(alice, dm, tooBig, 'huge.bin', 'application/octet-stream');
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('File too large (max 25MB)');
  });
});

describe('linking attachments on send', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let group: number;
  let otherChat: number;

  beforeEach(async () => {
    ({ db, app } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    group = await makeGroup(alice, [bob.user.id]);
    otherChat = await makeGroup(alice, [bob.user.id]);
  });

  async function uploadImage(actor: Actor, chatId: number): Promise<AttachmentDTO> {
    const png = await makePng(300, 200);
    const res = await upload(actor, chatId, png, 'pic.png', 'image/png');
    return res.body.attachment as AttachmentDTO;
  }

  it('links an attachment with empty content and echoes it everywhere', async () => {
    const att = await uploadImage(alice, group);

    const send = await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });
    expect(send.status).toBe(201);
    const msg = send.body.message as MessageDTO;
    expect(msg.content).toBe('');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.id).toBe(att.id);

    // History page includes it.
    const page = (await alice.agent.get(`/api/chats/${group}/messages`)).body as MessagesPage;
    expect(page.messages.at(-1)!.attachments[0]!.id).toBe(att.id);

    // lastMessage in the chat summary includes it.
    const list = (await alice.agent.get('/api/chats')).body.chats as Array<{
      id: number;
      lastMessage: MessageDTO | null;
    }>;
    const summary = list.find((c) => c.id === group)!;
    expect(summary.lastMessage!.attachments[0]!.id).toBe(att.id);

    // The row is now linked to the message.
    const row = db.select().from(attachments).where(eq(attachments.id, att.id)).get()!;
    expect(row.messageId).toBe(msg.id);
  });

  it("rejects linking someone else's upload (400)", async () => {
    const bobAtt = await uploadImage(bob, group);
    const res = await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: 'mine now', attachmentIds: [bobAtt.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid attachments');
  });

  it('rejects re-linking an already-linked attachment (400)', async () => {
    const att = await uploadImage(alice, group);
    const first = await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });
    expect(first.status).toBe(201);

    const second = await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('Invalid attachments');
  });

  it("rejects linking another chat's upload (400)", async () => {
    const att = await uploadImage(alice, otherChat);
    const res = await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid attachments');
  });

  it('rejects a message with neither content nor attachments (400)', async () => {
    const res = await alice.agent.post(`/api/chats/${group}/messages`).send({ content: '' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/attachments/:id — serving', () => {
  let db: Db;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let carol: Actor;
  let group: number;

  beforeEach(async () => {
    ({ db, app } = makeCtx());
    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    carol = await register(app, 'carol@example.com', 'Carol');
    group = await makeGroup(alice, [bob.user.id]);
  });

  async function uploadAndLink(
    name = 'photo.png',
  ): Promise<{ att: AttachmentDTO; png: Buffer }> {
    const png = await makePng(1200, 800);
    const up = await upload(alice, group, png, name, 'image/png');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });
    return { att, png };
  }

  it('serves the exact bytes to a member, with security headers', async () => {
    const { att, png } = await uploadAndLink();
    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect((res.body as Buffer).length).toBe(att.sizeBytes);
    expect((res.body as Buffer).length).toBe(png.length);
  });

  it('serves the webp thumbnail with ?thumb=1', async () => {
    const { att } = await uploadAndLink();
    const res = await alice.agent
      .get(`/api/attachments/${att.id}?thumb=1`)
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const meta = await sharp(res.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512);
  });

  it('sets Accept-Ranges: bytes on a full (200) response', async () => {
    const { att } = await uploadAndLink();
    const res = await bob.agent.get(`/api/attachments/${att.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('serves a mid-file byte range as 206 with the exact slice and safety headers', async () => {
    const { att, png } = await uploadAndLink();
    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', 'bytes=10-49')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 10-49/${png.length}`);
    expect(res.headers['content-length']).toBe('40');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect((res.body as Buffer).equals(png.subarray(10, 50))).toBe(true);
  });

  it('serves an open-ended range (bytes=N-) through end of file', async () => {
    const { att, png } = await uploadAndLink();
    const start = png.length - 100;
    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', `bytes=${start}-`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${png.length - 1}/${png.length}`);
    expect((res.body as Buffer).equals(png.subarray(start))).toBe(true);
  });

  it('serves a suffix range (bytes=-N) for the last N bytes', async () => {
    const { att, png } = await uploadAndLink();
    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', 'bytes=-100')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(206);
    const expectedStart = png.length - 100;
    expect(res.headers['content-range']).toBe(`bytes ${expectedStart}-${png.length - 1}/${png.length}`);
    expect((res.body as Buffer).equals(png.subarray(expectedStart))).toBe(true);
  });

  it('rejects an out-of-bounds range with 416 + Content-Range: bytes */size', async () => {
    const { att, png } = await uploadAndLink();
    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', `bytes=${png.length + 1000}-${png.length + 2000}`);
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${png.length}`);
  });

  it('rejects a malformed Range header with 416', async () => {
    const { att, png } = await uploadAndLink();
    const res = await bob.agent.get(`/api/attachments/${att.id}`).set('Range', 'bytes=abc-def');
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${png.length}`);
  });

  it('serves an mp4 inline (Content-Type video/mp4) with correct 206 byte slice', async () => {
    const bytes = randomBytes(5000);
    const up = await upload(alice, group, bytes, 'clip.mp4', 'video/mp4');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });

    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', 'bytes=0-99')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['content-range']).toBe(`bytes 0-99/${bytes.length}`);
    expect((res.body as Buffer).equals(bytes.subarray(0, 100))).toBe(true);
    // The two safe video types are never forced to download.
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('keeps an unsafe video/* (kind file) forced to download, even on a 206 partial response', async () => {
    const bytes = randomBytes(5000);
    const up = await upload(alice, group, bytes, 'clip.avi', 'video/x-msvideo');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });

    const res = await bob.agent.get(`/api/attachments/${att.id}`).set('Range', 'bytes=0-99');

    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('serves a voice note inline (Content-Type audio/webm) with a correct 206 byte slice', async () => {
    const bytes = randomBytes(5000);
    const up = await upload(alice, group, bytes, 'voice-1.webm', 'audio/webm;codecs=opus');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });

    const res = await bob.agent
      .get(`/api/attachments/${att.id}`)
      .set('Range', 'bytes=0-99')
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('audio/webm');
    expect(res.headers['content-range']).toBe(`bytes 0-99/${bytes.length}`);
    expect((res.body as Buffer).equals(bytes.subarray(0, 100))).toBe(true);
    // Safe audio is never forced to download.
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('keeps an unsafe audio/* (kind file) forced to download', async () => {
    const bytes = randomBytes(5000);
    const up = await upload(alice, group, bytes, 'sound.wav', 'audio/wav');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });

    const res = await bob.agent.get(`/api/attachments/${att.id}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
  });

  it('forces a download with an RFC5987-encoded filename via ?download=1', async () => {
    const { att } = await uploadAndLink('my report.png');
    const res = await alice.agent.get(`/api/attachments/${att.id}?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''my%20report.png",
    );
  });

  it('serves files as octet-stream with attachment disposition', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const up = await upload(alice, group, svg, 'v.svg', 'image/svg+xml');
    const att = up.body.attachment as AttachmentDTO;
    await alice.agent
      .post(`/api/chats/${group}/messages`)
      .send({ content: '', attachmentIds: [att.id] });

    const res = await alice.agent.get(`/api/attachments/${att.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment');
  });

  it('hides a linked attachment from non-members (404)', async () => {
    const { att } = await uploadAndLink();
    const res = await carol.agent.get(`/api/attachments/${att.id}`);
    expect(res.status).toBe(404);
  });

  it('lets only the uploader fetch a still-unlinked attachment', async () => {
    const png = await makePng(100, 100);
    const up = await upload(alice, group, png, 'draft.png', 'image/png');
    const att = up.body.attachment as AttachmentDTO;

    // Uploader can.
    expect((await alice.agent.get(`/api/attachments/${att.id}`)).status).toBe(200);
    // Another chat member cannot, while it's unlinked.
    expect((await bob.agent.get(`/api/attachments/${att.id}`)).status).toBe(404);
  });

  it('404s when the file is missing on disk', async () => {
    const { att } = await uploadAndLink();
    const row = db.select().from(attachments).where(eq(attachments.id, att.id)).get()!;
    fs.rmSync(path.join(scratchDir, row.storagePath), { force: true });
    const res = await alice.agent.get(`/api/attachments/${att.id}`);
    expect(res.status).toBe(404);
  });
});

describe('buildPushPayload — attachment previews', () => {
  const sender: UserDTO = { id: 1, email: 'a@x.com', displayName: 'Alice', isBot: false };
  const group = { id: 11, type: 'group', name: 'Team' } as ChatRow;

  function imageAtt(id: number): AttachmentDTO {
    return {
      id,
      kind: 'image',
      originalName: `p${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 100,
      height: 100,
      hasThumb: false,
    };
  }

  function msg(attachmentsList: AttachmentDTO[]): MessageDTO {
    return {
      id: 5,
      chatId: 11,
      sender,
      content: '',
      mentions: [],
      attachments: attachmentsList,
      reactions: [],
      replyTo: null,
      createdAt: '',
      editedAt: null,
      isDeleted: false,
    };
  }

  it('previews a single image as "📷 Photo"', () => {
    expect(buildPushPayload(msg([imageAtt(1)]), group, 2).body).toBe('📷 Photo');
  });

  it('previews multiple images as "📷 N photos"', () => {
    expect(buildPushPayload(msg([imageAtt(1), imageAtt(2)]), group, 2).body).toBe(
      '📷 2 photos',
    );
  });

  it('previews a file as "📎 <name>"', () => {
    const file: AttachmentDTO = {
      id: 9,
      kind: 'file',
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      width: null,
      height: null,
      hasThumb: false,
    };
    expect(buildPushPayload(msg([file]), group, 2).body).toBe('📎 report.pdf');
  });
});
