import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { instanceConfig } from '../instance';
import configApp from '../routes/config';

describe('instanceConfig', () => {
  it('keeps the original instance when nothing is set', () => {
    const config = instanceConfig({});
    expect(config).toEqual({
      name: 'TimDo',
      appUrl: 'https://timdo.tdobson.net',
      corsOrigins: ['http://localhost:3000', 'https://timdo.tdobson.net'],
      posterWorkProjects: null,
    });
  });

  it('lets another deployment name itself and allow its own origins', () => {
    const config = instanceConfig({
      INSTANCE_NAME: 'Freegle Tasks',
      APP_URL: 'https://tasks.example.org/',
      CORS_ORIGINS: ' https://tasks.example.org, http://localhost:3000 ,',
      POSTER_WORK_PROJECTS: 'Support, Fixes',
    });
    expect(config.name).toBe('Freegle Tasks');
    expect(config.appUrl).toBe('https://tasks.example.org');
    expect(config.corsOrigins).toEqual(['https://tasks.example.org', 'http://localhost:3000']);
    expect(config.posterWorkProjects).toEqual(['Support', 'Fixes']);
  });

  it('copes with no environment at all, as unit tests of routes have', () => {
    expect(instanceConfig(undefined).name).toBe('TimDo');
  });

  it('treats an empty work-project list as unset', () => {
    expect(instanceConfig({ POSTER_WORK_PROJECTS: ' , ' }).posterWorkProjects).toBeNull();
  });
});

describe('GET /api/v2/config', () => {
  it('is public and returns names and addresses only', async () => {
    const app = new Hono<any>();
    app.route('/api/v2/config', configApp);
    const res = await app.request(
      '/api/v2/config',
      {},
      { INSTANCE_NAME: 'Example', APP_URL: 'https://x.example' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: 'Example',
      appUrl: 'https://x.example',
      inviteBaseUrl: 'https://x.example/invite',
    });
  });
});
