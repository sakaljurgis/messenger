import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createDb } from './db/index.js';

describe('app scaffold', () => {
  it('responds on /api/health', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /healthz', () => {
  it('serves an unauthenticated 200 { ok: true } when the DB probe succeeds', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 503 { ok: false } when the DB probe throws', async () => {
    const db = createDb(':memory:');
    const app = createApp(db);
    // Break the liveness probe by closing the underlying sqlite connection: the
    // `select 1` in the route then throws and the handler must map it to a 503.
    (db.$client as { close(): void }).close();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false });
  });
});
