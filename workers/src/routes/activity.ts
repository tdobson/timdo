import { Hono, type Context } from 'hono';
import type { Env } from '../index';
import { getActivity, getPagedActivity } from '../services/activityService';
import { assertCursorKey, CursorError } from '../services/cursorService';

const activityApp = new Hono<{ Bindings: Env }>();

function pagedError(c: Context<{ Bindings: Env }>, error: unknown) {
  c.header('Cache-Control', 'no-store');
  if (error instanceof CursorError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return c.json(
    { error: 'activity_unavailable', message: 'Paged activity is temporarily unavailable' },
    500
  );
}

// GET /api/v2/activity?taskId=&epicId=&projectId=&orgId=&limit= - Who did what, newest first
activityApp.get('/', async (c) => {
  const paged = c.req.query('paged');
  if (paged !== undefined) {
    c.header('Cache-Control', 'no-store');
    if (paged !== '1') {
      return pagedError(c, new CursorError(400, 'invalid_cursor', 'paged must be 1'));
    }
    try {
      assertCursorKey(c.env?.EVENT_CURSOR_KEY);
      const rawLimit = c.req.query('limit');
      let limit = 100;
      if (rawLimit !== undefined) {
        if (!/^\d+$/.test(rawLimit)) {
          throw new CursorError(
            400,
            'invalid_cursor',
            'limit must be an integer between 1 and 500'
          );
        }
        limit = Number(rawLimit);
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new CursorError(400, 'invalid_cursor', 'limit must be an integer between 1 and 500');
      }
      const before = c.req.query('before');
      if (before !== undefined && (!before || before.length > 2048)) {
        throw new CursorError(400, 'invalid_cursor', 'before must be an opaque cursor');
      }
      const result = await getPagedActivity(
        c.get('db'),
        c.env.EVENT_CURSOR_KEY,
        c.get('userId'),
        {
          taskId: c.req.query('taskId') || undefined,
          epicId: c.req.query('epicId') || undefined,
          projectId: c.req.query('projectId') || undefined,
          orgId: c.req.query('orgId') || undefined,
        },
        limit,
        before
      );
      if (result.nextCursor) {
        c.header('X-Next-Cursor', result.nextCursor);
      }
      return c.json(result.entries);
    } catch (error) {
      return pagedError(c, error);
    }
  }

  const limit = Number(c.req.query('limit') || 100);
  const entries = await getActivity(c.get('db'), c.get('userId'), {
    taskId: c.req.query('taskId') || undefined,
    epicId: c.req.query('epicId') || undefined,
    projectId: c.req.query('projectId') || undefined,
    orgId: c.req.query('orgId') || undefined,
    limit: Number.isFinite(limit) ? limit : 100,
  });
  c.header('Cache-Control', 'private, max-age=15');
  return c.json(entries);
});

export default activityApp;
