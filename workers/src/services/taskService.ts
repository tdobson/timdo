import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import type { TaskCreatePayload, TaskUpdatePayload } from '../validators/taskValidators';
import { AccessError, getAccessibleProjects } from './accessService';
import { getPeople, getUserKind } from './personService';
import * as projectService from './projectService';
import * as taskListService from './taskListService';
import type { TaskListFilters } from './taskListService';

type DB = DrizzleD1Database<typeof schema>;

async function requireHumanGoals(db: DB, userId: string) {
  if ((await getUserKind(db, userId)) === 'bot') {
    throw new AccessError('Bots do not have life goals');
  }
}

export interface TaskFilters extends TaskListFilters {}

/**
 * Resolve a full id or an id prefix to a task the user can see.
 */
export async function resolveTaskIdForUser(
  db: DB,
  userId: string,
  identifier: string
): Promise<string | null> {
  return taskListService.resolveVisibleTaskId(db, userId, identifier);
}

export async function getUserAccessibleProjectIds(db: DB, userId: string): Promise<string[]> {
  return (await getAccessibleProjects(db, userId)).map((p) => p.id);
}

export async function isProjectAccessible(
  db: DB,
  userId: string,
  projectId: string
): Promise<boolean> {
  return (await getUserAccessibleProjectIds(db, userId)).includes(projectId);
}

export async function getTasksForUser(db: DB, userId: string, filters?: TaskFilters) {
  return taskListService.getRawTasksForUser(db, userId, filters ?? {});
}

export async function getTaskById(db: DB, userId: string, taskId: string) {
  const task = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.isDeleted, false)))
    .get();

  if (!task) {
    return null;
  }

  const accessible = await isProjectAccessible(db, userId, task.projectId);
  if (!accessible) {
    return null;
  }

  return task;
}

/** Raw Tasks row after a write made through the shared, permission-checked path. */
async function rawTask(db: DB, taskId: string) {
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
}

/**
 * Create through the shared /projects path, answered in the /tasks shape: the Tasks row plus
 * `refs`, `created`, and `similar` (new task) or `reported` (onDuplicate: report).
 */
export async function createTask(
  db: DB,
  userId: string,
  data: TaskCreatePayload & { id?: string }
) {
  const id = data.id ?? uuidv4();
  const view = await projectService.createProject(db, userId, {
    id,
    projectId: data.projectId,
    project: data.title,
    reason: data.reason,
    status: data.status,
    priority: data.priority,
    size: data.size,
    notes: data.notes,
    assigneeId: data.assigneeId,
    epicId: data.epicId,
    awaitUntil: data.awaitUntil,
    gmailThreadId: data.gmailThreadId,
    customer: data.customer,
    tags: data.tags,
    refs: data.refs,
    onDuplicate: data.onDuplicate,
  });
  // On a tracked source the answer is the existing task, so read back whichever task it is
  const { created, reported, similar } = view;
  return {
    ...(await rawTask(db, view.id)),
    refs: view.refs,
    created,
    ...(reported ? { reported } : {}),
    ...(similar ? { similar } : {}),
  };
}

export async function updateTask(db: DB, userId: string, taskId: string, data: TaskUpdatePayload) {
  const { title, statusLastChangedOn: _s, updatedAt: _u, ...rest } = data;
  const updated = await projectService.updateProject(db, userId, taskId, {
    ...rest,
    ...(title !== undefined ? { project: title } : {}),
  });
  return updated ? rawTask(db, taskId) : null;
}

export async function claimTask(db: DB, userId: string, taskId: string) {
  const updated = await projectService.updateProject(db, userId, taskId, { assigneeId: userId });
  return updated ? rawTask(db, taskId) : null;
}

export async function assignTask(
  db: DB,
  userId: string,
  taskId: string,
  targetAssigneeId: string | null
) {
  const updated = await projectService.updateProject(db, userId, taskId, {
    assigneeId: targetAssigneeId,
  });
  return updated ? rawTask(db, taskId) : null;
}

export async function addTaskUpdate(
  db: DB,
  userId: string,
  taskId: string,
  note: string,
  gmailThreadId?: string | null
) {
  const added = await projectService.addProjectUpdate(db, {
    projectId: taskId,
    userId,
    note,
    gmailThreadId,
  });
  if (!added) {
    return null;
  }
  return {
    id: added.id,
    taskId,
    authorId: userId,
    authorName: added.authorName,
    authorKind: added.authorKind,
    note: added.note,
    gmailThreadId: added.gmailThreadId,
    createdAt: added.createdAt,
    updatedAt: added.updatedAt,
  };
}

export async function getTaskUpdates(db: DB, userId: string, taskId: string) {
  const task = await getTaskById(db, userId, taskId);
  if (!task) {
    return null;
  }

  const rows = await db
    .select()
    .from(schema.taskUpdates)
    .where(eq(schema.taskUpdates.taskId, taskId))
    .orderBy(desc(schema.taskUpdates.createdAt));
  const people = await getPeople(
    db,
    rows.map((r) => r.authorId)
  );
  return rows.map((r) => ({
    ...r,
    authorName: people.get(r.authorId)?.name ?? null,
    authorKind: people.get(r.authorId)?.kind ?? 'human',
  }));
}

export async function linkPersonalGoal(db: DB, userId: string, taskId: string, goalId: string) {
  await requireHumanGoals(db, userId);
  const task = await getTaskById(db, userId, taskId);
  if (!task) {
    return null;
  }

  // Verify goal belongs to userId
  const goal = await db
    .select()
    .from(schema.goals)
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.userId, userId)))
    .get();

  if (!goal) {
    throw new Error('Goal not found or access denied');
  }

  // Insert or ignore if already linked
  const existing = await db
    .select()
    .from(schema.taskUserGoals)
    .where(
      and(
        eq(schema.taskUserGoals.taskId, taskId),
        eq(schema.taskUserGoals.userId, userId),
        eq(schema.taskUserGoals.goalId, goalId)
      )
    )
    .get();

  if (existing) {
    return existing;
  }

  const result = await db
    .insert(schema.taskUserGoals)
    .values({
      taskId,
      userId,
      goalId,
    })
    .returning();

  return result[0];
}

export async function unlinkPersonalGoal(db: DB, userId: string, taskId: string, goalId: string) {
  await requireHumanGoals(db, userId);
  const task = await getTaskById(db, userId, taskId);
  if (!task) {
    return false;
  }

  const result = await db
    .delete(schema.taskUserGoals)
    .where(
      and(
        eq(schema.taskUserGoals.taskId, taskId),
        eq(schema.taskUserGoals.userId, userId),
        eq(schema.taskUserGoals.goalId, goalId)
      )
    )
    .returning();

  return result.length > 0;
}

export async function getTaskPersonalGoals(db: DB, userId: string, taskId: string) {
  await requireHumanGoals(db, userId);
  const task = await getTaskById(db, userId, taskId);
  if (!task) {
    return null;
  }

  return db
    .select({
      goalId: schema.taskUserGoals.goalId,
      createdAt: schema.taskUserGoals.createdAt,
      title: schema.goals.title,
      type: schema.goals.type,
      icon: schema.goals.icon,
    })
    .from(schema.taskUserGoals)
    .innerJoin(schema.goals, eq(schema.taskUserGoals.goalId, schema.goals.id))
    .where(and(eq(schema.taskUserGoals.taskId, taskId), eq(schema.taskUserGoals.userId, userId)));
}
