/**
 * The `/projects` API: TimDo's original task-shaped contract ("project" = task title,
 * "category" = project name), now backed by the multi-user Tasks / Projects / Organisations
 * tables. Every read is scoped to the workspaces the caller belongs to, every write is
 * permission-checked and recorded in the activity log.
 */
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database, SQLiteD1Session } from 'drizzle-orm/d1';
import type { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import { canonicalRef } from '../lib/refs';
import { generateProjectKey } from './migrationService';
import type {
  ProjectCreatePayload,
  ProjectUpdateBatchPayload,
  ProjectUpdatePayload,
} from '../validators/projectValidators';
import {
  AccessError,
  canEdit,
  canManage,
  ensurePersonalOrg,
  getAccessibleProjects,
  getUserNames,
  matchingProjectsForCategory,
  resolveProjectForWrite,
  type AccessibleProject,
  type Role,
} from './accessService';
import {
  describeFieldEdits,
  diffFields,
  logActivity,
  statusLabel,
  type FieldChanges,
} from './activityService';
import {
  addResolvedRefs,
  assertSourcesFreeIn,
  fetchRefRows,
  findSourceHolder,
  insertTaskWithRefs,
  prepareRefsForMerge,
  normaliseGmailThreadId,
  prepareRefsForCreate,
  RefConflictError,
  RefError,
  SourceHolderChangedError,
  hasCurrentSourceHolder,
  sourceHolderCondition,
  refViewsFor,
  releaseSource,
  sourceConflict,
  syncGmailThread,
  updateRefOrgs,
  type RefInput,
  type RefView,
  type SourceHolderGuard,
} from './refService';
import { findSimilarTasks, type SimilarTask } from './similarService';
import * as taskListService from './taskListService';
import type { TaskListFields, TaskListFilters, TaskListResult, TaskCounts } from './taskListService';

type DB = DrizzleD1Database<typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;

export interface ProjectFilters extends TaskListFilters {}

/** A task in the original `/projects` shape, plus who-did-what and sharing context. */
export interface TaskView {
  id: string;
  userId: string;
  project: string;
  reason: string | null;
  status: TaskRow['status'];
  priority: number;
  size: TaskRow['size'];
  notes: string | null;
  noteCount: number;
  lastNoteAt: string | null;
  statusLastChangedOn: string | null;
  awaitUntil: string | null;
  gmailThreadId: string | null;
  category: string;
  customer: string | null;
  tags: string | null;
  epicId: string | null;
  goalId: string | null;
  isDeleted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  projectId: string;
  projectKey: string;
  projectName: string;
  orgId: string;
  orgName: string;
  isShared: boolean;
  myRole: Role;
  canEdit: boolean;
  reporterId: string;
  reporterName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  updatedById: string | null;
  updatedByName: string | null;
  isMine: boolean;
  /** Links to things outside TimDo, Source first. Empty when there are none. */
  refs: RefView[];
}

/** A projected list row, which deliberately has no full task body. */
export interface TaskSummaryView extends Omit<TaskView, 'notes'> {}
export type TaskListView = TaskView | TaskSummaryView;

function toView(
  task: TaskRow,
  project: AccessibleProject,
  userId: string,
  names: Map<string, string>,
  goalId: string | null,
  refs: RefView[],
  noteMetadata: { noteCount: number; lastNoteAt: string | null }
): TaskListView {
  const base = {
    id: task.id,
    userId: task.reporterId,
    project: task.title,
    reason: task.reason,
    status: task.status,
    priority: task.priority,
    size: task.size,
    noteCount: noteMetadata.noteCount,
    lastNoteAt: noteMetadata.lastNoteAt,
    statusLastChangedOn: task.statusLastChangedOn,
    awaitUntil: task.awaitUntil,
    gmailThreadId: task.gmailThreadId,
    category: project.name,
    customer: task.customer,
    tags: task.tags,
    epicId: task.epicId,
    goalId,
    isDeleted: !!task.isDeleted,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    orgId: project.orgId,
    orgName: project.orgName,
    isShared: project.memberCount > 1,
    myRole: project.role,
    canEdit: canEdit(project.role),
    reporterId: task.reporterId,
    reporterName: names.get(task.reporterId) ?? null,
    assigneeId: task.assigneeId,
    assigneeName: task.assigneeId ? (names.get(task.assigneeId) ?? null) : null,
    // Rows synced from the legacy single-user table have no updated_by: the reporter made them
    updatedById: task.updatedBy ?? task.reporterId,
    updatedByName: names.get(task.updatedBy ?? task.reporterId) ?? null,
    isMine: task.assigneeId === userId || (!task.assigneeId && task.reporterId === userId),
    refs,
  };
  return Object.hasOwn(task, 'notes')
    ? ({ ...base, notes: task.notes } as TaskView)
    : base;
}

async function personalGoalMap(db: DB, userId: string, taskIds: string[]) {
  const map = new Map<string, string>();
  const ids = Array.from(new Set(taskIds));
  for (let index = 0; index < ids.length; index += 90) {
    const chunk = ids.slice(index, index + 90);
    const links = await db
      .select({ taskId: schema.taskUserGoals.taskId, goalId: schema.taskUserGoals.goalId })
      .from(schema.taskUserGoals)
      .where(
        and(
          eq(schema.taskUserGoals.userId, userId),
          inArray(schema.taskUserGoals.taskId, chunk)
        )
      );
    for (const link of links) {
      if (!map.has(link.taskId)) {
        map.set(link.taskId, link.goalId);
      }
    }
  }
  return map;
}

async function buildViews(db: DB, userId: string, rows: TaskRow[], projects: AccessibleProject[]) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const visible = rows.filter((task) => byId.has(task.projectId));
  if (visible.length === 0) {
    return [] as TaskListView[];
  }
  const taskIds = visible.map((task) => task.id);
  const refs = await fetchRefRows(
    db,
    visible.map((task) => byId.get(task.projectId)!.orgId),
    new Set(taskIds)
  );
  const [names, goals, noteMetadata] = await Promise.all([
    getUserNames(db, [
      ...visible.flatMap((task) => [task.reporterId, task.assigneeId, task.updatedBy]),
      ...Array.from(refs.values()).flatMap((list) => list.map((ref) => ref.createdBy)),
    ]),
    personalGoalMap(db, userId, taskIds),
    taskListService.getTaskNoteMetadata(db, taskIds),
  ]);
  return visible.map((task) => {
    const project = byId.get(task.projectId)!;
    return toView(
      task,
      project,
      userId,
      names,
      goals.get(task.id) ?? null,
      refViewsFor(refs.get(task.id), names, canEdit(project.role)),
      noteMetadata.get(task.id) ?? { noteCount: 0, lastNoteAt: null }
    );
  });
}

