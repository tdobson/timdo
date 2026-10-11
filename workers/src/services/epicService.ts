/**
 * Epics belong to a project (category). Anyone in the project's workspace can see them;
 * members and above can change them. An epic with no project is private to its creator.
 * The life goal on an epic is personal to whoever created it, so it's hidden from others.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import type {
  EpicCreateInput,
  EpicCreatePayload,
  EpicUpdatePayload,
} from '../validators/epicValidators';
import {
  AccessError,
  canEdit,
  canManage,
  getAccessibleProjects,
  resolveProjectForWrite,
  type AccessibleProject,
  type Role,
} from './accessService';
import { describeFieldEdits, diffFields, logActivity, statusLabel } from './activityService';
import { getPeople, getUserKind, type PersonKind, type PersonProjection } from './personService';

type DB = DrizzleD1Database<typeof schema>;
type EpicRow = typeof schema.epics.$inferSelect;

export interface EpicWithStats {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  category: string | null;
  goalId: string | null;
  status: 'active' | 'completed' | 'on_hold';
  createdAt: string | null;
  updatedAt: string | null;
  totalTasks: number;
  doneTasks: number;
  progressPercentage: number;
  projectId: string | null;
  projectKey: string | null;
  orgId: string | null;
  orgName: string | null;
  isShared: boolean;
  myRole: Role | null;
  canEdit: boolean;
  createdById: string;
  createdByName: string | null;
  createdByKind: PersonKind;
  updatedById: string | null;
  updatedByName: string | null;
  updatedByKind: PersonKind;
}

function toView(
  epic: EpicRow,
  project: AccessibleProject | undefined,
  userId: string,
  people: Map<string, PersonProjection>,
  stats: { totalTasks: number; doneTasks: number },
  isHuman: boolean
): EpicWithStats {
  const isCreator = isHuman && epic.userId === userId;
  const creator = people.get(epic.userId);
  const updater = people.get(epic.updatedBy ?? epic.userId);
  const role: Role | null = project ? project.role : isCreator ? 'owner' : null;
  return {
    id: epic.id,
    userId: epic.userId,
    title: epic.title,
    description: epic.description,
    category: project?.name ?? epic.category ?? null,
    goalId: isCreator ? epic.goalId : null,
    status: epic.status,
    createdAt: epic.createdAt,
    updatedAt: epic.updatedAt,
    totalTasks: stats.totalTasks,
    doneTasks: stats.doneTasks,
    progressPercentage:
      stats.totalTasks > 0 ? Math.round((stats.doneTasks / stats.totalTasks) * 100) : 0,
    projectId: project?.id ?? null,
    projectKey: project?.key ?? null,
    orgId: project?.orgId ?? null,
    orgName: project?.orgName ?? null,
    isShared: (project?.memberCount ?? 1) > 1,
    myRole: role,
    canEdit: canEdit(role),
    createdById: epic.userId,
    createdByName: creator?.name ?? null,
    createdByKind: creator?.kind ?? 'human',
    updatedById: epic.updatedBy ?? epic.userId,
    updatedByName: updater?.name ?? null,
    updatedByKind: updater?.kind ?? 'human',
  };
}

async function visibleEpics(
  db: DB,
  userId: string,
  _projects: AccessibleProject[],
  includeUnscoped: boolean
) {
  const shared = sql`exists (
    select 1 from Projects visible_epic_project
    inner join OrganisationMembers visible_epic_member
      on visible_epic_member.org_id = visible_epic_project.org_id
    where visible_epic_project.id = Epics.project_id
      and visible_epic_member.user_id = ${userId}
  )`;
  return db
    .select()
    .from(schema.epics)
    .where(
      includeUnscoped
        ? or(shared, and(isNull(schema.epics.projectId), eq(schema.epics.userId, userId)))
        : shared
    )
    .orderBy(asc(schema.epics.createdAt));
}

/** Progress counts only tasks the viewer can see, using aggregate SQL rather than task rows. */
async function statsFor(db: DB, userId: string, epicIds: string[]) {
  const stats = new Map<string, { totalTasks: number; doneTasks: number }>();
  for (let index = 0; index < epicIds.length; index += 90) {
    const chunk = epicIds.slice(index, index + 90);
    const rows = await db
      .select({
        epicId: schema.tasks.epicId,
        status: schema.tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.isDeleted, false),
          inArray(schema.tasks.epicId, chunk),
          sql`exists (
            select 1 from Projects visible_epic_project
            inner join OrganisationMembers visible_epic_member
              on visible_epic_member.org_id = visible_epic_project.org_id
            where visible_epic_project.id = Tasks.project_id
              and visible_epic_member.user_id = ${userId}
          )`
        )
      )
      .groupBy(schema.tasks.epicId, schema.tasks.status);
    for (const row of rows) {
      if (!row.epicId) {
        continue;
      }
      const count = Number(row.count || 0);
      const current = stats.get(row.epicId) || { totalTasks: 0, doneTasks: 0 };
      current.totalTasks += count;
      if (row.status === 'done') {
        current.doneTasks += count;
      }
      stats.set(row.epicId, current);
    }
  }
  return stats;
}

