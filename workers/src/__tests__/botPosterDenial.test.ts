import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import posterApp from '../routes/poster';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

const env = {
  INTERNAL_API_SECRET: 'fixture-owner-secret',
  AUTH0_DOMAIN: 'fixture.invalid',
  AUTH0_AUDIENCE: 'fixture-api',
};

describe('bot personal-goal poster denial', () => {
  let app: Hono<any>;

  beforeEach(() => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|poster-001', 'bot+poster-001@bots.timdo.invalid', 'Fixture Poster Bot', 'bot', 'org-md', ?)"
      )
      .run(TIM);
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/poster/*', combinedAuthMiddleware);
    app.route('/poster', posterApp);
  });

  it('denies goal poster requests before reading goal data', async () => {
    const response = await app.request(
      '/poster/goals-rhythm',
      {
        headers: {
          'X-Internal-Secret': env.INTERNAL_API_SECRET,
          'X-Timdo-User': 'bot+poster-001@bots.timdo.invalid',
        },
      },
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Bots do not have life goals' });
  });
});