export async function getProjectTaskListForUser(
  db: DB,
  userId: string,
  filters: ProjectFilters = {},
  options: { fields?: TaskListFields; limit?: number; cursor?: string } = {}
): Promise<TaskListResult<TaskListView>> {
  const [result, projects] = await Promise.all([
    taskListService.getTaskListForUser(db, userId, filters, {
      ...options,
      scope: 'projects',
    }),
    getAccessibleProjects(db, userId),
  ]);
  const items = await buildViews(db, userId, result.items as TaskRow[], projects);
  return {
    items,
    ...(result.total !== undefined ? { total: result.total } : {}),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function getProjectTaskCountsForUser(
  db: DB,
  userId: string,
  filters: ProjectFilters = {}
): Promise<TaskCounts> {
  return taskListService.getTaskCountsForUser(db, userId, filters, 'projects');
}

/** Read selected task ids for bounded context-building callers such as voice. */
export async function getSelectedTaskSummariesForUser(
  db: DB,
  userId: string,
  taskIds: string[]
): Promise<TaskSummaryView[]> {
  const [rows, projects] = await Promise.all([
    taskListService.getSelectedTaskRows(db, userId, taskIds, { fields: 'summary' }),
    getAccessibleProjects(db, userId),
  ]);
  return (await buildViews(db, userId, rows as TaskRow[], projects)) as TaskSummaryView[];
}

export async function getProjectsForUser(
  db: DB,
  userId: string,
  filters: ProjectFilters = {}
): Promise<TaskView[]> {
  const result = await getProjectTaskListForUser(db, userId, filters, { fields: 'full' });
  return result.items as TaskView[];
}

/** One task, if the user can see it. */
export async function getTaskView(
  db: DB,
  userId: string,
  taskId: string,
  { includeDeleted = false } = {}
): Promise<TaskView | null> {
  const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (!task || (task.isDeleted && !includeDeleted)) {
    return null;
  }
  const projects = await getAccessibleProjects(db, userId);
  const views = await buildViews(db, userId, [task], projects);
  return (views[0] as TaskView | undefined) ?? null;
}

/** Load a task the user is allowed to change: null if they can't see it, AccessError if view-only. */
export async function loadEditable(db: DB, userId: string, taskId: string) {
  const task = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.isDeleted, false)))
    .get();
  if (!task) {
    return null;
  }
  const projects = await getAccessibleProjects(db, userId);
  const project = projects.find((p) => p.id === task.projectId);
  if (!project) {
    return null;
  }
  if (!canEdit(project.role)) {
    throw new AccessError(`You have view-only access to "${project.name}"`);
  }
  return { task, project, projects };
}

async function assertAssignable(
  db: DB,
  assigneeId: string,
  project: AccessibleProject
): Promise<void> {
  const member = await db
    .select({ role: schema.organisationMembers.role })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.orgId, project.orgId),
        eq(schema.organisationMembers.userId, assigneeId)
      )
    )
    .get();
  if (!member) {
    throw new AccessError(`That person isn't in the "${project.orgName}" workspace`);
  }
}

/** A task can only join an epic in the same workspace (or a private epic of yours in your own). */
async function assertEpicUsable(
  db: DB,
  userId: string,
  epicId: string,
  taskProject: AccessibleProject
) {
  const epic = await db.select().from(schema.epics).where(eq(schema.epics.id, epicId)).get();
  if (!epic) {
    throw new AccessError('Epic not found', 404);
  }
  if (epic.projectId) {
    const projects = await getAccessibleProjects(db, userId);
    const epicProject = projects.find((p) => p.id === epic.projectId);
    if (!epicProject) {
      throw new AccessError('Epic not found', 404);
    }
    if (epicProject.orgId !== taskProject.orgId) {
      throw new AccessError(
        `That epic is in ${epicProject.orgName}, but this task is in ${taskProject.orgName}`
      );
    }
  } else if (epic.userId !== userId || !taskProject.orgIsPersonal) {
    throw new AccessError('Epic not found', 404);
  }
}

/** Taking work out of a shared workspace is an owner/admin decision. */
function assertCanMoveBetween(from: AccessibleProject, to: AccessibleProject) {
  if (from.orgId !== to.orgId && !canManage(from.role)) {
    throw new AccessError(
      `Only owners and admins can move things out of ${from.orgName}. Pick a project in the same workspace.`
    );
  }
}

async function isOrgMember(db: DB, userId: string, orgId: string) {
  const row = await db
    .select({ id: schema.organisationMembers.id })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.orgId, orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .get();
  return !!row;
}

async function validatePersonalGoal(db: DB, userId: string, goalId: string) {
  const goal = await db
    .select({ id: schema.goals.id })
    .from(schema.goals)
    .where(and(eq(schema.goals.id, goalId), eq(schema.goals.userId, userId)))
    .get();
  if (!goal) {
    throw new AccessError('Life goal not found', 404);
  }
}

function personalGoalStatements(
  db: DB,
  userId: string,
  taskId: string,
  goalId: string | null
): BatchItem<'sqlite'>[] {
  const statements: BatchItem<'sqlite'>[] = [
    db
      .delete(schema.taskUserGoals)
      .where(and(eq(schema.taskUserGoals.taskId, taskId), eq(schema.taskUserGoals.userId, userId))),
  ];
  if (goalId) {
    statements.push(db.insert(schema.taskUserGoals).values({ taskId, userId, goalId }));
  }
  return statements;
}

