import { REACTION_EMOJIS, type LinkPreviewDTO, type MessageDTO, type UserDTO } from '@messenger/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createDb, type Db } from './db/index.js';
import { createChatEvents, type ChatEvents, type MessageUpdatedEvent } from './events.js';
import { messages } from './db/schema.js';
import { initLinkPreviews, type LinkPreviewHandle, type LookupFn } from './link-previews.js';

/**
 * Integration tests for the link-preview EVENT BUS WIRING (initLinkPreviews):
 * real app + real (in-memory) DB, with `fetchFn`/`lookupFn` injected so no
 * real network is ever touched. The pure fetch/parse core (extractFirstHttpUrl,
 * fetchLinkPreview, the SSRF guard, OG parsing) is exhaustively covered by
 * link-previews.test.ts and is NOT re-tested here.
 */

type App = ReturnType<typeof createApp>;
type Actor = { agent: ReturnType<typeof request.agent>; user: UserDTO };

async function register(app: App, email: string, displayName: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

/** A lookup that always resolves to a single, unambiguously public address. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

function htmlRes(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const pageWithTitle = (title: string): string => `<!doctype html><title>${title}</title>`;
/** No og:title AND no <title> tag — parseOpenGraph returns null (a "failed" fetch). */
const pageWithNoTitle = '<!doctype html><body>no title here</body>';

const asFetch = (impl: unknown): typeof fetch => impl as unknown as typeof fetch;

describe('link previews — event bus wiring', () => {
  let db: Db;
  let events: ChatEvents;
  let app: App;
  let alice: Actor;
  let bob: Actor;
  let dmId: number;
  let fetchFn: ReturnType<typeof vi.fn>;
  let handle: LinkPreviewHandle;
  let updates: MessageDTO[];

  beforeEach(async () => {
    db = createDb(':memory:');
    events = createChatEvents();
    app = createApp(db, events);
    fetchFn = vi.fn();
    handle = initLinkPreviews(db, events, { fetchFn: asFetch(fetchFn), lookupFn: publicLookup });

    updates = [];
    events.on('message:updated', (e: MessageUpdatedEvent) => updates.push(e.message));

    alice = await register(app, 'alice@example.com', 'Alice');
    bob = await register(app, 'bob@example.com', 'Bob');
    dmId = ((await alice.agent.post('/api/chats').send({ userId: bob.user.id })).body.chat.id) as number;
  });

  function rawRow(messageId: number) {
    return db.select().from(messages).where(eq(messages.id, messageId)).get();
  }

  it('attaches a preview after send, visible on GET and via a re-emitted message:updated', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Hello World')));

    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'check out https://example.com/article' });
    expect(sendRes.status).toBe(201);
    const messageId = sendRes.body.message.id as number;

    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);

    const expected: LinkPreviewDTO = {
      url: 'https://example.com/article',
      title: 'Hello World',
      description: null,
      imageUrl: null,
      siteName: null,
    };

    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    const fetched = history.body.messages.find((m: MessageDTO) => m.id === messageId) as MessageDTO;
    expect(fetched.linkPreview).toEqual(expected);

    // Exactly one message:updated was emitted (the attach) — the reentrant
    // self-check on the way back out must be a strict no-op.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe(messageId);
    expect(updates[0]!.linkPreview).toEqual(expected);
  });

  it('does nothing when the message has no URL', async () => {
    const res = await alice.agent.post(`/api/chats/${dmId}/messages`).send({ content: 'no links here' });
    await handle.lastDispatch;

    expect(fetchFn).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(rawRow(res.body.message.id as number)!.linkPreview).toBeNull();
  });

  it('does nothing when the fetch resolves to no preview (e.g. no title anywhere)', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithNoTitle));

    const res = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'dead link https://example.com/nope' });
    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(0);
    expect(rawRow(res.body.message.id as number)!.linkPreview).toBeNull();
  });

  it('race: a delete that lands mid-fetch prevents the write and the emit', async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchFn.mockReturnValueOnce(pending);

    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'https://example.com/slow' });
    const messageId = sendRes.body.message.id as number;
    // Capture the in-flight dispatch BEFORE the delete below fires its own
    // (synchronous, trivial) dispatch and reassigns handle.lastDispatch.
    const sendDispatch = handle.lastDispatch;

    const delRes = await alice.agent.delete(`/api/chats/${dmId}/messages/${messageId}`);
    expect(delRes.status).toBe(204);

    // Only now does the mocked fetch resolve — after the message is gone.
    resolveFetch(htmlRes(pageWithTitle('Should never attach')));
    await sendDispatch;

    expect(rawRow(messageId)!.linkPreview).toBeNull();
    expect(rawRow(messageId)!.deletedAt).not.toBeNull();

    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    const fetched = history.body.messages.find((m: MessageDTO) => m.id === messageId) as MessageDTO;
    expect(fetched.isDeleted).toBe(true);
    expect(fetched.linkPreview).toBeNull();

    // Exactly one message:updated (the delete's own tombstone) — the deferred
    // fetch resolving afterward must not produce a second one.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.isDeleted).toBe(true);
  });

  it('edit removing the URL clears the stored preview and re-emits', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Original')));
    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'see https://example.com/original' });
    const messageId = sendRes.body.message.id as number;
    await handle.lastDispatch;
    expect(rawRow(messageId)!.linkPreview).not.toBeNull();

    updates = [];
    fetchFn.mockClear();

    const editRes = await alice.agent
      .patch(`/api/chats/${dmId}/messages/${messageId}`)
      .send({ content: 'no more links' });
    expect(editRes.status).toBe(200);
    await handle.lastDispatch;

    expect(fetchFn).not.toHaveBeenCalled(); // no URL to fetch — pure clear
    expect(rawRow(messageId)!.linkPreview).toBeNull();

    // Two message:updated events land for this id: the edit's own (still
    // carrying the stale preview — editMessage never touches the column) and
    // our correction (cleared). Since our subscriber is registered before
    // this test's listener, its nested "clear" emit is fully delivered to
    // every listener before the *outer* emit loop reaches this listener for
    // the edit's own event — so the correction can arrive out of order. What
    // matters is that the clear landed at all; the GET below is the source of
    // truth for the final, converged state.
    const forThisMessage = updates.filter((m) => m.id === messageId);
    expect(forThisMessage.length).toBeGreaterThanOrEqual(1);
    expect(forThisMessage.some((m) => m.linkPreview === null)).toBe(true);

    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    const fetched = history.body.messages.find((m: MessageDTO) => m.id === messageId) as MessageDTO;
    expect(fetched.linkPreview).toBeNull();
  });

  it('edit swapping the URL refetches and replaces the stored preview', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('First Page')));
    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'https://example.com/first' });
    const messageId = sendRes.body.message.id as number;
    await handle.lastDispatch;
    expect(JSON.parse(rawRow(messageId)!.linkPreview!).url).toBe('https://example.com/first');

    fetchFn.mockClear();
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Second Page')));
    updates = [];

    const editRes = await alice.agent
      .patch(`/api/chats/${dmId}/messages/${messageId}`)
      .send({ content: 'now see https://example.com/second instead' });
    expect(editRes.status).toBe(200);
    await handle.lastDispatch;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://example.com/second');

    const stored = JSON.parse(rawRow(messageId)!.linkPreview!) as LinkPreviewDTO;
    expect(stored.url).toBe('https://example.com/second');
    expect(stored.title).toBe('Second Page');

    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    const fetched = history.body.messages.find((m: MessageDTO) => m.id === messageId) as MessageDTO;
    expect(fetched.linkPreview?.title).toBe('Second Page');
  });

  it('reaction toggles do not trigger a refetch or a spurious re-emit (loop guard)', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Reacted Page')));
    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'https://example.com/reacted' });
    const messageId = sendRes.body.message.id as number;
    await handle.lastDispatch;

    fetchFn.mockClear();
    updates = [];

    const emoji = REACTION_EMOJIS[0];
    const reactRes = await bob.agent
      .post(`/api/chats/${dmId}/messages/${messageId}/reactions`)
      .send({ emoji });
    expect(reactRes.status).toBe(200);
    await handle.lastDispatch;

    const unreactRes = await bob.agent
      .post(`/api/chats/${dmId}/messages/${messageId}/reactions`)
      .send({ emoji });
    expect(unreactRes.status).toBe(200);
    await handle.lastDispatch;

    // No refetch at all — the discriminator saw the URL unchanged both times.
    expect(fetchFn).not.toHaveBeenCalled();
    // Exactly the two toggleReaction emissions — no extra correction events.
    expect(updates).toHaveLength(2);
    expect(updates[0]!.linkPreview?.title).toBe('Reacted Page');
    expect(updates[1]!.linkPreview?.title).toBe('Reacted Page');
  });

  it('a tombstone never carries a preview even though the underlying column still has data', async () => {
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Doomed Page')));
    const sendRes = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'https://example.com/doomed' });
    const messageId = sendRes.body.message.id as number;
    await handle.lastDispatch;
    expect(rawRow(messageId)!.linkPreview).not.toBeNull();

    const delRes = await alice.agent.delete(`/api/chats/${dmId}/messages/${messageId}`);
    expect(delRes.status).toBe(204);
    await handle.lastDispatch;

    // The soft-delete leaves the column alone (like `content`) ...
    expect(rawRow(messageId)!.linkPreview).not.toBeNull();
    // ... but the DTO always neuters it.
    const history = await alice.agent.get(`/api/chats/${dmId}/messages`);
    const fetched = history.body.messages.find((m: MessageDTO) => m.id === messageId) as MessageDTO;
    expect(fetched.isDeleted).toBe(true);
    expect(fetched.linkPreview).toBeNull();
  });

  it('stop() unsubscribes both listeners', async () => {
    handle.stop();
    fetchFn.mockResolvedValueOnce(htmlRes(pageWithTitle('Should not fetch')));

    const res = await alice.agent
      .post(`/api/chats/${dmId}/messages`)
      .send({ content: 'https://example.com/after-stop' });
    // Give any (unexpected) in-flight work a chance to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(rawRow(res.body.message.id as number)!.linkPreview).toBeNull();
  });
});
