import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import botsApp from '../routes/bots';
import * as activityService from '../services/activityService';
import { createToken } from '../services/tokenService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

const localKeys = vi.hoisted(() => ({ jwks: { keys: [] as any[] } }));
vi.mock('jose', async (importOriginal) => {
  const jose = await importOriginal<typeof import('jose')>();
  return {
    ...jose,
    createRemoteJWKSet: () => jose.createLocalJWKSet(localKeys.jwks),
  };
});

const domain = 'fixture-auth.invalid';
const audience = 'fixture-api';
const ownerSecret = 'fixture-owner-secret';

describe('signed JWT and owner-secret bot identity handling', () => {
  let db: any;
  let raw: any;
  let app: Hono<any>;
  let privateKey: any;
  let otherPrivateKey: any;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    const otherPair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherPrivateKey = otherPair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    localKeys.jwks.keys = [{ ...publicJwk, kid: 'fixture-key', use: 'sig', alg: 'RS256' }];
  });

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    raw
      .prepare('UPDATE Users SET created_at = ? WHERE id = ?')
      .run('1999-01-01T00:00:00.000Z', TIM);
    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by, created_at) VALUES ('bot|jwt-001', 'bot+jwt-001@bots.timdo.invalid', 'Fixture JWT Bot', 'bot', 'org-md', ?, '2000-01-01T00:00:00.000Z')"
      )
      .run(TIM);
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/organisations/*', combinedAuthMiddleware);
    app.route('/organisations', botsApp);
    app.get('/whoami', combinedAuthMiddleware, (c) =>
      c.json({ userId: c.get('userId'), authMethod: c.get('authMethod') })
    );
    app.post('/audit/:action', combinedAuthMiddleware, async (c) => {
      await activityService.logActivity(db, {
        actorId: c.get('userId'),
        entityType: 'member',
        entityId: c.get('userId'),
        action: c.req.param('action'),
        summary: 'Fixture auth event',
      });
      return c.json({ ok: true });
    });
  });

  const env = { AUTH0_DOMAIN: domain, AUTH0_AUDIENCE: audience, INTERNAL_API_SECRET: ownerSecret };
  const sign = async (
    sub: string,
    options: { key?: any; issuer?: string; audience?: string; expiration?: string } = {}
  ) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
      .setIssuedAt()
      .setExpirationTime(options.expiration ?? '5m')
      .setIssuer(options.issuer ?? `https://${domain}/`)
      .setAudience(options.audience ?? audience)
      .setSubject(sub)
      .sign(options.key ?? privateKey);

  it('verifies a real signed human JWT against the local mocked JWKS and records web provenance', async () => {
    const token = await sign(TIM);
    const response = await app.request(
      '/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: TIM, authMethod: 'jwt' });

    await app.request(
      '/audit/jwt-created',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(
      raw.prepare("SELECT via, via_detail FROM ActivityLog WHERE action = 'jwt-created'").get()
    ).toEqual({
      via: 'web',
      via_detail: null,
    });
  });

  it('rejects a valid signed JWT whose subject is a stored bot', async () => {
    const token = await sign('bot|jwt-001');
    const response = await app.request(
      '/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Bots cannot use web authentication' });
  });

  it('rejects invalid signature, issuer, audience and expiry through real JWT verification', async () => {
    const invalid = [
      await sign(TIM, { key: otherPrivateKey }),
      await sign(TIM, { issuer: 'https://wrong.fixture.invalid/' }),
      await sign(TIM, { audience: 'wrong-audience' }),
      await sign(TIM, { expiration: '0s' }),
    ];
    const responses = await Promise.all(
      invalid.map((token) =>
        app.request('/whoami', { headers: { Authorization: `Bearer ${token}` } }, env)
      )
    );
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  });

  it('defaults owner-secret selection to a human even when the bot is older, but allows explicit bot act-as', async () => {
    const defaultResponse = await app.request(
      '/whoami',
      { headers: { 'X-Internal-Secret': ownerSecret } },
      env
    );
    expect(await defaultResponse.json()).toEqual({ userId: TIM, authMethod: 'internal' });

    const explicit = await app.request(
      '/whoami',
      {
        headers: {
          'X-Internal-Secret': ownerSecret,
          'X-Timdo-User': 'bot+jwt-001@bots.timdo.invalid',
        },
      },
      env
    );
    expect(await explicit.json()).toEqual({ userId: 'bot|jwt-001', authMethod: 'internal' });
  });

  it('permits owner JWT management, denies member JWT access, and keeps explicit bot act-as restricted', async () => {
    const ownerToken = await sign(TIM);
    const createdResponse = await app.request(
      '/organisations/org-md/bots',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fixture JWT Managed Bot' }),
      },
      env
    );
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get('Cache-Control')).toBe('no-store');
    const created = (await createdResponse.json()) as any;
    expect(created.bot).toMatchObject({
      name: 'Fixture JWT Managed Bot',
      kind: 'bot',
      role: 'member',
    });
    expect(Object.hasOwn(created.bot, 'email')).toBe(false);

    const memberToken = await sign(ROBIN);
    const memberList = await app.request(
      '/organisations/org-md/bots',
      { headers: { Authorization: `Bearer ${memberToken}` } },
      env
    );
    expect(memberList.status).toBe(403);
    expect(await memberList.json()).toEqual({
      error: 'Only workspace owners and admins can manage bots',
    });

    const explicitBotActAs = await app.request(
      `/organisations/org-md/bots/${created.bot.id}`,
      {
        method: 'PUT',
        headers: {
          'X-Internal-Secret': ownerSecret,
          'X-Timdo-User': `bot+${created.bot.id.slice(4)}@bots.timdo.invalid`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Fixture Restricted Rename' }),
      },
      env
    );
    expect(explicitBotActAs.status).toBe(403);
    expect(await explicitBotActAs.json()).toEqual({
      error: 'Bots are managed on the web: https://timdo.tdobson.net/sharing',
    });
  });

  it('records token name as request provenance and keeps the credential out of activity rows', async () => {
    const { token } = await createToken(db, ROBIN, 'Fixture token label');
    const response = await app.request(
      '/audit/token-created',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(response.status).toBe(200);
    expect(
      raw
        .prepare(
          "SELECT via, via_detail, summary, changes FROM ActivityLog WHERE action = 'token-created'"
        )
        .get()
    ).toEqual({
      via: 'token',
      via_detail: 'Fixture token label',
      summary: 'Fixture auth event',
      changes: null,
    });
  });
});
