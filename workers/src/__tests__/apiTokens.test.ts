/**
 * Personal access tokens: they act only as their owner, can be revoked, and can't mint more.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { combinedAuthMiddleware } from '../middleware/auth';
import userApp from '../routes/user';
import * as tokenService from '../services/tokenService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

describe('personal access tokens', () => {
  let db: any;
  let raw: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.get('/whoami', combinedAuthMiddleware, (c) =>
      c.json({ userId: c.get('userId'), via: c.get('authMethod') })
    );
    app.route('/users', userApp);
  });

  const env = { INTERNAL_API_SECRET: 'owner-secret', AUTH0_DOMAIN: 'x', AUTH0_AUDIENCE: 'y' };
  const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    app.request(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', ...headers } },
      env
    );

  it('is shown once, stored hashed, and acts as its owner', async () => {
    const created = await tokenService.createToken(db, ROBIN, 'Laptop CLI');
    expect(created.token).toMatch(/^tdo_[A-Za-z0-9_-]{30,}$/);
    const stored = raw.prepare('SELECT token_hash, prefix FROM ApiTokens').get();
    expect(stored.token_hash).not.toContain(created.token);
    expect(created.token.startsWith(stored.prefix)).toBe(true);

    const res = await call('/whoami', { Authorization: `Bearer ${created.token}` });
    expect(await res.json()).toEqual({ userId: ROBIN, via: 'token' });
    expect((await tokenService.listTokens(db, ROBIN))[0].lastUsedAt).not.toBeNull();
  });

  it('can never act as someone else', async () => {
    const { token } = await tokenService.createToken(db, ROBIN, 'cli');
    const res = await call('/whoami', {
      Authorization: `Bearer ${token}`,
      'X-Timdo-User': 'casey@example.test',
    });
    expect(res.status).toBe(403);
    // Naming yourself is fine
    const self = await call('/whoami', {
      Authorization: `Bearer ${token}`,
      'X-Timdo-User': 'Jordan@Example.test',
    });
    expect(await self.json()).toMatchObject({ userId: ROBIN });
  });

  it('stops working once revoked, and only its owner can revoke it', async () => {
    const { id, token } = await tokenService.createToken(db, ROBIN, 'cli');
    expect(await tokenService.revokeToken(db, TIM, id)).toBe(false);
    expect(await tokenService.revokeToken(db, ROBIN, id)).toBe(true);
    const res = await call('/whoami', { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(await tokenService.listTokens(db, ROBIN)).toEqual([]);
  });

  it('rejects unknown tokens', async () => {
    const res = await call('/whoami', { Authorization: 'Bearer tdo_not-a-real-token-at-all' });
    expect(res.status).toBe(401);
  });

  it('cannot be used to create more tokens', async () => {
    const { token } = await tokenService.createToken(db, ROBIN, 'cli');
    const res = await call(
      '/users/me/tokens',
      { Authorization: `Bearer ${token}` },
      { method: 'POST', body: JSON.stringify({ name: 'another' }) }
    );
    expect(res.status).toBe(403);
    const list = await call('/users/me/tokens', { Authorization: `Bearer ${token}` });
    expect(((await list.json()) as any[]).map((t) => t.name)).toEqual(['cli']);
  });

  it('keeps the owner secret able to act as anyone, for the owner CLI', async () => {
    const res = await call('/whoami', {
      'X-Internal-Secret': 'owner-secret',
      'X-Timdo-User': 'jordan@example.test',
    });
    expect(await res.json()).toEqual({ userId: ROBIN, via: 'internal' });
  });
});

describe('token and secret hardening', () => {
  let db: any;
  let raw: any;
  let app: Hono<any>;
  const env = { INTERNAL_API_SECRET: 'owner-secret', AUTH0_DOMAIN: 'x', AUTH0_AUDIENCE: 'y' };

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.route('/users', userApp);
  });

  it('lets a token revoke only itself', async () => {
    const a = await tokenService.createToken(db, ROBIN, 'laptop');
    const b = await tokenService.createToken(db, ROBIN, 'desktop');
    const other = await app.request(
      `/users/me/tokens/${b.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } },
      env
    );
    expect(other.status).toBe(403);
    const self = await app.request(
      `/users/me/tokens/${a.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } },
      env
    );
    expect(self.status).toBe(200);
    expect((await tokenService.listTokens(db, ROBIN)).map((t) => t.name)).toEqual(['desktop']);
  });

  it('refuses X-Timdo-User on a web (JWT) session before checking the token', async () => {
    const res = await app.request(
      '/users/me',
      { headers: { Authorization: 'Bearer some.jwt.value', 'X-Timdo-User': 'casey@example.test' } },
      env
    );
    expect(res.status).toBe(403);
  });

  it('fails closed when the internal secret is not configured', async () => {
    const res = await app.request(
      '/users/ensure',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x', email: 'x@example.com' }),
      },
      { AUTH0_DOMAIN: 'x', AUTH0_AUDIENCE: 'y' }
    );
    expect(res.status).toBe(403);
  });
});
