import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { Env } from '../index';
import * as botService from '../services/botService';
import {
  botCreateSchema,
  botTokenCreateSchema,
  botUpdateSchema,
} from '../validators/botValidators';

const botsApp = new Hono<{ Bindings: Env }>();
const validate = (schema: any) =>
  zValidator('json', schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.issues[0]?.message || 'Invalid bot details' }, 400);
    }
  });

botsApp.get('/:orgId/bots', async (c) => {
  return c.json(await botService.listBots(c.get('db'), c.get('userId'), c.req.param('orgId')));
});

botsApp.post('/:orgId/bots', validate(botCreateSchema), async (c) => {
  const created = await botService.createBot(
    c.get('db'),
    c.get('userId'),
    c.req.param('orgId'),
    c.req.valid('json')
  );
  c.header('Cache-Control', 'no-store');
  return c.json(created, 201);
});

botsApp.put('/:orgId/bots/:botId', validate(botUpdateSchema), async (c) => {
  return c.json(
    await botService.updateBot(
      c.get('db'),
      c.get('userId'),
      c.req.param('orgId'),
      c.req.param('botId'),
      c.req.valid('json')
    )
  );
});

botsApp.delete('/:orgId/bots/:botId', async (c) => {
  await botService.disableBot(
    c.get('db'),
    c.get('userId'),
    c.req.param('orgId'),
    c.req.param('botId')
  );
  return c.body(null, 204);
});

botsApp.post('/:orgId/bots/:botId/tokens', validate(botTokenCreateSchema), async (c) => {
  const created = await botService.createBotToken(
    c.get('db'),
    c.get('userId'),
    c.req.param('orgId'),
    c.req.param('botId'),
    c.req.valid('json')
  );
  c.header('Cache-Control', 'no-store');
  return c.json(created, 201);
});

botsApp.delete('/:orgId/bots/:botId/tokens/:tokenId', async (c) => {
  await botService.revokeBotToken(
    c.get('db'),
    c.get('userId'),
    c.req.param('orgId'),
    c.req.param('botId'),
    c.req.param('tokenId')
  );
  return c.body(null, 204);
});

export default botsApp;
