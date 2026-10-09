import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { combinedAuthMiddleware, internalAuthMiddleware } from '../middleware/auth';
import * as tokenService from '../services/tokenService';
import { ensureUser } from '../services/userService';
import { tokenCreateSchema, userCreateSchema } from '../validators/userValidators';

const userApp = new Hono<{ Bindings: Env }>();

// This endpoint is protected by a shared secret, as it's called server-to-server from Next.js.
userApp.post('/ensure', internalAuthMiddleware, zValidator('json', userCreateSchema), async (c) => {
  const userData = c.req.valid('json');
  const db = c.get('db');
  const user = await ensureUser(db, userData);
  return c.json(user);
});

// The signed-in user, so clients can tell "me" from collaborators
userApp.get('/me', combinedAuthMiddleware, async (c) => {
  const db = c.get('db');
  const user = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, c.get('userId')))
    .get();
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  c.header('Cache-Control', 'private, max-age=300');
  return c.json(user);
});

// Personal access tokens for the CLI and MCP
userApp.get('/me/tokens', combinedAuthMiddleware, async (c) => {
  return c.json(await tokenService.listTokens(c.get('db'), c.get('userId')));
});

userApp.post(
  '/me/tokens',
  combinedAuthMiddleware,
  zValidator('json', tokenCreateSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.issues[0]?.message || 'Invalid token name' }, 400);
    }
  }),
  async (c) => {
    // Only a signed-in browser session can mint tokens, so a leaked token can't make more
    if (c.get('authMethod') !== 'jwt') {
      return c.json(
        { error: 'Create tokens from the TimDo web app (Settings, CLI and MCP access)' },
        403
      );
    }
    try {
      const created = await tokenService.createToken(
        c.get('db'),
        c.get('userId'),
        c.req.valid('json').name
      );
      return c.json(created, 201);
    } catch (err: any) {
      return c.json({ error: err.message || 'Could not create a token' }, 400);
    }
  }
);

userApp.delete('/me/tokens/:id', combinedAuthMiddleware, async (c) => {
  const tokenId = c.req.param('id') ?? '';
  // With a token you can only revoke that token, so a stolen one can't lock you out everywhere
  if (c.get('authMethod') === 'token' && tokenId !== c.get('tokenId')) {
    return c.json({ error: 'Revoke other tokens from the TimDo web app' }, 403);
  }
  const ok = await tokenService.revokeToken(c.get('db'), c.get('userId'), tokenId);
  if (!ok) {
    return c.json({ error: 'Token not found' }, 404);
  }
  return c.json({ message: 'Token revoked' });
});

export default userApp;