/**
 * What a create answers. A new task has `created: true` and `similar` (likely duplicates in its
 * workspace, best first). When the request's source ref already has a live task, `onDuplicate`
 * decides: `error` (default) throws a 409 carrying that task, `return` gives it back untouched,
 * and `report` adds the request's other refs and a note to it first. Both give `created: false`.
 */
export type CreateResult = TaskView & {
  created: boolean;
  reported?: true;
  similar?: SimilarTask[];
};

interface CreateProjectTarget {
  project: AccessibleProject;
  createProject: boolean;
}

/** Resolve a create destination without creating its project yet. */
async function planProjectForCreate(
  db: DB,
  userId: string,
  categoryName: string | null | undefined
): Promise<CreateProjectTarget> {
  const name = (categoryName || '').trim() || 'General';
  const all = await getAccessibleProjects(db, userId);
  const matches = matchingProjectsForCategory(all, name);
  const editable = matches.find((p) => canEdit(p.role));
  if (editable) {
    return { project: editable, createProject: false };
  }
  if (matches.length > 0) {
    throw new AccessError(`You have view-only access to "${matches[0].name}"`);
  }

  const personal = await db
    .select({ id: schema.organisations.id, name: schema.organisations.name })
    .from(schema.organisations)
    .innerJoin(
      schema.organisationMembers,
      eq(schema.organisationMembers.orgId, schema.organisations.id)
    )
    .where(
      and(
        eq(schema.organisations.isPersonal, true),
        eq(schema.organisations.createdBy, userId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .get();
  return {
    project: {
      id: uuidv4(),
      key: generateProjectKey(name),
      name,
      orgId: personal?.id ?? '',
      orgName: personal?.name ?? 'Personal',
      orgIsPersonal: true,
      role: 'owner',
      memberCount: 1,
      isArchived: false,
    },
    createProject: true,
  };
}

/** Make the project row alongside the task, so a source race rolls both back. */
async function createProjectRowForTask(
  db: DB,
  userId: string,
  planned: AccessibleProject
): Promise<{ project: AccessibleProject; statement: BatchItem<'sqlite'> }> {
  let orgId = planned.orgId;
  let orgName = planned.orgName;
  if (!orgId) {
    orgId = await ensurePersonalOrg(db, userId);
    const org = await db
      .select({ name: schema.organisations.name })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, orgId))
      .get();
    orgName = org?.name ?? 'Personal';
  }
  const now = new Date().toISOString();
  const row = {
    id: planned.id,
    orgId,
    key: planned.key,
    name: planned.name,
    description: null,
    leadUserId: userId,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  return {
    project: { ...planned, orgId, orgName },
    statement: db.insert(schema.projects).values(row),
  };
}

export async function createProject(
  db: DB,
  userId: string,
  data: ProjectCreatePayload & { id: string; refs?: RefInput[] }
): Promise<CreateResult> {
  let project: AccessibleProject;
  let needsProjectInsert = false;
  if (data.projectId) {
    const found = (await getAccessibleProjects(db, userId)).find((p) => p.id === data.projectId);
    if (!found) {
      throw new AccessError('Project not found', 404);
    }
    if (!canEdit(found.role)) {
      throw new AccessError(`You have view-only access to "${found.name}"`);
    }
    project = found;
  } else {
    const plan = await planProjectForCreate(db, userId, data.category);
    project = plan.project;
    needsProjectInsert = plan.createProject;
  }

  const assigneeId = data.assigneeId === undefined ? userId : data.assigneeId;
  if (assigneeId && assigneeId !== userId) {
    await assertAssignable(db, assigneeId, project);
  }
  if (data.epicId) {
    await assertEpicUsable(db, userId, data.epicId, project);
  }
  if (data.goalId) {
    await validatePersonalGoal(db, userId, data.goalId);
  }

  // Refs are checked before anything is written; a bad ref stops the create
  const refInputs: RefInput[] = [...(data.refs ?? [])];
  if (data.gmailThreadId?.trim()) {
    refInputs.push({ ref: data.gmailThreadId, kind: 'gmail.thread' });
  }
  const refRows = await prepareRefsForCreate(db, userId, data.id, project.orgId, refInputs);
  const source = refRows.find((r) => r.role === 'source');
  // The column mirrors the newest gmail.thread ref, in its stored (trimmed) form
  const gmailRefs = refRows.filter((r) => r.kind === 'gmail.thread');
  const gmailThreadId = gmailRefs.length ? gmailRefs[gmailRefs.length - 1].ref : null;

  const now = new Date().toISOString();
  const taskInsert = () =>
    db.insert(schema.tasks).values({
      id: data.id,
      projectId: project.id,
      epicId: data.epicId ?? null,
      reporterId: userId,
      assigneeId,
      title: data.project,
      reason: data.reason ?? null,
      status: data.status,
      priority: data.priority,
      size: data.size,
      notes: data.notes ?? null,
      statusLastChangedOn: now,
      awaitUntil: data.awaitUntil ?? null,
      gmailThreadId,
      customer: data.customer ?? null,
      tags: data.tags ?? null,
      isDeleted: false,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    });

  // The source index is the lock: check it before writing, then re-resolve if the holder changed
  // while a duplicate response or a conditional report write was being prepared.
  const maxSourceAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    const holder = source && project.orgId ? await findSourceHolder(db, project.orgId, source) : null;
    if (source && holder && !holder.isDeleted) {
      try {
        return await answerDuplicate(db, userId, holder.taskId, project.orgId, source, data, refRows);
      } catch (err) {
        if (!(err instanceof SourceHolderChangedError)) {
          throw err;
        }
        if (attempt >= maxSourceAttempts) {
          throw new RefError('Source ownership changed while creating. Retry the request.', 409);
        }
        continue;
      }
    }
    try {
      const beforeCreate: BatchItem<'sqlite'>[] = holder ? releaseSource(db, holder) : [];
      if (needsProjectInsert) {
        const created = await createProjectRowForTask(db, userId, project);
        project = created.project;
        for (const ref of refRows) {
          ref.orgId = project.orgId;
        }
        beforeCreate.push(created.statement);
      }
      const afterCreate = data.goalId
        ? personalGoalStatements(db, userId, data.id, data.goalId)
        : [];
      await insertTaskWithRefs(db, taskInsert(), refRows, beforeCreate, afterCreate);
      break;
    } catch (err) {
      if (!(err instanceof RefConflictError || err instanceof SourceHolderChangedError)) {
        throw err;
      }
      if (attempt >= maxSourceAttempts) {
        if (err instanceof RefConflictError) {
          const visible = await getTaskView(db, userId, err.taskId);
          if (visible && visible.orgId === project.orgId) {
            err.task = visible;
            throw err;
          }
        }
        throw new RefError('Source ownership changed while creating. Retry the request.', 409);
      }
    }
  }
  await logActivity(db, {
    actorId: userId,
    orgId: project.orgId,
    projectId: project.id,
    entityType: 'task',
    entityId: data.id,
    taskId: data.id,
    epicId: data.epicId ?? null,
    action: 'created',
    summary: `Created "${data.project}"`,
    // Canonical forms only: labels may hold names
    changes: refRows.length ? { refs: { from: [], to: refRows.map(canonicalRef) } } : null,
  });

  const view = (await getTaskView(db, userId, data.id))!;
  let similar: SimilarTask[] = [];
  try {
    similar = await findSimilarTasks(db, userId, {
      title: data.project,
      orgId: project.orgId,
      excludeId: data.id,
    });
  } catch (err) {
    console.error('[Similar tasks] Could not load post-create suggestions', err);
  }
  return { ...view, created: true, similar };
}

/**
 * A create whose source already has a live task, answered as `onDuplicate` asks. The holder is
 * in the same workspace as the request, so the caller can see it; `report` needs edit rights
 * on it, checked before anything is added.
 */
async function verifiedDuplicateHolder(
  db: DB,
  userId: string,
  holderId: string,
  orgId: string,
  source: { kind: string; ref: string }
): Promise<TaskView> {
  const guard: SourceHolderGuard = { taskId: holderId, orgId, kind: source.kind, ref: source.ref, userId };
  const holder = await getTaskView(db, userId, holderId);
  if (!holder) {
    if (!(await hasCurrentSourceHolder(db, guard))) {
      throw new SourceHolderChangedError();
    }
    throw new AccessError('Task not found or access denied', 404);
  }
  if (
    holder.orgId !== orgId ||
    holder.isDeleted ||
    !(await hasCurrentSourceHolder(db, guard))
  ) {
    throw new SourceHolderChangedError();
  }
  return holder;
}

async function answerDuplicate(
  db: DB,
  userId: string,
  holderId: string,
  orgId: string,
  source: { kind: string; ref: string },
  data: ProjectCreatePayload,
  refRows: Awaited<ReturnType<typeof prepareRefsForCreate>>
): Promise<CreateResult> {
  const mode = data.onDuplicate ?? 'error';
  const guard: SourceHolderGuard = { taskId: holderId, orgId, kind: source.kind, ref: source.ref, userId };
  const holder = await verifiedDuplicateHolder(db, userId, holderId, orgId, source);
  if (mode === 'error') {
    const err = sourceConflict(source, holder.id, holder.project);
    err.task = holder;
    throw err;
  }
  if (mode === 'return') {
    return { ...holder, created: false };
  }

  let loaded;
  try {
    loaded = await loadEditable(db, userId, holderId);
  } catch (err) {
    if (err instanceof AccessError && !(await hasCurrentSourceHolder(db, guard))) {
      throw new SourceHolderChangedError();
    }
    throw err;
  }
  if (!loaded) {
    if (!(await hasCurrentSourceHolder(db, guard))) {
      throw new SourceHolderChangedError();
    }
    throw new AccessError('Task not found or access denied', 404);
  }
  if (loaded.project.orgId !== orgId || !(await hasCurrentSourceHolder(db, guard))) {
    throw new SourceHolderChangedError();
  }

  // Report refs and the note use conditional writes tied to this exact live source holder.
  const added = await addResolvedRefs(
    db,
    userId,
    holderId,
    refRows.filter((r) => r.role !== 'source'),
    guard
  );
  const title = data.project.trim();
  const notes = data.notes?.trim() || '';
  const sameTitle = title.toLowerCase() === loaded.task.title.trim().toLowerCase();
  if (!(sameTitle && !notes && added === 0)) {
    const note = `Reported again: "${title}"${notes ? `\n${notes}` : ''}`;
    // Keep earlier matching notes idempotent; the unique key handles concurrent report requests.
    const said = await db
      .select({ id: schema.taskUpdates.id })
      .from(schema.taskUpdates)
      .where(and(eq(schema.taskUpdates.taskId, holderId), eq(schema.taskUpdates.note, note)))
      .get();
    if (!said) {
      await addProjectUpdate(db, {
        projectId: holderId,
        userId,
        note,
        dedupeKey: await reportNoteDedupeKey(note),
        sourceGuard: guard,
      });
    }
  }
  const current = await verifiedDuplicateHolder(db, userId, holderId, orgId, source);
  return { ...current, created: false, reported: true };
}

const TRACKED_FIELDS = [
  'title',
  'reason',
  'status',
  'priority',
  'size',
  'notes',
  'awaitUntil',
  'gmailThreadId',
  'customer',
  'tags',
  'epicId',
  'assigneeId',
  'projectId',
  'isDeleted',
];

export async function updateProject(
  db: DB,
  userId: string,
  taskId: string,
  data: ProjectUpdatePayload
): Promise<TaskView | null> {
  const loaded = await loadEditable(db, userId, taskId);
  if (!loaded) {
    return null;
  }
  const { task, project, projects } = loaded;

  const patch: Partial<typeof schema.tasks.$inferInsert> = {};
  if (data.project !== undefined) {
    patch.title = data.project;
  }
  for (const key of [
    'reason',
    'status',
    'priority',
    'size',
    'notes',
    'awaitUntil',
    'customer',
    'tags',
    'isDeleted',
  ] as const) {
    if (data[key] !== undefined) {
      (patch as any)[key] = data[key];
    }
  }
  // gmailThreadId is a view onto gmail.thread refs: compare it in stored form, so a form that
  // saves the field unchanged is not an edit (syncGmailThread below writes the column)
  const gmailThreadId =
    data.gmailThreadId === undefined ? undefined : normaliseGmailThreadId(data.gmailThreadId);
  if (gmailThreadId !== undefined && gmailThreadId !== (task.gmailThreadId?.trim() || null)) {
    patch.gmailThreadId = gmailThreadId;
  }

  // Moving between projects: by id, or by category name (the original API)
  let targetProject = project;
  if (data.projectId && data.projectId !== task.projectId) {
    const found = projects.find((p) => p.id === data.projectId);
    if (!found) {
      throw new AccessError('Project not found', 404);
    }
    if (!canEdit(found.role)) {
      throw new AccessError(`You have view-only access to "${found.name}"`);
    }
    targetProject = found;
  } else if (
    data.category !== undefined &&
    (data.category || 'General').trim().toLowerCase() !== project.name.toLowerCase()
  ) {
    targetProject = await resolveProjectForWrite(db, userId, data.category);
  }
  if (targetProject.id !== task.projectId) {
    assertCanMoveBetween(project, targetProject);
    patch.projectId = targetProject.id;
  }

  if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) {
    if (data.assigneeId) {
      await assertAssignable(db, data.assigneeId, targetProject);
    }
    patch.assigneeId = data.assigneeId;
  }
  if (data.epicId !== undefined && data.epicId !== task.epicId) {
    if (data.epicId) {
      await assertEpicUsable(db, userId, data.epicId, targetProject);
    }
    patch.epicId = data.epicId;
  }

  // Moving to another workspace: the assignee must be in it, and the epic must come along
  if (patch.projectId && targetProject.orgId !== project.orgId) {
    const assignee = patch.assigneeId !== undefined ? patch.assigneeId : task.assigneeId;
    if (assignee && !(await isOrgMember(db, assignee, targetProject.orgId))) {
      patch.assigneeId = null;
    }
    const epicId = patch.epicId !== undefined ? patch.epicId : task.epicId;
    if (epicId && data.epicId === undefined) {
      patch.epicId = null;
    }
  }

  const changes = diffFields(task as any, patch as any, TRACKED_FIELDS);
  const movesWorkspace = !!patch.projectId && targetProject.orgId !== project.orgId;

  // Validate private goal links before preparing any writes, then batch their replacement with
  // the task and ref move so a failed move cannot leave a partial change behind.
  let goalWrites: BatchItem<'sqlite'>[] = [];
  if (data.goalId !== undefined) {
    const current = (await personalGoalMap(db, userId, [taskId])).get(taskId) ?? null;
    const next = data.goalId ?? null;
    if (next !== current) {
      if (next) {
        await validatePersonalGoal(db, userId, next);
      }
      goalWrites = personalGoalStatements(db, userId, taskId, next);
    }
  }

  // Source release statements are returned, not committed here. A deleted holder only releases
  // its source in the same database batch as the successful move.
  const sourceReleases = movesWorkspace
    ? await assertSourcesFreeIn(db, targetProject.orgId, { taskId })
    : [];

  if (Object.keys(changes).length > 0 || goalWrites.length > 0) {
    const now = new Date().toISOString();
    const set: Partial<typeof schema.tasks.$inferInsert> = {
      ...patch,
      updatedAt: now,
      updatedBy: userId,
    };
    if (changes.status) {
      set.statusLastChangedOn = now;
    }
    if (changes.status && patch.status !== 'awaiting' && data.awaitUntil === undefined) {
      set.awaitUntil = null;
    }

    const writes: BatchItem<'sqlite'>[] = [...sourceReleases];
    if (Object.keys(changes).length > 0) {
      writes.push(db.update(schema.tasks).set(set).where(eq(schema.tasks.id, taskId)));
      if (movesWorkspace) {
        writes.push(updateRefOrgs(db, targetProject.orgId, { taskId }));
      }
    }
    writes.push(...goalWrites);
    await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

    if (Object.keys(changes).length > 0) {
      await logTaskChanges(db, userId, task, targetProject, changes);
    }
  }

  // gmailThreadId is a view onto gmail.thread refs
  if (patch.gmailThreadId !== undefined) {
    await syncGmailThread(db, userId, task, targetProject.orgId, patch.gmailThreadId ?? null);
  }

  return getTaskView(db, userId, taskId, { includeDeleted: true });
}

