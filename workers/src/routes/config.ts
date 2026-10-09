import { Hono } from 'hono';
import type { Env } from '../index';
import { instanceConfig } from '../instance';

/**
 * GET /api/v2/config: what this instance is called and where it lives. Public, because the
 * sign-in page needs it before anyone has signed in. Nothing secret is returned.
 */
const configApp = new Hono<{ Bindings: Env }>();

configApp.get('/', (c) => {
  const config = instanceConfig(c.env);
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    name: config.name,
    appUrl: config.appUrl,
    inviteBaseUrl: `${config.appUrl}/invite`,
    features: config.features,
  });
});

export default configApp;
