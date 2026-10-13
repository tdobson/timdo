import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import * as schema from './db/schema';
import { onApiError } from './middleware/apiErrors';
import { combinedAuthMiddleware, internalAuthMiddleware } from './middleware/auth';
import activityApp from './routes/activity';
import aiApp from './routes/ai';
import botsApp from './routes/bots';
import customersApp from './routes/customers';
import epicsApp from './routes/epics';
import eventsApp from './routes/events';
import goalsApp from './routes/goals';
import organisationsApp from './routes/organisations';
import posterApp from './routes/poster';
import projectsApp from './routes/projects';
import refsApp from './routes/refs';
import tasksApp from './routes/tasks';
import userApp from './routes/user';
import { processAwaitingReturns } from './services/projectService';

export interface Env {
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  GROQ_API_KEY: string;
  INTERNAL_API_SECRET: string;
  EVENT_CURSOR_KEY?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    db: DrizzleD1Database<typeof schema>;
    userId: string;
    userKind: 'human' | 'bot';
    /** How the caller signed in: web session, personal token, or the owner's internal secret */
    authMethod: 'jwt' | 'token' | 'internal';
    /** Set when signed in with a personal token */
    tokenId?: string;
  }
}

const app = new Hono<{ Bindings: Env }>();

// Permission and ref problems become readable 4xx answers, wherever they're thrown
app.onError(onApiError);

// Debugging middleware to log every request
app.use('*', async (c, next) => {
  console.log(`[Request Start] --> ${c.req.method} ${c.req.path}`);
  await next();
  console.log(`[Request End]   <-- ${c.req.method} ${c.req.path} - Status: ${c.res.status}`);
});

// Cursor endpoints must never be cached, including failures produced by auth middleware.
// These wrappers run outside CORS so preflight responses keep the same cache policy.
const noStoreCursorResponse = async (c: Context<{ Bindings: Env }>, next: Next) => {
  c.header('Cache-Control', 'no-store');
  try {
    await next();
  } finally {
    c.header('Cache-Control', 'no-store');
  }
};
const noStorePagedActivity = async (c: Context<{ Bindings: Env }>, next: Next) => {
  if (c.req.query('paged') === undefined) {
    return next();
  }
  c.header('Cache-Control', 'no-store');
  try {
    await next();
  } finally {
    c.header('Cache-Control', 'no-store');
  }
};
app.use('/api/v2/events', noStoreCursorResponse);
app.use('/api/v2/events/*', noStoreCursorResponse);
app.use('/api/v2/activity', noStorePagedActivity);
app.use('/api/v2/activity/*', noStorePagedActivity);

// CORS middleware should be one of the first to run.
app.use(
  '/api/v2/*',
  cors({
    origin: ['http://localhost:3000', 'https://timdo.tdobson.net'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Secret', 'X-Timdo-User'],
    exposeHeaders: ['X-Total-Count', 'X-Next-Cursor'],
  })
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
app.use('/api/v2/events/*', combinedAuthMiddleware);
app.use('/api/v2/events', combinedAuthMiddleware);
app.use('/api/v2/refs/*', combinedAuthMiddleware);

// Register route handlers.
app.route('/api/v2/organisations', botsApp);
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
app.route('/api/v2/events', eventsApp);
app.route('/api/v2/refs', refsApp);

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