async function logTaskChanges(
  db: DB,
  userId: string,
  task: TaskRow,
  project: AccessibleProject,
  changes: FieldChanges
) {
  const base = {
    actorId: userId,
    orgId: project.orgId,
    projectId: project.id,
    entityType: 'task' as const,
    entityId: task.id,
    taskId: task.id,
    epicId: (changes.epicId?.to as string | null) ?? task.epicId,
  };
  const title = (changes.title?.to as string) ?? task.title;

  if (changes.isDeleted) {
    await logActivity(db, {
      ...base,
      action: changes.isDeleted.to ? 'deleted' : 'restored',
      summary: changes.isDeleted.to ? `Deleted "${title}"` : `Restored "${title}"`,
    });
    return;
  }

  const rest: FieldChanges = { ...changes };
  if (changes.status) {
    delete rest.status;
    const awaiting =
      changes.status.to === 'awaiting' && (changes.awaitUntil?.to || task.awaitUntil)
        ? ` until ${changes.awaitUntil?.to ?? task.awaitUntil}`
        : '';
    delete rest.awaitUntil;
    await logActivity(db, {
      ...base,
      action: changes.status.to === 'done' ? 'completed' : 'status_changed',
      summary: `Moved "${title}" from ${statusLabel(changes.status.from)} to ${statusLabel(changes.status.to)}${awaiting}`,
      changes: { status: changes.status },
    });
  }
  if (changes.assigneeId) {
    delete rest.assigneeId;
    const names = await getUserNames(db, [changes.assigneeId.to as string]);
    const to = changes.assigneeId.to
      ? (names.get(changes.assigneeId.to as string) ?? 'someone')
      : null;
    await logActivity(db, {
      ...base,
      action: 'assigned',
      summary: to ? `Assigned "${title}" to ${to}` : `Unassigned "${title}"`,
      changes: { assigneeId: changes.assigneeId },
    });
  }
  if (changes.projectId) {
    delete rest.projectId;
    await logActivity(db, {
      ...base,
      action: 'moved',
      summary: `Moved "${title}" to ${project.name}`,
      changes: { projectId: changes.projectId },
    });
  }
  const summary = describeFieldEdits(rest);
  if (summary) {
    await logActivity(db, {
      ...base,
      action: 'updated',
      summary: `${summary} on "${title}"`,
      changes: rest,
    });
  }
}

