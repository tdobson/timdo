import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { Env } from '../index';
import { normaliseRole, ROLE_ERROR } from '../lib/refs';
import * as projectService from '../services/projectService';
import { conflictWithTask, parseOrThrow } from '../services/refService';
import {
  projectCreateSchema,
  projectMergeSchema,
  projectUpdateBatchSchema,
  projectUpdateCreateSchema,
  projectUpdateSchema,
} from '../validators/projectValidators';

const projectsApp = new Hono<{ Bindings: Env }>();

// The auth middleware is now applied in src/index.ts, so we remove it from here.

// GET all projects for a user (with optional hierarchy filters: category, epicId, goalId)
projectsApp.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.get('db');
  const category = c.req.query('category');
  const epicId = c.req.query('epicId');
  const goalId = c.req.query('goalId');
  const customer = c.req.query('customer');
  const tag = c.req.query('tag');
  const relatedTo = c.req.query('relatedTo');
  const assignee = c.req.query('assignee');
  const orgId = c.req.query('orgId');
  const projectId = c.req.query('projectId');
  // ?ref=<url|kind:id>[&role=]: tasks carrying that link, any status. `role` matches
  // DELETE /tasks/:id/refs; `refRole` is kept as an alias
  const refQuery = c.req.query('ref');
  const ref = refQuery ? parseOrThrow(refQuery) : undefined;
  const roleQuery = c.req.query('role') || c.req.query('refRole');
  const refRole = roleQuery ? normaliseRole(roleQuery) : undefined;
  if (refRole === null) {
    return c.json({ error: ROLE_ERROR }, 400);
  }

  const projects = await projectService.getProjectsForUser(db, userId, {
    category,
    epicId,
    goalId,
    customer,
    tag,
    relatedTo,
    assignee,
    orgId,
    projectId,
    ref,
    refRole,
  });
  c.header('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
  return c.json(projects);
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