export async function getEpicsForUser(
  db: DB,
  userId: string,
  category?: string
): Promise<EpicWithStats[]> {
  const actorKind = await getUserKind(db, userId);
  const isHuman = actorKind !== 'bot';
  const projects = await getAccessibleProjects(db, userId);
  const byId = new Map(projects.map((p) => [p.id, p]));
  let epics = await visibleEpics(db, userId, projects, isHuman);
  if (category) {
    const c = category.trim().toLowerCase();
    epics = epics.filter((e) => {
      const name = e.projectId ? byId.get(e.projectId)?.name : e.category;
      return (name ?? '').toLowerCase() === c;
    });
  }

  const stats = new Map<string, { totalTasks: number; doneTasks: number }>();
  // D1 caps bound parameters at 100 per query
  for (let i = 0; i < epics.length; i += 90) {
    const chunk = await statsFor(
      db,
      userId,
      epics.slice(i, i + 90).map((epic) => epic.id)
    );
    chunk.forEach((v, k) => stats.set(k, v));
  }
  const people = await getPeople(
    db,
    epics.flatMap((e) => [e.userId, e.updatedBy])
  );

  return epics.map((e) =>
    toView(
      e,
      e.projectId ? byId.get(e.projectId) : undefined,
      userId,
      people,
      stats.get(e.id) || { totalTasks: 0, doneTasks: 0 },
      isHuman
    )
  );
}

export async function getEpicForUser(
  db: DB,
  userId: string,
  epicId: string
): Promise<EpicWithStats | null> {
  const epic = await db.select().from(schema.epics).where(eq(schema.epics.id, epicId)).get();
  if (!epic) {
    return null;
  }
  const actorKind = await getUserKind(db, userId);
  const isHuman = actorKind !== 'bot';
  const projects = await getAccessibleProjects(db, userId);
  const project = epic.projectId ? projects.find((p) => p.id === epic.projectId) : undefined;
  if (epic.projectId ? !project : !isHuman || epic.userId !== userId) {
    return null;
  }
  const [stats, people] = await Promise.all([
    statsFor(db, userId, [epic.id]),
    getPeople(db, [epic.userId, epic.updatedBy]),
  ]);
  return toView(
    epic,
    project,
    userId,
    people,
    stats.get(epic.id) || { totalTasks: 0, doneTasks: 0 },
    isHuman
  );
}

export async function createEpic(
  db: DB,
  userId: string,
  data: (EpicCreateInput | EpicCreatePayload) & { id?: string; projectId?: string }
) {
  const isBot = (await getUserKind(db, userId)) === 'bot';
  if (isBot && data.goalId !== undefined) {
    throw new AccessError('Bots do not have life goals');
  }
  let project: AccessibleProject | undefined;
  if (data.projectId) {
    project = (await getAccessibleProjects(db, userId)).find((p) => p.id === data.projectId);
    if (!project) {
      throw new AccessError('Project not found', 404);
    }
    if (!canEdit(project.role)) {
      throw new AccessError(`You have view-only access to "${project.name}"`);
    }
  } else if (data.category) {
    project = await resolveProjectForWrite(db, userId, data.category);
  }
  if (isBot && !project) {
    throw new AccessError('Bots can only create project-scoped epics');
  }

  const now = new Date().toISOString();
  const row = {
    id: data.id ?? uuidv4(),
    userId,
    title: data.title,
    description: data.description ?? null,
    category: project?.name ?? data.category ?? null,
    projectId: project?.id ?? null,
    goalId: data.goalId ?? null,
    status: data.status ?? 'active',
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.epics).values(row);
  await logActivity(db, {
    actorId: userId,
    orgId: project?.orgId ?? null,
    projectId: project?.id ?? null,
    entityType: 'epic',
    entityId: row.id,
    epicId: row.id,
    action: 'created',
    summary: `Created epic "${row.title}"`,
  });
  return getEpicForUser(db, userId, row.id);
}

async function loadEditableEpic(db: DB, userId: string, epicId: string) {
  const epic = await db.select().from(schema.epics).where(eq(schema.epics.id, epicId)).get();
  if (!epic) {
    return null;
  }
  const projects = await getAccessibleProjects(db, userId);
  const project = epic.projectId ? projects.find((p) => p.id === epic.projectId) : undefined;
  const isBot = (await getUserKind(db, userId)) === 'bot';
  if (epic.projectId ? !project : isBot || epic.userId !== userId) {
    return null;
  }
  if (project && !canEdit(project.role)) {
    throw new AccessError(`You have view-only access to "${project.name}"`);
  }
  return { epic, project };
}