/** Soft delete. Viewers get an AccessError (403) rather than a misleading 404. */
export async function deleteProject(db: DB, userId: string, taskId: string) {
  const result = await updateProject(db, userId, taskId, { isDeleted: true });
  return !!result;
}

export async function batchUpdateProjects(
  db: DB,
  userId: string,
  updates: ProjectUpdateBatchPayload
) {
  if (updates.length === 0) {
    return [];
  }
  const projects = await getAccessibleProjects(db, userId);
  const roleByProject = new Map(projects.map((p) => [p.id, p]));
  const now = new Date().toISOString();

  for (const update of updates) {
    const task = await db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, update.id), eq(schema.tasks.isDeleted, false)))
      .get();
    const project = task ? roleByProject.get(task.projectId) : undefined;
    if (!task || !project || !canEdit(project.role)) {
      continue;
    }
    if (task.priority === update.priority && task.status === update.status) {
      continue;
    }

    const set: Partial<typeof schema.tasks.$inferInsert> = {
      priority: update.priority,
      status: update.status,
      updatedAt: now,
      updatedBy: userId,
    };
    if (task.status !== update.status) {
      set.statusLastChangedOn = now;
    }
    await db.update(schema.tasks).set(set).where(eq(schema.tasks.id, task.id));
    if (task.status !== update.status) {
      await logTaskChanges(db, userId, task, project, {
        status: { from: task.status, to: update.status },
      });
    }
  }
  return [];
}

