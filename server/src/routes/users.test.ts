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
    });
  });
});
