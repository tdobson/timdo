import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as schema from './db/schema';
import { instanceConfig, type InstanceEnv } from './instance';
import { combinedAuthMiddleware, internalAuthMiddleware } from './middleware/auth';
import { requireFeature } from './middleware/features';
import activityApp from './routes/activity';
import aiApp from './routes/ai';
import configApp from './routes/config';
import customersApp from './routes/customers';
import epicsApp from './routes/epics';
import goalsApp from './routes/goals';
import organisationsApp from './routes/organisations';
import posterApp from './routes/poster';
import projectsApp from './routes/projects';
import tasksApp from './routes/tasks';
import userApp from './routes/user';
import { AccessError } from './services/accessService';
import { processAwaitingReturns } from './services/projectService';

export interface Env extends InstanceEnv {
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  GROQ_API_KEY: string;
  INTERNAL_API_SECRET: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    db: DrizzleD1Database<typeof schema>;
    userId: string;
    /** How the caller signed in: web session, personal token, or the owner's internal secret */
    authMethod: 'jwt' | 'token' | 'internal';
    /** Set when signed in with a personal token */
    tokenId?: string;
  }
}

const app = new Hono<{ Bindings: Env }>();

// Permission problems surface as 403/404 with a readable message, wherever they're thrown
app.onError((err, c) => {
  if (err instanceof AccessError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('[Unhandled]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Debugging middleware to log every request
app.use('*', async (c, next) => {
  console.log(`[Request Start] --> ${c.req.method} ${c.req.path}`);
  await next();
  console.log(`[Request End]   <-- ${c.req.method} ${c.req.path} - Status: ${c.res.status}`);
});

// CORS middleware should be one of the first to run. The allowed origins are per instance.
app.use('/api/v2/*', (c, next) =>
  cors({
    origin: instanceConfig(c.env).corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-Timdo-User'],
  })(c, next)
);

// DB middleware to make the DB instance available on all routes.
app.use('*', async (c, next) => {
  const dbInstance = drizzle(c.env.DB, { schema });
  c.set('db', dbInstance);
  await next();
});

// Apply authentication middleware only to the routes that need it.
// This runs AFTER the CORS middleware has already handled any OPTIONS requests.
app.use('/api/v2/organisations/*', combinedAuthMiddleware);
app.use('/api/v2/projects/*', combinedAuthMiddleware);
app.use('/api/v2/tasks/*', combinedAuthMiddleware);
app.use('/api/v2/customers/*', combinedAuthMiddleware);
app.use('/api/v2/goals/*', combinedAuthMiddleware);
app.use('/api/v2/epics/*', combinedAuthMiddleware);
app.use('/api/v2/ai/*', combinedAuthMiddleware);
app.use('/api/v2/poster/*', combinedAuthMiddleware);
app.use('/api/v2/activity/*', combinedAuthMiddleware);
app.use('/api/v2/activity', combinedAuthMiddleware);

// Features an instance has switched off answer 404 before their routes run.
app.use('/api/v2/goals/*', requireFeature('goals'));
app.use('/api/v2/goals', requireFeature('goals'));
app.use('/api/v2/poster/*', requireFeature('poster'));
app.use('/api/v2/ai/voice-command', requireFeature('voice'));
app.use('/api/v2/ai/parse-onboarding', requireFeature('voice'));

// Register route handlers. /config is public; everything else was given auth above.
app.route('/api/v2/config', configApp);
app.route('/api/v2/organisations', organisationsApp);
app.route('/api/v2/projects', projectsApp);
app.route('/api/v2/tasks', tasksApp);
app.route('/api/v2/customers', customersApp);
app.route('/api/v2/goals', goalsApp);
app.route('/api/v2/epics', epicsApp);
app.route('/api/v2/users', userApp);
app.route('/api/v2/ai', aiApp);
app.route('/api/v2/poster', posterApp);
app.route('/api/v2/activity', activityApp);

// Manual trigger for processing awaiting returns (useful for testing and CLI)
app.post('/api/v2/projects/process-awaiting', internalAuthMiddleware, async (c) => {
  const db = c.get('db');
  const result = await processAwaitingReturns(db);
  return c.json(result);
});

app.get('/', (c) => c.text('TimDo API v2'));

export default {
  fetch: app.fetch,

  // Cloudflare Workers scheduled handler — flips past-due awaiting items back to "do"
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const db = drizzle(env.DB, { schema });
    const result = await processAwaitingReturns(db);
    console.log(
      `[cron] processAwaitingReturns: flipped ${result.flipped} of ${result.total} due items`
    );
  },
};