/**
 * Finds all tasks whose awaiting date has passed and returns them to "do" status.
 * Each row is updated independently: one bad row won't block the batch.
 */
export async function processAwaitingReturns(db: DB) {
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const due = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      projectId: schema.tasks.projectId,
      orgId: schema.projects.orgId,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .where(
      and(
        eq(schema.tasks.status, 'awaiting'),
        isNotNull(schema.tasks.awaitUntil),
        lte(schema.tasks.awaitUntil, now),
        eq(schema.tasks.isDeleted, false)
      )
    );

  let flipped = 0;
  for (const task of due) {
    try {
      const ts = new Date().toISOString();
      await db
        .update(schema.tasks)
        .set({ status: 'do', awaitUntil: null, statusLastChangedOn: ts, updatedAt: ts })
        .where(eq(schema.tasks.id, task.id));
      await logActivity(db, {
        actorId: null,
        orgId: task.orgId,
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        taskId: task.id,
        action: 'status_changed',
        summary: `Brought "${task.title}" back to Do (return date reached)`,
        changes: { status: { from: 'awaiting', to: 'do' } },
      });
      flipped++;
    } catch (e) {
      console.error(`Failed to flip awaiting task ${task.id}:`, e);
    }
  }

  return { flipped, total: due.length };
}

export interface NoteView {
  id: string;
  projectId: string;
  userId: string;
  authorName: string | null;
  note: string;
  gmailThreadId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  canDelete: boolean;
}

export async function getProjectUpdates(
  db: DB,
  taskId: string,
  userId: string
): Promise<NoteView[] | null> {
  const view = await getTaskView(db, userId, taskId);
  if (!view) {
    return null;
  }
  const rows = await db
    .select()
    .from(schema.taskUpdates)
    .where(eq(schema.taskUpdates.taskId, taskId))
    .orderBy(asc(schema.taskUpdates.createdAt));
  const names = await getUserNames(
    db,
    rows.map((r) => r.authorId)
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.taskId,
    userId: r.authorId,
    authorName: names.get(r.authorId) ?? null,
    note: r.note,
    gmailThreadId: r.gmailThreadId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    canDelete: r.authorId === userId || canManage(view.myRole),
  }));
}

async function reportNoteDedupeKey(note: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(note));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// D1 batch needs _prepare() to return a D1PreparedQuery with a bindable statement.
function preparedSqlBatchItem(
  db: DB,
  query: SQL,
  method: 'all' | 'run'
): BatchItem<'sqlite'> {
  const internalDb = db as DB & {
    dialect: SQLiteAsyncDialect;
    session: SQLiteD1Session<typeof schema, any>;
  };
  const prepared = internalDb.session.prepareQuery(
    internalDb.dialect.sqlToQuery(query),
    undefined,
    method,
    false
  );
  return {
    _: { dialect: 'sqlite', result: undefined },
    _prepare: () => prepared,
  } as BatchItem<'sqlite'> & { _prepare: () => typeof prepared };
}

