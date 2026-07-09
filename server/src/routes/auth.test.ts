import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';

function makeApp() {
  return createApp(createDb(':memory:'));
}

const VALID = {
  email: 'Alice@Example.com',
  password: 'supersecret',
  displayName: '  Alice  ',
};

/** Pull the `sid` cookie string out of a Set-Cookie header, if present. */
function sidCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as string[] | undefined;
  return raw?.find((c) => c.startsWith('sid='));
}

describe('POST /api/auth/register', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('creates a user, returns a safe DTO and sets an httpOnly sid cookie', async () => {
    const res = await request(app).post('/api/auth/register').send(VALID);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      email: 'alice@example.com', // lowercased
      displayName: 'Alice', // trimmed
      isBot: false,
    });
    // Never leak sensitive fields.
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.user).not.toHaveProperty('apiToken');
    expect(res.body.user).not.toHaveProperty('webhookUrl');
    expect(res.body.user).not.toHaveProperty('createdAt');

    const cookie = sidCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('sid=');
    expect(cookie).toContain('HttpOnly');
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').send(VALID);
    const res = await request(app).post('/api/auth/register').send(VALID);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Email already registered');
  });

  it('treats emails as case-insensitive for duplicates', async () => {
    await request(app).post('/api/auth/register').send(VALID);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID, email: 'ALICE@example.com' });
    expect(res.status).toBe(409);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects a short password with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty (whitespace-only) displayName with 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID, displayName: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    app = makeApp();
    await request(app).post('/api/auth/register').send(VALID);
  });

  it('logs in with correct credentials and sets a cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'supersecret' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(sidCookie(res)).toBeDefined();
  });

  it('accepts the email in any case', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ALICE@EXAMPLE.COM', password: 'supersecret' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
    expect(sidCookie(res)).toBeUndefined();
  });

  it('rejects an unknown email with 401 (same message)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'supersecret' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user when authenticated', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    const reg = await agent.post('/api/auth/register').send(VALID);

    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(reg.body.user);
  });

  it('returns 401 without a cookie', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 401 with a garbage sid cookie', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'sid=totally-bogus-token');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session so the cookie no longer works', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send(VALID);

    // Authenticated before logout.
    expect((await agent.get('/api/auth/me')).status).toBe(200);

    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(204);

    // Cookie is cleared and the server-side session is gone.
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('requires authentication', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });
});
