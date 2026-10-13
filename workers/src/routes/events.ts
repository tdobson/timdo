import { Hono, type Context } from 'hono';
import type { Env } from '../index';
import { assertCursorKey, CursorError } from '../services/cursorService';
import { getEventsPage, isEventsFeedError, parseEventsQuery } from '../services/eventsFeedService';

const eventsApp = new Hono<{ Bindings: Env }>();

function errorResponse(c: Context<{ Bindings: Env }>, error: unknown) {
  c.header('Cache-Control', 'no-store');
  if (error instanceof CursorError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  if (isEventsFeedError(error)) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  return c.json(
    { error: 'events_unavailable', message: 'Events are temporarily unavailable' },
    500
  );
}

eventsApp.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    assertCursorKey(c.env?.EVENT_CURSOR_KEY);
    const query = parseEventsQuery({
      after: c.req.query('after'),
      workspace: c.req.query('workspace'),
      types: c.req.query('types'),
      include: c.req.query('include'),
      limit: c.req.query('limit'),
    });
    const page = await getEventsPage(
      c.get('db'),
      c.env.EVENT_CURSOR_KEY,
      { userId: c.get('userId'), userKind: c.get('userKind') },
      query
    );
    return c.json(page);
  } catch (error) {
    return errorResponse(c, error);
  }
});

eventsApp.onError((error, c) => errorResponse(c, error));

export default eventsApp;
