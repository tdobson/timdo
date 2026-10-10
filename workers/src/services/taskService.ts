import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import type { TaskCreatePayload, TaskUpdatePayload } from '../validators/taskValidators';
import { getAccessibleProjects, getUserNames } from './accessService';
import * as projectService from './projectService';

type DB = DrizzleD1Database<typeof schema>;

export interface TaskFilters {
  orgId?: string;
  projectId?: string;
  assigneeId?: string;
  status?: string;
  mineOnly?: boolean;
  unassignedOnly?: boolean;
  customer?: string;
  tag?: string;
  relatedTo?: string;
}

/**
 * Resolve a full id or an id prefix to a task the user can see.
 */
export async function resolveTaskIdForUser(
  db: DB,
  userId: string,
  identifier: string
): Promise<string | null> {
  if (!identifier) {
    return null;
  }
  const projectIds = await getUserAccessibleProjectIds(db, userId);
  if (projectIds.length === 0) {
    return null;
  }

  const match = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        sql`lower(${schema.tasks.id}) LIKE lower(${`${identifier}%`})`,
        eq(schema.tasks.isDeleted, false),
        inArray(schema.tasks.projectId, projectIds)
      )
    )
    .orderBy(sql`${schema.tasks.id} = ${identifier} desc`)
    .get();

  return match?.id ?? null;
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
  let accessibleProjectIds = await getUserAccessibleProjectIds(db, userId);

  if (filters?.orgId) {
    // Narrow accessible projects to the specified org
    const orgProjects = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, filters.orgId),
          inArray(
            schema.projects.id,
            accessibleProjectIds.length > 0 ? accessibleProjectIds : ['none']
          )
        )
      );
    accessibleProjectIds = orgProjects.map((p) => p.id);
  }

  if (accessibleProjectIds.length === 0) {
    return [];
  }

  const conditions = [
    inArray(schema.tasks.projectId, accessibleProjectIds),
    eq(schema.tasks.isDeleted, false),
  ];

  if (filters?.projectId) {
    if (!accessibleProjectIds.includes(filters.projectId)) {
      return [];
    }
    conditions.push(eq(schema.tasks.projectId, filters.projectId));
  }

  if (filters?.mineOnly) {
    conditions.push(eq(schema.tasks.assigneeId, userId));
  } else if (filters?.unassignedOnly) {
    conditions.push(isNull(schema.tasks.assigneeId));
  } else if (filters?.assigneeId !== undefined) {
    if (filters.assigneeId === null || filters.assigneeId === '') {
      conditions.push(isNull(schema.tasks.assigneeId));
    } else {
      conditions.push(eq(schema.tasks.assigneeId, filters.assigneeId));
    }
  }

  if (filters?.status) {
    conditions.push(eq(schema.tasks.status, filters.status as any));
  }

  if (filters?.customer) {
    conditions.push(sql`lower(${schema.tasks.customer}) = lower(${filters.customer.trim()})`);
  }

  if (filters?.tag) {
    const cleanTag = filters.tag.trim().toLowerCase();
    conditions.push(sql`lower(coalesce(${schema.tasks.tags}, '')) LIKE lower(${`%${cleanTag}%`})`);
  }

  if (filters?.relatedTo) {
    const resolvedTargetId = await resolveTaskIdForUser(db, userId, filters.relatedTo);
    if (!resolvedTargetId) {
      return [];
    }
    const relatedLinks = await db
      .select({
        sourceId: schema.taskRelations.sourceTaskId,
        targetId: schema.taskRelations.targetTaskId,
      })
      .from(schema.taskRelations)
      .where(
        sql`${schema.taskRelations.sourceTaskId} = ${resolvedTargetId} or ${schema.taskRelations.targetTaskId} = ${resolvedTargetId}`
      );

    const relatedIds = relatedLinks.map((l) =>
      l.sourceId === resolvedTargetId ? l.targetId : l.sourceId
    );

    if (relatedIds.length === 0) {
      return [];
    }

    conditions.push(inArray(schema.tasks.id, relatedIds));
  }

  return db
    .select()
    .from(schema.tasks)
    .where(and(...conditions));
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
  const names = await getUserNames(
    db,
    rows.map((r) => r.authorId)
  );
  return rows.map((r) => ({ ...r, authorName: names.get(r.authorId) ?? null }));
}

export async function linkPersonalGoal(db: DB, userId: string, taskId: string, goalId: string) {
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
