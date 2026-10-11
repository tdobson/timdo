import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { Env } from '../index';
import { normaliseRole, ROLE_ERROR } from '../lib/refs';
import * as projectService from '../services/projectService';
import {
  conflictWithTask,
  parseOrThrow,
  RefError,
} from '../services/refService';
import { parseProjectListQuery, TaskListQueryError } from '../services/taskListService';
import {
  projectCreateSchema,
  projectMergeSchema,
  projectUpdateBatchSchema,
  projectUpdateCreateSchema,
  projectUpdateSchema,
} from '../validators/projectValidators';

const projectsApp = new Hono<{ Bindings: Env }>();

function parseProjectRequest(query: Record<string, string | undefined>, countOnly = false) {
  const parsed = parseProjectListQuery(query, { countOnly });
  const ref = query.ref ? parseOrThrow(query.ref) : undefined;
  const roleQuery = query.role || query.refRole;
  const refRole = roleQuery ? normaliseRole(roleQuery) : undefined;
  if (refRole === null) {
    throw new RefError(ROLE_ERROR, 400);
  }
  return {
    ...parsed,
    filters: { ...parsed.filters, ref, refRole: refRole ?? undefined },
  };
}

function invalidListRequest(c: any, error: unknown) {
  if (error instanceof TaskListQueryError || error instanceof RefError) {
    return c.json({ error: error.message }, 400);
  }
  throw error;
}

// The auth middleware is now applied in src/index.ts, so we remove it from here.

// GET all matching tasks. Paging and summary projection are opt-in; legacy calls stay unlimited.
projectsApp.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');
  try {
    const query = parseProjectRequest(c.req.query());
    const result = await projectService.getProjectTaskListForUser(db, userId, query.filters, {
      fields: query.fields,
      limit: query.limit,
      cursor: query.cursor,
    });
    c.header('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
    if (result.total !== undefined) {
      c.header('X-Total-Count', String(result.total));
    }
    if (result.nextCursor) {
      c.header('X-Next-Cursor', result.nextCursor);
    }
    return c.json(result.items);
  } catch (error) {
    return invalidListRequest(c, error);
  }
});

// Register counts before /:id so the static path cannot be mistaken for a task id.
projectsApp.get('/counts', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');
  try {
    const query = parseProjectRequest(c.req.query(), true);
    const counts = await projectService.getProjectTaskCountsForUser(db, userId, query.filters);
    c.header('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
    return c.json(counts);
  } catch (error) {
    return invalidListRequest(c, error);
  }
});


// GET a single task (with sharing and attribution context)
projectsApp.get('/:id', async (c) => {
  const task = await projectService.getTaskView(c.get('db'), c.get('userId'), c.req.param('id'));
  if (!task) {
    return c.json({ error: 'Task not found or access denied' }, 404);
  }
  return c.json(task);
});

// POST a new task: 201 with `created: true` and `similar`. When a source ref in `refs` already
// has a task, onDuplicate decides: 409 { error, taskId, task } (error, the default), or 200 with
// that task and `created: false` (return; report also adds refs and a note, `reported: true`)
projectsApp.post('/', zValidator('json', projectCreateSchema), async (c) => {
  const projectData = c.req.valid('json');
  const userId = c.get('userId');
  const db = c.get('db');
  try {
    const result = await projectService.createProject(db, userId, {
      id: uuidv4(),
      ...projectData,
    });
    return c.json(result, result.created === false ? 200 : 201);
  } catch (err) {
    return conflictWithTask(c, err);
  }
});

// PUT (update) a specific project
projectsApp.put('/:id', zValidator('json', projectUpdateSchema), async (c) => {
  const projectId = c.req.param('id');
  const projectData = c.req.valid('json');
  const userId = c.get('userId');
  const db = c.get('db');
  const updatedProject = await projectService.updateProject(db, userId, projectId, projectData);
  if (!updatedProject) {
    return c.json({ error: 'Project not found or access denied' }, 404);
  }
  return c.json(updatedProject);
});

// DELETE a specific project (soft delete)
projectsApp.delete('/:id', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const db = c.get('db');
  const success = await projectService.deleteProject(db, userId, projectId);
  if (!success) {
    return c.json({ error: 'Project not found or access denied' }, 404);
  }
  return c.json({ message: 'Project deleted successfully' });
});

// POST to merge another project into this project
projectsApp.post('/:id/merge', zValidator('json', projectMergeSchema), async (c) => {
  const targetId = c.req.param('id');
  const { sourceId } = c.req.valid('json');
  const userId = c.get('userId');
  const db = c.get('db');

  if (targetId === sourceId) {
    return c.json({ error: 'Cannot merge a task into itself' }, 400);
  }

  const merged = await projectService.mergeProjects(db, userId, targetId, sourceId);
  if (!merged) {
    return c.json({ error: 'One or both tasks not found or access denied' }, 404);
  }

  return c.json(merged);
});

// GET all updates for a specific project
projectsApp.get('/:id/updates', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const db = c.get('db');
  const updates = await projectService.getProjectUpdates(db, projectId, userId);
  if (updates === null) {
    return c.json({ error: 'Project not found or access denied' }, 404);
  }
  return c.json(updates);
});

// POST a new update for a specific project
projectsApp.post('/:id/updates', zValidator('json', projectUpdateCreateSchema), async (c) => {
  const projectId = c.req.param('id');
  const updateData = c.req.valid('json');
  const userId = c.get('userId');
  const db = c.get('db');
  const newUpdate = await projectService.addProjectUpdate(db, {
    projectId,
    userId,
    note: updateData.note,
    gmailThreadId: updateData.gmailThreadId,
  });
  if (!newUpdate) {
    return c.json({ error: 'Project not found or access denied' }, 404);
  }
  return c.json(newUpdate, 201);
});

// DELETE a specific update for a project
projectsApp.delete('/:id/updates/:updateId', async (c) => {
  const projectId = c.req.param('id');
  const updateId = c.req.param('updateId');
  const userId = c.get('userId');
  const db = c.get('db');
  const success = await projectService.deleteProjectUpdate(db, {
    updateId,
    projectId,
    userId,
  });
  if (!success) {
    return c.json({ error: 'Update not found or access denied' }, 404);
  }
  return c.json({ message: 'Update deleted successfully' });
});

// POST to batch update priorities and statuses
projectsApp.post('/batch-update', zValidator('json', projectUpdateBatchSchema), async (c) => {
  const updates = c.req.valid('json');
  const userId = c.get('userId');
  const db = c.get('db');
  await projectService.batchUpdateProjects(db, userId, updates);
  return c.json({ message: 'Batch update successful' });
});

export default projectsApp;