export async function updateEpic(
  db: DB,
  userId: string,
  epicId: string,
  data: EpicUpdatePayload & { projectId?: string }
) {
  const loaded = await loadEditableEpic(db, userId, epicId);
  if (!loaded) {
    return null;
  }
  if (data.goalId !== undefined && (await getUserKind(db, userId)) === 'bot') {
    throw new AccessError('Bots do not have life goals');
  }
  const { epic } = loaded;
  let { project } = loaded;

  const patch: Partial<typeof schema.epics.$inferInsert> = {};
  if (data.title !== undefined) {
    patch.title = data.title;
  }
  if (data.description !== undefined) {
    patch.description = data.description;
  }
  if (data.status !== undefined) {
    patch.status = data.status;
  }
  // The goal is personal to the creator; collaborators can't change it
  if (data.goalId !== undefined && epic.userId === userId) {
    patch.goalId = data.goalId;
  }

  if (data.projectId && data.projectId !== epic.projectId) {
    const target = (await getAccessibleProjects(db, userId)).find((p) => p.id === data.projectId);
    if (!target) {
      throw new AccessError('Project not found', 404);
    }
    if (!canEdit(target.role)) {
      throw new AccessError(`You have view-only access to "${target.name}"`);
    }
    project = target;
  } else if (
    data.category !== undefined &&
    (data.category ?? '').trim().toLowerCase() !==
      (project?.name ?? epic.category ?? '').toLowerCase()
  ) {
    project = data.category ? await resolveProjectForWrite(db, userId, data.category) : undefined;
  }
  if ((project?.id ?? null) !== epic.projectId) {
    const from = loaded.project;
    if (from && project?.orgId !== from.orgId) {
      // Its tasks would be left behind in the old workspace; moving the project moves both
      if (!canManage(from.role)) {
        throw new AccessError(`Only owners and admins can move epics out of ${from.orgName}`);
      }
      const stranded = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.epicId, epic.id), eq(schema.tasks.isDeleted, false)))
        .limit(1)
        .get();
      if (stranded) {
        throw new AccessError(
          'This epic has tasks. Move the whole project from the Sharing page instead.'
        );
      }
    }
    patch.projectId = project?.id ?? null;
    patch.category = project?.name ?? null;
  }

  const changes = diffFields(epic as any, patch as any, [
    'title',
    'description',
    'status',
    'goalId',
    'projectId',
  ]);
  if (Object.keys(changes).length === 0) {
    return getEpicForUser(db, userId, epicId);
  }

  await db
    .update(schema.epics)
    .set({ ...patch, updatedAt: new Date().toISOString(), updatedBy: userId })
    .where(eq(schema.epics.id, epicId));

  const title = (patch.title as string) ?? epic.title;
  const base = {
    actorId: userId,
    orgId: project?.orgId ?? null,
    projectId: project?.id ?? null,
    entityType: 'epic' as const,
    entityId: epicId,
    epicId,
  };
  if (changes.status) {
    await logActivity(db, {
      ...base,
      action: changes.status.to === 'completed' ? 'completed' : 'status_changed',
      summary: `Marked epic "${title}" as ${statusLabel(changes.status.to)}`,
      changes: { status: changes.status },
    });
  }
  if (changes.projectId) {
    await logActivity(db, {
      ...base,
      action: 'moved',
      summary: `Moved epic "${title}" to ${project?.name ?? 'no project'}`,
      changes: { projectId: changes.projectId },
    });
  }
  const { status: _s, projectId: _p, goalId: _g, ...rest } = changes;
  const summary = describeFieldEdits(rest);
  if (summary) {
    await logActivity(db, {
      ...base,
      action: 'updated',
      summary: `${summary} on epic "${title}"`,
      changes: rest,
    });
  }
  return getEpicForUser(db, userId, epicId);
}

export async function deleteEpic(db: DB, userId: string, epicId: string) {
  let loaded;
  try {
    loaded = await loadEditableEpic(db, userId, epicId);
  } catch (err) {
    if (err instanceof AccessError) {
      return false;
    }
    throw err;
  }
  if (!loaded) {
    return false;
  }
  await db.delete(schema.epics).where(eq(schema.epics.id, epicId));
  await logActivity(db, {
    actorId: userId,
    orgId: loaded.project?.orgId ?? null,
    projectId: loaded.project?.id ?? null,
    entityType: 'epic',
    entityId: epicId,
    epicId,
    action: 'deleted',
    summary: `Deleted epic "${loaded.epic.title}"`,
  });
  return true;
}