export async function addProjectUpdate(
  db: DB,
  params: {
    id?: string;
    projectId: string;
    userId: string;
    note: string;
    gmailThreadId?: string | null;
    dedupeKey?: string;
    sourceGuard?: SourceHolderGuard;
  }
) {
  let loaded: Awaited<ReturnType<typeof loadEditable>>;
  try {
    loaded = await loadEditable(db, params.userId, params.projectId);
  } catch (err) {
    if (
      params.sourceGuard &&
      err instanceof AccessError &&
      !(await hasCurrentSourceHolder(db, params.sourceGuard))
    ) {
      throw new SourceHolderChangedError();
    }
    throw err;
  }
  if (!loaded) {
    if (params.sourceGuard && !(await hasCurrentSourceHolder(db, params.sourceGuard))) {
      throw new SourceHolderChangedError();
    }
    return null;
  }
  const { task, project } = loaded;
  if (
    params.sourceGuard &&
    (task.id !== params.sourceGuard.taskId ||
      project.orgId !== params.sourceGuard.orgId ||
      !(await hasCurrentSourceHolder(db, params.sourceGuard)))
  ) {
    throw new SourceHolderChangedError();
  }
  const now = new Date().toISOString();
  const row = {
    id: params.id ?? uuidv4(),
    taskId: task.id,
    authorId: params.userId,
    note: params.note,
    gmailThreadId: params.gmailThreadId ?? null,
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (params.sourceGuard) {
    if (!params.dedupeKey) {
      throw new Error('A guarded report note needs a dedupe key');
    }
    const writes: BatchItem<'sqlite'>[] = [
      preparedSqlBatchItem(
        db,
        sql`
          INSERT INTO TaskUpdates (id, task_id, author_id, note, gmail_thread_id, dedupe_key, created_at, updated_at)
          SELECT ${row.id}, ${row.taskId}, ${row.authorId}, ${row.note}, ${row.gmailThreadId},
            ${params.dedupeKey}, ${row.createdAt}, ${row.updatedAt}
          WHERE ${sourceHolderCondition(params.sourceGuard, true)}
          ON CONFLICT(task_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
          RETURNING id
        `,
        'all'
      ),
      preparedSqlBatchItem(
        db,
        sql`
          UPDATE Tasks SET updated_at = ${now}, updated_by = ${params.userId}
          WHERE id = ${task.id}
            AND EXISTS (SELECT 1 FROM TaskUpdates WHERE id = ${row.id})
            AND ${sourceHolderCondition(params.sourceGuard, true)}
        `,
        'run'
      ),
      preparedSqlBatchItem(
        db,
        sql`SELECT 1 WHERE ${sourceHolderCondition(params.sourceGuard, true)}`,
        'all'
      ),
    ];
    const results = await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    const inserted = results[0] as unknown[][];
    const holderStillCurrent = results[2] as unknown[][];
    if (holderStillCurrent.length === 0) {
      throw new SourceHolderChangedError();
    }
    if (inserted.length === 0) {
      return null;
    }
  } else if (params.dedupeKey) {
    const inserted = await db
      .insert(schema.taskUpdates)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: schema.taskUpdates.id });
    if (inserted.length === 0) {
      return null;
    }
  } else {
    await db.insert(schema.taskUpdates).values(row);
  }
  if (!params.sourceGuard) {
    await db
      .update(schema.tasks)
      .set({ updatedAt: now, updatedBy: params.userId })
      .where(eq(schema.tasks.id, task.id));
  }
  const preview = params.note.length > 140 ? `${params.note.slice(0, 137)}...` : params.note;
  await logActivity(db, {
    actorId: params.userId,
    orgId: project.orgId,
    projectId: project.id,
    entityType: 'note',
    entityId: row.id,
    taskId: task.id,
    epicId: task.epicId,
    action: 'note_added',
    summary: `Added a note to "${task.title}": ${preview}`,
  });
  const names = await getUserNames(db, [params.userId]);
  return {
    id: row.id,
    projectId: task.id,
    userId: params.userId,
    authorName: names.get(params.userId) ?? null,
    note: row.note,
    gmailThreadId: row.gmailThreadId,
    createdAt: now,
    updatedAt: now,
    canDelete: true,
  };
}

export async function deleteProjectUpdate(
  db: DB,
  params: { updateId: string; projectId: string; userId: string }
) {
  const view = await getTaskView(db, params.userId, params.projectId);
  if (!view) {
    return false;
  }
  const note = await db
    .select()
    .from(schema.taskUpdates)
    .where(
      and(
        eq(schema.taskUpdates.id, params.updateId),
        eq(schema.taskUpdates.taskId, params.projectId)
      )
    )
    .get();
  if (!note) {
    return false;
  }
  if (note.authorId !== params.userId && !canManage(view.myRole)) {
    return false;
  }
  await db.delete(schema.taskUpdates).where(eq(schema.taskUpdates.id, note.id));
  await logActivity(db, {
    actorId: params.userId,
    orgId: view.orgId,
    projectId: view.projectId,
    entityType: 'note',
    entityId: note.id,
    taskId: view.id,
    action: 'note_deleted',
    summary: `Deleted a note on "${view.project}"`,
  });
  return true;
}

const SIZE_ORDER: Record<string, number> = {
  '*': 1,
  '**': 2,
  '***': 3,
  '****': 4,
  '*****': 5,
};

function pickLargerSize(sizeA: string, sizeB: string): '*' | '**' | '***' | '****' | '*****' {
  const rankA = SIZE_ORDER[sizeA] || 3;
  const rankB = SIZE_ORDER[sizeB] || 3;
  return (rankB > rankA ? sizeB : sizeA) as '*' | '**' | '***' | '****' | '*****';
}

