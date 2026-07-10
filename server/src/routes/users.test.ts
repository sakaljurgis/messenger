import type { UserDTO } from '@messenger/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createDb } from '../db/index.js';

function makeApp() {
  return createApp(createDb(':memory:'));
}

async function register(
  app: ReturnType<typeof createApp>,
  email: string,
  displayName: string,
) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/register')
    .send({ email, password: 'supersecret', displayName });
  return { agent, user: res.body.user as UserDTO };
}

describe('GET /api/users', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('excludes the requester and sorts by displayName (case-insensitive)', async () => {
    // Uppercase names would sort before lowercase ones in a naive ASCII sort;
    // a case-insensitive sort interleaves them.
    const { agent } = await register(app, 'alice@example.com', 'alice');
    await register(app, 'zoe@example.com', 'Zoe');
    await register(app, 'anna@example.com', 'anna');
    await register(app, 'bob@example.com', 'Bob');

    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
    const names = res.body.users.map((u: UserDTO) => u.displayName);
    expect(names).toEqual(['anna', 'Bob', 'Zoe']);
    expect(names).not.toContain('alice');
  });

  it('returns safe UserDTOs (no sensitive fields)', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    await register(app, 'bob@example.com', 'Bob');
    const res = await agent.get('/api/users');
    expect(res.body.users[0]).not.toHaveProperty('passwordHash');
    expect(res.body.users[0]).toEqual({
      id: expect.any(Number),
      email: 'bob@example.com',
      displayName: 'Bob',
      isBot: false,
      color: null,
    });
  });
});

describe('PATCH /api/users/me', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('requires authentication', async () => {
    const res = await request(app).patch('/api/users/me').send({ displayName: 'X' });
    expect(res.status).toBe(401);
  });

  it('updates the display name (trimmed) and returns the fresh UserDTO', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent.patch('/api/users/me').send({ displayName: '  Alicia  ' });
    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('Alicia');
    expect(res.body.user).not.toHaveProperty('passwordHash');

    // Persisted: /me reflects the new name.
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.displayName).toBe('Alicia');
  });

  it('rejects an empty display name with 400', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent.patch('/api/users/me').send({ displayName: '   ' });
    expect(res.status).toBe(400);
  });

  it('leaves color unchanged when omitted', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    await agent.patch('/api/users/me').send({ displayName: 'Alice', color: '#123abc' });

    const res = await agent.patch('/api/users/me').send({ displayName: 'Alicia' });
    expect(res.status).toBe(200);
    expect(res.body.user.color).toBe('#123abc');
  });

  it('sets and normalizes a valid hex color to lowercase', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent.patch('/api/users/me').send({ displayName: 'Alice', color: '#ABC123' });
    expect(res.status).toBe(200);
    expect(res.body.user.color).toBe('#abc123');
  });

  it('rejects an invalid hex color with 400', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent.patch('/api/users/me').send({ displayName: 'Alice', color: 'not-a-color' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('reverts to the derived default when color is null', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    await agent.patch('/api/users/me').send({ displayName: 'Alice', color: '#123abc' });

    const res = await agent.patch('/api/users/me').send({ displayName: 'Alice', color: null });
    expect(res.status).toBe(200);
    expect(res.body.user.color).toBeNull();
  });
});

describe('PUT /api/users/me/password', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .put('/api/users/me/password')
      .send({ currentPassword: 'supersecret', newPassword: 'evenmoresecret' });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong current password with 400', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent
      .put('/api/users/me/password')
      .send({ currentPassword: 'wrong-password', newPassword: 'evenmoresecret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is incorrect');
  });

  it('rejects a too-short new password with 400', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent
      .put('/api/users/me/password')
      .send({ currentPassword: 'supersecret', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('changes the password: old stops working, new logs in', async () => {
    const { agent } = await register(app, 'alice@example.com', 'Alice');
    const res = await agent
      .put('/api/users/me/password')
      .send({ currentPassword: 'supersecret', newPassword: 'evenmoresecret' });
    expect(res.status).toBe(204);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'supersecret' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'evenmoresecret' });
    expect(newLogin.status).toBe(200);
  });
});
