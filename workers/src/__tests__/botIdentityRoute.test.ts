import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import userApp from '../routes/user';
import * as botService from '../services/botService';
import { withActorContext } from '../services/requestActorContext';
import { createToken } from '../services/tokenService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

const env = {
  INTERNAL_API_SECRET: 'fixture-owner-secret',
  AUTH0_DOMAIN: 'fixture.invalid',
  AUTH0_AUDIENCE: 'fixture-api',
};

describe('bot self identity and own-token API', () => {
  let db: any;
  let raw: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/users/*', combinedAuthMiddleware);
    app.route('/users', userApp);
  });

  it('omits synthetic email, reports home workspace, and allows only the bot token to revoke itself', async () => {
    const created = await withActorContext(db, { via: 'owner_secret' }, () =>
      botService.createBot(db, TIM, 'org-md', {
        name: 'Fixture Monitor',
        role: 'member',
        tokenName: 'initial',
      })
    );
    const auth = { Authorization: `Bearer ${created.token}` };
    const me = await app.request('/users/me', { headers: auth }, env);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as any;
    expect(meBody.id).toBe(created.bot.id);
    expect(meBody.name).toBe('Fixture Monitor');
    expect(meBody.kind).toBe('bot');
    expect(meBody.workspace).toEqual({ id: 'org-md', name: 'Northstar Workshop', role: 'member' });
    expect(Object.hasOwn(meBody, 'email')).toBe(false);

    const tokens = await app.request('/users/me/tokens', { headers: auth }, env);
    const tokenRows = (await tokens.json()) as any[];
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({ id: created.bot.tokens[0].id, name: 'initial' });
    expect(JSON.stringify(tokenRows).includes('bots.timdo.invalid')).toBe(false);

    const cannotMint = await app.request(
      '/users/me/tokens',
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'another' }),
      },
      env
    );
    expect(cannotMint.status).toBe(403);

    const ownerSecretActAs = await app.request(
      `/users/me/tokens/${created.bot.tokens[0].id}`,
      {
        method: 'DELETE',
        headers: {
          'X-Internal-Secret': env.INTERNAL_API_SECRET,
          'X-Timdo-User': `bot+${created.bot.id.slice(4)}@bots.timdo.invalid`,
        },
      },
      env
    );
    expect(ownerSecretActAs.status).toBe(403);
    expect(
      raw
        .prepare('SELECT count(*) as count FROM ApiTokens WHERE user_id = ? AND revoked_at IS NULL')
        .get(created.bot.id).count
    ).toBe(1);

    const revoked = await app.request(
      `/users/me/tokens/${created.bot.tokens[0].id}`,
      { method: 'DELETE', headers: auth },
      env
    );
    expect(revoked.status).toBe(200);
    const invalid = await app.request('/users/me', { headers: auth }, env);
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'This token is invalid or has been revoked' });
    await expect(createToken(db, created.bot.id, 'Fixture personal token')).rejects.toThrow();
  });
});