async function prepareRelationsForMerge(
  db: DB,
  targetId: string,
  sourceId: string
): Promise<BatchItem<'sqlite'>[]> {
  const rows = await db
    .select()
    .from(schema.taskRelations)
    .where(
      or(
        eq(schema.taskRelations.sourceTaskId, targetId),
        eq(schema.taskRelations.targetTaskId, targetId),
        eq(schema.taskRelations.sourceTaskId, sourceId),
        eq(schema.taskRelations.targetTaskId, sourceId)
      )
    );
  const targetNeighbours = new Set(
    rows
      .filter((row) => row.sourceTaskId === targetId || row.targetTaskId === targetId)
      .map((row) => (row.sourceTaskId === targetId ? row.targetTaskId : row.sourceTaskId))
      .filter((id) => id !== sourceId)
  );
  const statements: BatchItem<'sqlite'>[] = [];
  for (const row of rows) {
    const involvesSource = row.sourceTaskId === sourceId || row.targetTaskId === sourceId;
    if (!involvesSource) {
      continue;
    }
    const neighbourId = row.sourceTaskId === sourceId ? row.targetTaskId : row.sourceTaskId;
    if (neighbourId === targetId || targetNeighbours.has(neighbourId)) {
      // The merge creates a self-link, or the target already has the one relation allowed per pair.
      statements.push(db.delete(schema.taskRelations).where(eq(schema.taskRelations.id, row.id)));
      continue;
    }
    targetNeighbours.add(neighbourId);
    statements.push(
      db
        .update(schema.taskRelations)
        .set(row.sourceTaskId === sourceId ? { sourceTaskId: targetId } : { targetTaskId: targetId })
        .where(eq(schema.taskRelations.id, row.id))
    );
  }
  return statements;
}

export async function mergeProjects(db: DB, userId: string, targetId: string, sourceId: string) {
  if (targetId === sourceId) {
    return null;
  }

  let target, source;
  try {
    target = await loadEditable(db, userId, targetId);
    source = await loadEditable(db, userId, sourceId);
  } catch (err) {
    if (err instanceof AccessError) {
      return null;
    }
    throw err;
  }
  if (!target || !source) {
    return null;
  }
  const t = target.task;
  const s = source.task;
  if (target.project.orgId !== source.project.orgId) {
    // Merging copies notes and history, which would expose them to another workspace
    throw new AccessError('Only tasks in the same workspace can be merged');
  }
  const now = new Date().toISOString();

  let combinedNotes = t.notes || '';
  if (s.notes && s.notes.trim()) {
    const mergeHeader = `

---
Merged from "${s.title}" (${s.id.slice(0, 8)}):
`;
    combinedNotes = combinedNotes ? combinedNotes + mergeHeader + s.notes : s.notes;
  }

  let combinedReason = t.reason || null;
  if (!combinedReason && s.reason) {
    combinedReason = s.reason;
  } else if (combinedReason && s.reason && s.reason !== combinedReason) {
    combinedReason = `${combinedReason} (Also: ${s.reason})`;
  }

  const [goals, refStatements, relationStatements, targetUpdates, sourceUpdates, newestGmailRef] =
    await Promise.all([
      personalGoalMap(db, userId, [t.id, s.id]),
      prepareRefsForMerge(db, s.id, t.id),
      prepareRelationsForMerge(db, t.id, s.id),
      db
        .select({ dedupeKey: schema.taskUpdates.dedupeKey })
        .from(schema.taskUpdates)
        .where(eq(schema.taskUpdates.taskId, t.id)),
      db.select().from(schema.taskUpdates).where(eq(schema.taskUpdates.taskId, s.id)),
      db
        .select({ ref: schema.taskRefs.ref })
        .from(schema.taskRefs)
        .where(
          and(
            inArray(schema.taskRefs.taskId, [t.id, s.id]),
            eq(schema.taskRefs.kind, 'gmail.thread')
          )
        )
        .orderBy(desc(schema.taskRefs.createdAt), desc(sql`rowid`))
        .get(),
    ]);
  const targetDedupeKeys = new Set(
    targetUpdates.map((row) => row.dedupeKey).filter((key): key is string => key !== null)
  );
  const collidedNotes = sourceUpdates.filter(
    (row) => row.dedupeKey !== null && targetDedupeKeys.has(row.dedupeKey)
  );
  const collisionStatements = collidedNotes.map((row) =>
    db
      .update(schema.taskUpdates)
      .set({
        taskId: t.id,
        dedupeKey: `merged:${s.id}:${row.id}`,
        updatedAt: now,
      })
      .where(eq(schema.taskUpdates.id, row.id))
  );
  const goalStatements = !goals.get(t.id) && goals.get(s.id)
    ? personalGoalStatements(db, userId, t.id, goals.get(s.id)!)
    : [];
  const sourceAuditNote = `[Merged into "${t.title}" (${t.id.slice(0, 8)}) on ${now.slice(0, 10)}]`;

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(schema.tasks)
      .set({
        priority: Math.max(t.priority, s.priority),
        size: pickLargerSize(t.size, s.size),
        notes: combinedNotes || null,
        reason: combinedReason,
        epicId: t.epicId ?? s.epicId ?? null,
        gmailThreadId: newestGmailRef?.ref ?? null,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(schema.tasks.id, t.id)),
    ...refStatements,
    ...relationStatements,
    ...goalStatements,
    ...collisionStatements,
    db
      .update(schema.taskUpdates)
      .set({ taskId: t.id, updatedAt: now })
      .where(eq(schema.taskUpdates.taskId, s.id)),
    db
      .update(schema.tasks)
      .set({
        isDeleted: true,
        notes: s.notes ? `${s.notes}\n\n${sourceAuditNote}` : sourceAuditNote,
        updatedAt: now,
        updatedBy: userId,
      })
      .where(eq(schema.tasks.id, s.id)),
    db.insert(schema.taskUpdates).values({
      id: uuidv4(),
      taskId: t.id,
      authorId: userId,
      note: `Merged task '${s.title}' (${s.id.slice(0, 8)}) into this task.`,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

  await logActivity(db, {
    actorId: userId,
    orgId: target.project.orgId,
    projectId: target.project.id,
    entityType: 'task',
    entityId: t.id,
    taskId: t.id,
    action: 'merged',
    summary: `Merged "${s.title}" into "${t.title}"`,
  });

  return getTaskView(db, userId, t.id);
}
