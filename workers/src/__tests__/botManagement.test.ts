import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import botsApp from '../routes/bots';
import organisationsApp from '../routes/organisations';
import userApp from '../routes/user';
import * as botService from '../services/botService';
import { withActorContext } from '../services/requestActorContext';
import { hashToken } from '../services/tokenService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

const env = {
  INTERNAL_API_SECRET: 'fixture-owner-secret',
  AUTH0_DOMAIN: 'unused.invalid',
  AUTH0_AUDIENCE: 'fixture-api',
};

async function rejectsForControlCharacter(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return error instanceof Error && error.message.includes('control characters');
  }
  return false;
}

describe('workspace bot management', () => {
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
    app.use('/organisations/*', combinedAuthMiddleware);
    app.use('/users/*', combinedAuthMiddleware);
    app.route('/organisations', botsApp);
    app.route('/organisations', organisationsApp);
    app.route('/users', userApp);
  });

  const ownerHeaders = (email = 'casey@example.test') => ({
    'X-Internal-Secret': env.INTERNAL_API_SECRET,
    'X-Timdo-User': email,
  });
  const request = (
    path: string,
    headers: Record<string, string> = ownerHeaders(),
    init: RequestInit = {}
  ) =>
    app.request(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', ...headers } },
      env
    );
  const createBot = async (body: Record<string, unknown> = { name: 'Fixture Monitor' }) => {
    const res = await request('/organisations/org-md/bots', ownerHeaders(), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { res, body: (await res.json()) as any };
  };

  it('creates a bot, its home membership, one hashed token and an attributed audit atomically', async () => {
    const { res, body } = await createBot({ name: 'Fixture Monitor', tokenName: 'Forum reader' });

    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body.bot).toMatchObject({
      kind: 'bot',
      name: 'Fixture Monitor',
      role: 'member',
      createdByName: 'Casey Example',
    });
    expect(body.bot.id.startsWith('bot|')).toBe(true);
    expect(Object.hasOwn(body.bot, 'email')).toBe(false);
    expect(body.bot.tokens).toHaveLength(1);
    expect(body.bot.tokens[0]).toMatchObject({ name: 'Forum reader' });
    expect(/^tdo_[A-Za-z0-9_-]{30,}$/.test(body.token)).toBe(true);
    expect(JSON.stringify(body).includes('bots.timdo.invalid')).toBe(false);

    const stored = raw
      .prepare('SELECT token_hash, prefix FROM ApiTokens WHERE user_id = ?')
      .get(body.bot.id);
    const expectedHash = await hashToken(body.token);
    expect(stored.token_hash === expectedHash).toBe(true);
    expect(stored.token_hash.includes(body.token)).toBe(false);
    expect(
      raw.prepare('SELECT org_id, role FROM OrganisationMembers WHERE user_id = ?').get(body.bot.id)
    ).toEqual({
      org_id: 'org-md',
      role: 'member',
    });
    expect(
      raw
        .prepare('SELECT action, via, via_detail FROM ActivityLog WHERE entity_id = ?')
        .get(body.bot.id)
    ).toMatchObject({
      action: 'bot_created',
      via: 'owner_secret',
    });
    const logs = JSON.stringify(raw.prepare('SELECT summary, changes FROM ActivityLog').all());
    expect(logs.includes(body.token)).toBe(false);
    expect(logs.includes('bots.timdo.invalid')).toBe(false);
  });

  it('lists active bots to managers and omits disabled bot membership and token metadata', async () => {
    const { body } = await createBot();
    expect(body.bot.tokens[0].name).toBe('initial');
    const list = await request('/organisations/org-md/bots');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: body.bot.id,
      kind: 'bot',
      name: body.bot.name,
      role: 'member',
    });
    expect(JSON.stringify(listed).includes('bots.timdo.invalid')).toBe(false);

    const disabled = await request(`/organisations/org-md/bots/${body.bot.id}`, ownerHeaders(), {
      method: 'DELETE',
    });
    expect(disabled.status).toBe(204);
    const after = await request('/organisations/org-md/bots');
    const rows = (await after.json()) as any[];
    expect(rows[0]).toMatchObject({ disabledAt: expect.any(String), role: null, tokens: [] });
    expect(Object.hasOwn(rows[0], 'email')).toBe(false);
    expect(
      raw
        .prepare('SELECT count(*) as count FROM OrganisationMembers WHERE user_id = ?')
        .get(body.bot.id).count
    ).toBe(0);
  });

  it('renames, changes a bot role and issues/revokes only its own tokens with one-time credentials', async () => {
    const { body: created } = await createBot();
    const botId = created.bot.id;
    const renamed = await request(`/organisations/org-md/bots/${botId}`, ownerHeaders(), {
      method: 'PUT',
      body: JSON.stringify({ name: 'Fixture Reader', role: 'viewer' }),
    });
    expect(await renamed.json()).toMatchObject({ name: 'Fixture Reader', role: 'viewer' });

    const issued = await request(`/organisations/org-md/bots/${botId}/tokens`, ownerHeaders(), {
      method: 'POST',
      body: JSON.stringify({ name: 'Replacement' }),
    });
    const token = (await issued.json()) as any;
    expect(issued.status).toBe(201);
    expect(issued.headers.get('Cache-Control')).toBe('no-store');
    expect(token.name).toBe('Replacement');
    expect(typeof token.token).toBe('string');
    expect(token.token.startsWith('tdo_')).toBe(true);
    expect(Object.hasOwn(token, 'tokenHash')).toBe(false);

    const revoked = await request(
      `/organisations/org-md/bots/${botId}/tokens/${token.id}`,
      ownerHeaders(),
      {
        method: 'DELETE',
      }
    );
    expect(revoked.status).toBe(204);
    const again = await request(
      `/organisations/org-md/bots/${botId}/tokens/${token.id}`,
      ownerHeaders(),
      {
        method: 'DELETE',
      }
    );
    expect(again.status).toBe(204);
    const actions = raw
      .prepare('SELECT action FROM ActivityLog WHERE entity_id = ? ORDER BY created_at')
      .all(botId)
      .map((r: any) => r.action);
    expect(actions).toEqual([
      'bot_created',
      'bot_renamed',
      'bot_role_changed',
      'bot_token_created',
      'bot_token_revoked',
    ]);
  });

  it('rejects non-managers, personal tokens and non-human actors without writing', async () => {
    const memberToken = await (
      await import('../services/tokenService')
    ).createToken(db, ROBIN, 'member client');
    const denied = await request('/organisations/org-md/bots', {
      Authorization: `Bearer ${memberToken.token}`,
    });
    expect(denied.status).toBe(403);

    const noAccess = await request(
      '/organisations/org-md/bots',
      ownerHeaders('stranger@example.com')
    );
    expect(noAccess.status).toBe(404);
    expect(raw.prepare("SELECT count(*) as count FROM Users WHERE kind = 'bot'").get().count).toBe(
      0
    );
    expect(
      raw.prepare("SELECT count(*) as count FROM ActivityLog WHERE action LIKE 'bot_%'").get().count
    ).toBe(0);
  });

  it('validates bot and token names before writing', async () => {
    for (const name of [
      '',
      '   ',
      'Fixture\nBot',
      '\nFixture Bot',
      'Fixture\u0085Bot',
      'Fixture\u009fBot',
      'x'.repeat(81),
    ]) {
      const response = await request('/organisations/org-md/bots', ownerHeaders(), {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(400);
    }
    expect(raw.prepare("SELECT count(*) as count FROM Users WHERE kind = 'bot'").get().count).toBe(
      0
    );

    const accepted = await createBot({ name: 'Mönitor', tokenName: 'Lecteur' });
    expect(accepted.res.status).toBe(201);
    expect(accepted.body.bot).toMatchObject({ name: 'Mönitor' });
    expect(accepted.body.bot.tokens[0]).toMatchObject({ name: 'Lecteur' });
    for (const name of ['Fixture\u009fToken', '\tFixture Token']) {
      const invalidToken = await request(
        `/organisations/org-md/bots/${accepted.body.bot.id}/tokens`,
        ownerHeaders(),
        {
          method: 'POST',
          body: JSON.stringify({ name }),
        }
      );
      expect(invalidToken.status).toBe(400);
      expect(
        raw
          .prepare(
            'SELECT count(*) as count FROM ApiTokens WHERE user_id = ? AND revoked_at IS NULL'
          )
          .get(accepted.body.bot.id).count
      ).toBe(1);
    }
  });

  it('applies the same Unicode control checks in direct lifecycle services', async () => {
    const botsBefore = raw
      .prepare("SELECT count(*) as count FROM Users WHERE kind = 'bot'")
      .get().count;
    for (const name of ['Fixture\u0085Bot', '\nFixture Bot']) {
      const rejected = await rejectsForControlCharacter(() =>
        withActorContext(db, { via: 'owner_secret' }, () =>
          botService.createBot(db, TIM, 'org-md', {
            name,
            role: 'member',
            tokenName: 'initial',
          })
        )
      );
      expect(rejected).toBe(true);
      expect(
        raw.prepare("SELECT count(*) as count FROM Users WHERE kind = 'bot'").get().count
      ).toBe(botsBefore);
    }

    const { bot } = await withActorContext(db, { via: 'owner_secret' }, () =>
      botService.createBot(db, TIM, 'org-md', {
        name: 'Étoile',
        role: 'member',
        tokenName: 'Rédacteur',
      })
    );
    expect(bot).toMatchObject({
      name: 'Étoile',
      tokens: [expect.objectContaining({ name: 'Rédacteur' })],
    });

    for (const name of ['Fixture\u009fToken', '\tFixture Token']) {
      const rejected = await rejectsForControlCharacter(() =>
        withActorContext(db, { via: 'owner_secret' }, () =>
          botService.createBotToken(db, TIM, 'org-md', bot.id, { name })
        )
      );
      expect(rejected).toBe(true);
      expect(
        raw
          .prepare(
            'SELECT count(*) as count FROM ApiTokens WHERE user_id = ? AND revoked_at IS NULL'
          )
          .get(bot.id).count
      ).toBe(1);
    }
  });

  it('rolls back bot creation if the lifecycle audit cannot be inserted', async () => {
    raw.exec(
      `CREATE TRIGGER reject_bot_audit BEFORE INSERT ON ActivityLog WHEN NEW.action = 'bot_created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`
    );

    const { res } = await createBot();

    expect(res.status).toBe(500);
    expect(raw.prepare("SELECT count(*) as count FROM Users WHERE kind = 'bot'").get().count).toBe(
      0
    );
    expect(
      raw
        .prepare("SELECT count(*) as count FROM OrganisationMembers WHERE user_id LIKE 'bot|%'")
        .get().count
    ).toBe(0);
    expect(
      raw.prepare("SELECT count(*) as count FROM ApiTokens WHERE user_id LIKE 'bot|%'").get().count
    ).toBe(0);
  });

  it('enforces the active-token cap under concurrent issuance and makes disable retry idempotent', async () => {
    const { body: created } = await createBot();
    const botId = created.bot.id;
    for (let i = 0; i < 18; i++) {
      const res = await request(`/organisations/org-md/bots/${botId}/tokens`, ownerHeaders(), {
        method: 'POST',
        body: JSON.stringify({ name: `Fixture token ${i}` }),
      });
      expect(res.status).toBe(201);
    }

    const concurrent = await Promise.all([
      request(`/organisations/org-md/bots/${botId}/tokens`, ownerHeaders(), {
        method: 'POST',
        body: JSON.stringify({ name: 'Race one' }),
      }),
      request(`/organisations/org-md/bots/${botId}/tokens`, ownerHeaders(), {
        method: 'POST',
        body: JSON.stringify({ name: 'Race two' }),
      }),
    ]);
    expect(concurrent.map((res) => res.status).sort()).toEqual([201, 400]);
    expect(
      raw
        .prepare('SELECT count(*) as count FROM ApiTokens WHERE user_id = ? AND revoked_at IS NULL')
        .get(botId).count
    ).toBe(20);

    const firstDisable = await request(`/organisations/org-md/bots/${botId}`, ownerHeaders(), {
      method: 'DELETE',
    });
    const retryDisable = await request(`/organisations/org-md/bots/${botId}`, ownerHeaders(), {
      method: 'DELETE',
    });
    expect([firstDisable.status, retryDisable.status]).toEqual([204, 204]);
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_disabled'"
        )
        .get(botId).count
    ).toBe(1);
  });

  it('returns a known disabled bot token as disabled without exposing token details', async () => {
    const { body: created } = await createBot();
    const botToken = created.token;
    const botId = created.bot.id;
    await request(`/organisations/org-md/bots/${botId}`, ownerHeaders(), { method: 'DELETE' });

    const whoami = await request('/users/me', { Authorization: `Bearer ${botToken}` });
    expect(whoami.status).toBe(401);
    expect(await whoami.json()).toEqual({ error: 'This bot has been disabled' });
  });

  it('denies bot-token management with the web-management instruction and no lifecycle writes', async () => {
    const { body } = await createBot();
    const before = raw
      .prepare("SELECT count(*) as count FROM ActivityLog WHERE action LIKE 'bot_%'")
      .get().count;
    const response = await request('/organisations/org-md/bots', {
      Authorization: `Bearer ${body.token}`,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Bots are managed on the web: https://timdo.tdobson.net/sharing',
    });
    expect(
      raw.prepare("SELECT count(*) as count FROM ActivityLog WHERE action LIKE 'bot_%'").get().count
    ).toBe(before);
  });
});
