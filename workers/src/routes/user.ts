import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
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
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      kind: schema.users.kind,
      botOrgId: schema.users.botOrgId,
    })
    .from(schema.users)
    .where(eq(schema.users.id, c.get('userId')))
    .get();
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }
  c.header('Cache-Control', 'private, max-age=300');
  if (user.kind === 'bot') {
    const workspace = await db
      .select({
        id: schema.organisations.id,
        name: schema.organisations.name,
        role: schema.organisationMembers.role,
      })
      .from(schema.organisationMembers)
      .innerJoin(
        schema.organisations,
        eq(schema.organisations.id, schema.organisationMembers.orgId)
      )
      .where(
        and(
          eq(schema.organisationMembers.userId, user.id),
          eq(schema.organisationMembers.orgId, user.botOrgId ?? ''),
          inArray(schema.organisationMembers.role, ['member', 'viewer'])
        )
      )
      .get();
    if (!workspace) {
      return c.json({ error: 'This bot is not active' }, 401);
    }
    return c.json({
      id: user.id,
      name: user.name,
      kind: 'bot',
      workspace: { id: workspace.id, name: workspace.name, role: workspace.role },
    });
  }
  return c.json({ id: user.id, email: user.email, name: user.name, kind: 'human' });
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
  const db = c.get('db');
  const actor = await db
    .select({ kind: schema.users.kind })
    .from(schema.users)
    .where(eq(schema.users.id, c.get('userId')))
    .get();
  if (actor?.kind === 'bot' && c.get('authMethod') !== 'token') {
    return c.json({ error: 'Bots can revoke only the calling token' }, 403);
  }
  // With a token you can only revoke that token, so a stolen one can't lock you out everywhere
  if (c.get('authMethod') === 'token' && c.req.param('id') !== c.get('tokenId')) {
    return c.json({ error: 'Revoke other tokens from the TimDo web app' }, 403);
  }
  const ok = await tokenService.revokeToken(db, c.get('userId'), c.req.param('id'));
  if (!ok) {
    return c.json({ error: 'Token not found' }, 404);
  }
  return c.json({ message: 'Token revoked' });
});

export default userApp;
