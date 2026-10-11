import type { Context } from 'hono';
import { AccessError } from '../services/accessService';
import { BotError } from '../services/botService';
import { RefError } from '../services/refService';

/**
 * The API's error handler (app.onError), kept out of index.ts so tests can mount it too.
 * Permission problems surface as 403/404 with a readable message, wherever they're thrown.
 * Ref problems are 400/404, or 409 with the id of the task that already has the source.
 */
export function onApiError(err: Error, c: Context) {
  if (err instanceof RefError) {
    return c.json(
      {
        error: err.message,
        ...(err.taskId ? { taskId: err.taskId } : {}),
        ...(err.task ? { task: err.task } : {}),
      },
      err.status
    );
  }
  if (err instanceof BotError) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof AccessError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('[Unhandled]', err);
  return c.json({ error: 'Internal Server Error' }, 500);
}
