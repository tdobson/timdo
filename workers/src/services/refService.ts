/**
 * Task refs: typed pointers from a task to things outside TimDo (see lib/refs.ts for the
 * parser). Anyone who can see a task sees its refs; adding and removing needs edit rights.
 *
 * Rules kept here:
 * - the same role + kind + ref twice on one task is a no-op (`existing: true`)
 * - a kind:ref can be the `source` of at most one live task per workspace (409 naming that
 *   task); a deleted task gives its source up (it becomes a link) when another task claims it
 * - a task is created with at most one source
 * - Tasks.gmail_thread_id mirrors the newest `gmail.thread` ref
 * - labels may hold names, so they never reach the activity log
 */
import { and, desc, eq, inArray, not, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import {
  canonicalRef,
  CONTROL_ERROR,
  defaultLabel,
  hasControlChars,
  LABEL_CONTROL_ERROR,
  MAX_LABEL_LENGTH,
  normaliseRole,
  parseRef,
  ROLE_ERROR,
  type ParsedRef,
  type RefRole,
} from '../lib/refs';
import { AccessError, canEdit, getAccessibleProjects, getUserNames } from './accessService';
import { logActivity } from './activityService';
import { loadEditable, getTaskView } from './projectService';

type DB = DrizzleD1Database<typeof schema>;
type RefRow = typeof schema.taskRefs.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;

export interface RefView {
  id: string;
  taskId: string;
  role: RefRole;
  kind: string;
  ref: string;
  canonical: string;
  url: string | null;
  label: string | null;
  displayLabel: string;
  createdById: string | null;
  createdByName: string | null;
  createdAt: string | null;
  canDelete: boolean;
}

export interface RefInput {
  ref: string;
  kind?: string;
  role?: RefRole;
  label?: string;
  url?: string;
}

/** A ref problem with its HTTP status: bad input (400), missing (404) or a source clash (409). */
export class RefError extends Error {
  status: 400 | 404 | 409;
  taskId?: string;
  task?: unknown;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The ref is already the source of another task in the workspace; `taskId` names it. A create
 * also sets `task` (that task's TaskView), so a client can show it without another request.
 */
export class RefConflictError extends RefError {
  taskId: string;
  constructor(message: string, taskId: string) {
    super(message, 409);
    this.taskId = taskId;
  }
}

export const ONE_SOURCE_ERROR = 'A task can only have one source';

/** A validated ref ready to store. */
export interface ResolvedRef {
  role: RefRole;
  kind: string;
  ref: string;
  url: string | null;
  label: string | null;
}

const NOT_FOUND = 'Task not found or access denied';
const NOT_ON_TASK = "That link isn't on this task";

/** Parse an input or throw a 400 with the parser's sentence. */
export function parseOrThrow(input: string, kind?: string | null): ParsedRef {
  const parsed = parseRef(input, kind ?? undefined);
  if (!parsed.ok) {
    throw new RefError(parsed.error, 400);
  }
  return parsed.value;
}

/** Validate a RefInput: parse it, check the role, label and url. */
export function resolveRefInput(input: RefInput): ResolvedRef {
  const parsed = parseOrThrow(input.ref, input.kind);
  const role = normaliseRole(input.role);
  if (!role) {
    throw new RefError(ROLE_ERROR, 400);
  }
  const label = input.label?.trim() || null;
  if (label && label.length > MAX_LABEL_LENGTH) {
    throw new RefError(`Labels can be ${MAX_LABEL_LENGTH} characters at most`, 400);
  }
  if (label && hasControlChars(label)) {
    throw new RefError(LABEL_CONTROL_ERROR, 400);
  }
  const url = input.url?.trim() || null;
  if (url && hasControlChars(url)) {
    throw new RefError(CONTROL_ERROR, 400);
  }
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    throw new RefError('The url must start with http:// or https://', 400);
  }
  return { role, kind: parsed.kind, ref: parsed.ref, url: url ?? parsed.url, label };
}

function toRefView(row: RefRow, names: Map<string, string>, canDelete: boolean): RefView {
  return {
    id: row.id,
    taskId: row.taskId,
    role: row.role,
    kind: row.kind,
    ref: row.ref,
    canonical: canonicalRef(row),
    url: row.url,
    label: row.label,
    displayLabel: row.label || defaultLabel(row.kind, row.ref, row.url),
    createdById: row.createdBy,
    createdByName: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
    canDelete,
  };
}

const sameRef = (a: { role: string; kind: string; ref: string }, b: typeof a) =>
  a.role === b.role && a.kind === b.kind && a.ref === b.ref;

// Display order: Source, About, Reported by, Link; then oldest first
const ROLE_ORDER: Record<RefRole, number> = { source: 0, about: 1, reported_by: 2, link: 3 };
const byRoleThenAge = (a: RefRow, b: RefRow) =>
  ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || String(a.createdAt).localeCompare(String(b.createdAt));

/* ---------------------------------------------------------------- loading for views */

/**
 * Ref rows for selected tasks, queried by task id in chunks below D1's 100-bind ceiling. A small
 * page never reads every ref in a workspace, and legacy full lists remain complete.
 */
export async function fetchRefRows(
  db: DB,
  _orgIds: string[],
  taskIds: Set<string>
): Promise<Map<string, RefRow[]>> {
  const byTask = new Map<string, RefRow[]>();
  const ids = Array.from(taskIds);
  for (let index = 0; index < ids.length; index += 90) {
    const chunk = ids.slice(index, index + 90);
    const rows = await db
      .select()
      .from(schema.taskRefs)
      .where(inArray(schema.taskRefs.taskId, chunk));
    for (const row of rows) {
      const list = byTask.get(row.taskId) ?? [];
      list.push(row);
      byTask.set(row.taskId, list);
    }
  }
  return byTask;
}

/** Turn fetched rows into views; `names` must cover each row's created_by. */
export function refViewsFor(
  rows: RefRow[] | undefined,
  names: Map<string, string>,
  canDelete: boolean
): RefView[] {
  return (rows ?? [])
    .slice()
    .sort(byRoleThenAge)
    .map((r) => toRefView(r, names, canDelete));
}

/** Refs for many task views at once, keyed by task id. */
export async function loadRefsForViews(
  db: DB,
  _userId: string,
  orgIds: string[],
  taskIds: Set<string>,
  canEditByTask: Map<string, boolean>
): Promise<Map<string, RefView[]>> {
  const rows = await fetchRefRows(db, orgIds, taskIds);
  const all = Array.from(rows.values()).flat();
  const names = await getUserNames(
    db,
    all.map((r) => r.createdBy)
  );
  const views = new Map<string, RefView[]>();
  for (const [taskId, list] of rows) {
    views.set(taskId, refViewsFor(list, names, canEditByTask.get(taskId) ?? false));
  }
  return views;
}

/* ---------------------------------------------------------------- reading */

/** A task the user can see (not deleted), with its project, or a 404. */
async function loadVisible(db: DB, userId: string, taskId: string) {
  const task = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.isDeleted, false)))
    .get();
  if (!task) {
    throw new AccessError(NOT_FOUND, 404);
  }
  const project = (await getAccessibleProjects(db, userId)).find((p) => p.id === task.projectId);
  if (!project) {
    throw new AccessError(NOT_FOUND, 404);
  }
  return { task, project };
}

async function loadEditableOr404(db: DB, userId: string, taskId: string) {
  const loaded = await loadEditable(db, userId, taskId);
  if (!loaded) {
    throw new AccessError(NOT_FOUND, 404);
  }
  return loaded;
}

export async function listRefs(db: DB, userId: string, taskId: string): Promise<RefView[]> {
  const { task, project } = await loadVisible(db, userId, taskId);
  const views = await loadRefsForViews(
    db,
    userId,
    [project.orgId],
    new Set([task.id]),
    new Map([[task.id, canEdit(project.role)]])
  );
  return views.get(task.id) ?? [];
}

async function viewOf(db: DB, row: RefRow, canDelete = true): Promise<RefView> {
  const names = await getUserNames(db, [row.createdBy]);
  return toRefView(row, names, canDelete);
}

/* ---------------------------------------------------------------- source rule */

/** The task holding kind:ref as its source in a workspace, deleted or not. */
export interface SourceHolder {
  refId: string;
  taskId: string;
  title: string;
  isDeleted: boolean;
  kind: string;
  ref: string;
}

/** The source task and workspace that a duplicate report must still match when it writes. */
export interface SourceHolderGuard {
  taskId: string;
  orgId: string;
  kind: string;
  ref: string;
  userId: string;
}

/** A source holder changed after it was read; callers should resolve the source again. */
export class SourceHolderChangedError extends Error {}

/** SQL predicate used by duplicate-report writes to keep their source holder stable. */
export function sourceHolderCondition(
  expected: SourceHolderGuard,
  requireEditor = false
): SQL {
  const editor = requireEditor
    ? sql`AND EXISTS (
        SELECT 1 FROM OrganisationMembers report_member
        WHERE report_member.org_id = ${expected.orgId}
          AND report_member.user_id = ${expected.userId}
          AND report_member.role IN ('owner', 'admin', 'member')
      )`
    : sql``;
  return sql`EXISTS (
    SELECT 1
    FROM TaskRefs report_source
    INNER JOIN Tasks report_task ON report_task.id = report_source.task_id
    INNER JOIN Projects report_project ON report_project.id = report_task.project_id
    WHERE report_source.task_id = ${expected.taskId}
      AND report_source.org_id = ${expected.orgId}
      AND report_source.role = 'source'
      AND report_source.kind = ${expected.kind}
      AND report_source.ref = ${expected.ref}
      AND report_task.is_deleted = 0
      AND report_project.org_id = ${expected.orgId}
      ${editor}
  )`;
}

/** Check source ownership without revealing the holder to a caller who cannot see it. */
export async function hasCurrentSourceHolder(db: DB, expected: SourceHolderGuard): Promise<boolean> {
  const rows = await db.all(sql`SELECT 1 WHERE ${sourceHolderCondition(expected)}`);
  return rows.length > 0;
}

export async function findSourceHolder(
  db: DB,
  orgId: string,
  r: { kind: string; ref: string }
): Promise<SourceHolder | null> {
  const row = await db
    .select({
      refId: schema.taskRefs.id,
      taskId: schema.taskRefs.taskId,
      title: schema.tasks.title,
      isDeleted: schema.tasks.isDeleted,
    })
    .from(schema.taskRefs)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskRefs.taskId))
    .where(
      and(
        eq(schema.taskRefs.orgId, orgId),
        eq(schema.taskRefs.role, 'source'),
        eq(schema.taskRefs.kind, r.kind),
        eq(schema.taskRefs.ref, r.ref)
      )
    )
    .get();
  return row ? { ...row, isDeleted: !!row.isDeleted, kind: r.kind, ref: r.ref } : null;
}

/**
 * Statements that make a deleted task give up a source, to run in the same batch as the write
 * that claims it: the source becomes a link (so the task's history keeps it), or goes when that
 * task already links to the same thing. Restoring the task later does not take it back.
 */
export function releaseSource(
  db: DB,
  holder: Pick<SourceHolder, 'refId' | 'taskId' | 'kind' | 'ref'>,
  claimingTaskId?: string
): BatchItem<'sqlite'>[] {
  const stillDeleted = sql`exists (
    select 1 from Tasks deleted_holder
    inner join Projects deleted_project on deleted_project.id = deleted_holder.project_id
    where deleted_holder.id = TaskRefs.task_id
      and deleted_holder.is_deleted = 1
      and deleted_project.org_id = TaskRefs.org_id
  )`;
  const canRelease = and(
    eq(schema.taskRefs.id, holder.refId),
    eq(schema.taskRefs.role, 'source'),
    eq(schema.taskRefs.kind, holder.kind),
    eq(schema.taskRefs.ref, holder.ref),
    stillDeleted,
    ...(claimingTaskId
      ? [
          sql`not exists (
            select 1 from TaskRefs task_source
            where task_source.task_id = ${claimingTaskId} and task_source.role = 'source'
          )`,
        ]
      : [])
  );
  return [
    db
      .delete(schema.taskRefs)
      .where(
        and(
          canRelease,
          sql`exists (select 1 from TaskRefs l where l.task_id = ${holder.taskId} and l.role = 'link' and l.kind = ${holder.kind} and l.ref = ${holder.ref})`
        )
      ),
    db.update(schema.taskRefs).set({ role: 'link' }).where(canRelease),
  ];
}

/**
 * Before a task (other than `exceptTaskId`) takes kind:ref as its source: a 409 if a live task
 * holds it, otherwise the statements releasing a deleted holder's claim (often none).
 */
export async function claimSource(
  db: DB,
  orgId: string,
  r: { kind: string; ref: string },
  exceptTaskId?: string
): Promise<BatchItem<'sqlite'>[]> {
  const holder = await findSourceHolder(db, orgId, r);
  if (!holder || holder.taskId === exceptTaskId) {
    return [];
  }
  if (!holder.isDeleted) {
    throw sourceConflict(r, holder.taskId, holder.title);
  }
  return releaseSource(db, holder, exceptTaskId);
}

/**
 * Throw a 409 if kind:ref is the source of another task in this workspace. Used to explain a
 * write that lost a race on the source index, so a deleted holder counts too.
 */
export async function assertSourceFree(
  db: DB,
  orgId: string,
  r: { kind: string; ref: string },
  exceptTaskId?: string
) {
  const holder = await findSourceHolder(db, orgId, r);
  if (holder && holder.taskId !== exceptTaskId) {
    throw sourceConflict(r, holder.taskId, holder.title);
  }
}

/**
 * Route helper for creates: a source clash that carries the existing task answers
 * 409 { error, taskId, task }; anything else goes on to the API's error handler.
 */
export function conflictWithTask(
  c: { json: (body: unknown, status: 409) => Response },
  err: unknown
): Response {
  if (err instanceof RefConflictError && err.task) {
    return c.json({ error: err.message, taskId: err.taskId, task: err.task }, 409);
  }
  throw err;
}

export function sourceConflict(r: { kind: string; ref: string }, taskId: string, title: string) {
  return new RefConflictError(
    `${canonicalRef(r)} is already the source of ${taskId.slice(0, 8)} "${title}"`,
    taskId
  );
}

/**
 * Before a task or project moves workspace: refuse if any of its source refs is already the
 * source of a live task in the destination. Returns release statements for deleted holders, which
 * the caller batches with the move so a failed move changes nothing.
 */
export async function assertSourcesFreeIn(
  db: DB,
  destOrgId: string,
  moving: { taskId: string } | { projectId: string }
): Promise<BatchItem<'sqlite'>[]> {
  const mine = alias(schema.taskRefs, 'mine');
  const theirs = alias(schema.taskRefs, 'theirs');
  const isMoving = (col: AnyColumn) =>
    'taskId' in moving
      ? eq(col, moving.taskId)
      : sql`${col} in (select id from Tasks where project_id = ${moving.projectId})`;
  const holders = await db
    .select({
      refId: theirs.id,
      kind: theirs.kind,
      ref: theirs.ref,
      taskId: theirs.taskId,
      title: schema.tasks.title,
      isDeleted: schema.tasks.isDeleted,
    })
    .from(mine)
    .innerJoin(
      theirs,
      and(
        eq(theirs.orgId, destOrgId),
        eq(theirs.role, 'source'),
        eq(theirs.kind, mine.kind),
        eq(theirs.ref, mine.ref)
      )
    )
    .innerJoin(schema.tasks, eq(schema.tasks.id, theirs.taskId))
    .where(and(eq(mine.role, 'source'), isMoving(mine.taskId), not(isMoving(theirs.taskId))));
  const clash = holders.find((h) => !h.isDeleted);
  if (clash) {
    throw sourceConflict(clash, clash.taskId, clash.title);
  }
  return holders.flatMap((h) => releaseSource(db, h));
}

/** Statement that keeps refs' workspace in step with their tasks (run in the move's batch). */
export function updateRefOrgs(
  db: DB,
  destOrgId: string,
  moving: { taskId: string } | { projectId: string }
) {
  const where =
    'taskId' in moving
      ? eq(schema.taskRefs.taskId, moving.taskId)
      : sql`${schema.taskRefs.taskId} in (select id from Tasks where project_id = ${moving.projectId})`;
  return db.update(schema.taskRefs).set({ orgId: destOrgId }).where(where);
}

/** True for a unique-index failure, which is how a lost race on the source rule shows up. */
function isUniqueViolation(err: unknown) {
  const text = `${(err as Error)?.message ?? ''} ${(err as { cause?: Error })?.cause?.message ?? ''}`;
  return /UNIQUE constraint failed/i.test(text);
}

/* ---------------------------------------------------------------- activity */

function addedSummary(role: RefRole, canonical: string, title: string) {
  switch (role) {
    case 'source':
      return `Set source of "${title}" to ${canonical}`;
    case 'reported_by':
      return `Added reporter ${canonical} to "${title}"`;
    case 'about':
      return `Added about ${canonical} to "${title}"`;
    default:
      return `Linked "${title}" to ${canonical}`;
  }
}

function removedSummary(role: RefRole, canonical: string, title: string) {
  const what = { source: 'source', reported_by: 'reporter', about: 'about', link: 'link' }[role];
  return `Removed ${what} ${canonical} from "${title}"`;
}

async function logRef(
  db: DB,
  userId: string,
  task: Pick<TaskRow, 'id' | 'projectId' | 'epicId' | 'title'>,
  orgId: string,
  row: { role: RefRole; kind: string; ref: string },
  added: boolean
) {
  const canonical = canonicalRef(row);
  await logActivity(db, {
    actorId: userId,
    orgId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    taskId: task.id,
    epicId: task.epicId,
    action: added ? 'ref_added' : 'ref_removed',
    summary: added
      ? addedSummary(row.role, canonical, task.title)
      : removedSummary(row.role, canonical, task.title),
    changes: { refs: added ? { from: [], to: [canonical] } : { from: [canonical], to: [] } },
  });
}

/* ---------------------------------------------------------------- gmail mirror */

/** Point Tasks.gmail_thread_id at the newest gmail.thread ref, or null when none is left. */
async function refreshGmailColumn(db: DB, taskId: string) {
  const newest = await db
    .select({ ref: schema.taskRefs.ref })
    .from(schema.taskRefs)
    .where(and(eq(schema.taskRefs.taskId, taskId), eq(schema.taskRefs.kind, 'gmail.thread')))
    .orderBy(desc(schema.taskRefs.createdAt), desc(sql`rowid`))
    .get();
  await db
    .update(schema.tasks)
    .set({ gmailThreadId: newest?.ref ?? null })
    .where(eq(schema.tasks.id, taskId));
}

/** A gmailThreadId as the task API receives it, in the form its ref is stored (null to clear). */
export function normaliseGmailThreadId(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? parseOrThrow(text, 'gmail.thread').ref : null;
}

/**
 * The task API's `gmailThreadId` is a view onto refs. Setting it adds a gmail.thread link
 * unless that thread is already on the task in any role, and makes it the column's value;
 * clearing it removes the gmail.thread refs equal to the old value, whatever their role.
 * Saving the value the task already has does nothing, so form saves that carry the field
 * unchanged never touch refs. The caller's field-edit entry covers the link; removing a
 * source, reporter or about ref is logged as well, since a field edit would hide that.
 */
export async function syncGmailThread(
  db: DB,
  userId: string,
  task: Pick<TaskRow, 'id' | 'gmailThreadId' | 'projectId' | 'epicId' | 'title'>,
  orgId: string,
  newThreadId: string | null
): Promise<void> {
  const value = normaliseGmailThreadId(newThreadId);
  const old = task.gmailThreadId?.trim() || null;
  if (value === old) {
    return;
  }
  if (value) {
    const exists = await db
      .select({ id: schema.taskRefs.id })
      .from(schema.taskRefs)
      .where(
        and(
          eq(schema.taskRefs.taskId, task.id),
          eq(schema.taskRefs.kind, 'gmail.thread'),
          eq(schema.taskRefs.ref, value)
        )
      )
      .get();
    if (!exists) {
      const parsed = parseOrThrow(value, 'gmail.thread');
      await db
        .insert(schema.taskRefs)
        .values({
          id: uuidv4(),
          taskId: task.id,
          orgId,
          role: 'link',
          kind: 'gmail.thread',
          ref: parsed.ref,
          url: parsed.url,
          createdBy: userId,
          createdAt: new Date().toISOString(),
        })
        .onConflictDoNothing({
          target: [
            schema.taskRefs.taskId,
            schema.taskRefs.role,
            schema.taskRefs.kind,
            schema.taskRefs.ref,
          ],
        });
    }
    await db.update(schema.tasks).set({ gmailThreadId: value }).where(eq(schema.tasks.id, task.id));
    return;
  }
  if (old) {
    const doomed = await db
      .select()
      .from(schema.taskRefs)
      .where(
        and(
          eq(schema.taskRefs.taskId, task.id),
          eq(schema.taskRefs.kind, 'gmail.thread'),
          eq(schema.taskRefs.ref, old)
        )
      );
    if (doomed.length) {
      await db.delete(schema.taskRefs).where(
        inArray(
          schema.taskRefs.id,
          doomed.map((r) => r.id)
        )
      );
    }
    for (const r of doomed.filter((x) => x.role !== 'link')) {
      await logRef(db, userId, task, orgId, r, false);
    }
  }
  // Another gmail.thread ref, if one is left, becomes the column's value
  await refreshGmailColumn(db, task.id);
}

/* ---------------------------------------------------------------- writing */

export async function addRef(
  db: DB,
  userId: string,
  taskId: string,
  input: RefInput
): Promise<{ ref: RefView; existing: boolean }> {
  const { task, project } = await loadEditableOr404(db, userId, taskId);
  return addResolvedRef(db, userId, task, project.orgId, resolveRefInput(input));
}

/**
 * Add refs that are already validated (say, from a create that found its source tracked) to a
 * task the caller can edit, through the same path as addRef. Returns how many were new.
 */
export async function addResolvedRefs(
  db: DB,
  userId: string,
  taskId: string,
  refs: ResolvedRef[],
  sourceGuard?: SourceHolderGuard
): Promise<number> {
  const loaded = await loadEditableForSourceGuard(db, userId, taskId, sourceGuard);
  let added = 0;
  for (const r of refs) {
    const { existing } = await addResolvedRef(db, userId, loaded.task, loaded.project.orgId, r, sourceGuard);
    added += existing ? 0 : 1;
  }
  return added;
}

async function loadEditableForSourceGuard(
  db: DB,
  userId: string,
  taskId: string,
  sourceGuard?: SourceHolderGuard
) {
  try {
    const loaded = await loadEditableOr404(db, userId, taskId);
    if (
      sourceGuard &&
      (loaded.task.id !== sourceGuard.taskId || loaded.project.orgId !== sourceGuard.orgId)
    ) {
      throw new SourceHolderChangedError();
    }
    return loaded;
  } catch (err) {
    if (
      sourceGuard &&
      err instanceof AccessError &&
      !(await hasCurrentSourceHolder(db, sourceGuard))
    ) {
      throw new SourceHolderChangedError();
    }
    throw err;
  }
}

function insertSourceIfAvailable(
  db: DB,
  row: {
    id: string;
    taskId: string;
    orgId: string;
    kind: string;
    ref: string;
    url: string | null;
    label: string | null;
    createdBy: string;
    createdAt: string;
  }
) {
  return db.all(sql`
    INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, label, created_by, created_at)
    SELECT ${row.id}, ${row.taskId}, ${row.orgId}, 'source', ${row.kind}, ${row.ref},
      ${row.url}, ${row.label}, ${row.createdBy}, ${row.createdAt}
    WHERE EXISTS (
      SELECT 1
      FROM Tasks source_target
      INNER JOIN Projects source_project ON source_project.id = source_target.project_id
      INNER JOIN OrganisationMembers source_member ON source_member.org_id = source_project.org_id
      WHERE source_target.id = ${row.taskId}
        AND source_target.is_deleted = 0
        AND source_project.org_id = ${row.orgId}
        AND source_member.user_id = ${row.createdBy}
        AND source_member.role IN ('owner', 'admin', 'member')
    )
      AND NOT EXISTS (
        SELECT 1 FROM TaskRefs existing_source
        WHERE existing_source.task_id = ${row.taskId} AND existing_source.role = 'source'
      )
    ON CONFLICT(task_id, role, kind, ref) DO NOTHING
    RETURNING id
  `);
}

async function addResolvedRef(
  db: DB,
  userId: string,
  task: TaskRow,
  orgId: string,
  r: ResolvedRef,
  sourceGuard?: SourceHolderGuard
): Promise<{ ref: RefView; existing: boolean }> {
  const findSame = () =>
    db
      .select()
      .from(schema.taskRefs)
      .where(
        and(
          eq(schema.taskRefs.taskId, task.id),
          eq(schema.taskRefs.role, r.role),
          eq(schema.taskRefs.kind, r.kind),
          eq(schema.taskRefs.ref, r.ref)
        )
      )
      .get();

  const same = await findSame();
  if (same) {
    if (sourceGuard && !(await hasCurrentSourceHolder(db, sourceGuard))) {
      throw new SourceHolderChangedError();
    }
    return { ref: await viewOf(db, same), existing: true };
  }

  if (sourceGuard) {
    if (r.role === 'source') {
      throw new RefError(ONE_SOURCE_ERROR, 409);
    }
    const row = {
      id: uuidv4(),
      taskId: task.id,
      orgId,
      role: r.role,
      kind: r.kind,
      ref: r.ref,
      url: r.url,
      label: r.label,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
    const inserted = await db.all(sql`
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, label, created_by, created_at)
      SELECT ${row.id}, ${row.taskId}, ${row.orgId}, ${row.role}, ${row.kind}, ${row.ref},
        ${row.url}, ${row.label}, ${row.createdBy}, ${row.createdAt}
      WHERE ${sourceHolderCondition(sourceGuard, true)}
      ON CONFLICT(task_id, role, kind, ref) DO NOTHING
      RETURNING id
    `);
    if (inserted.length === 0) {
      const raced = await findSame();
      if (raced && (await hasCurrentSourceHolder(db, sourceGuard))) {
        return { ref: await viewOf(db, raced), existing: true };
      }
      if (!(await hasCurrentSourceHolder(db, sourceGuard))) {
        throw new SourceHolderChangedError();
      }
      await loadEditableForSourceGuard(db, userId, task.id, sourceGuard);
      throw new SourceHolderChangedError();
    }
    await logRef(db, userId, task, orgId, r, true);
    return { ref: await viewOf(db, row as RefRow), existing: false };
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const same = await findSame();
    if (same) {
      return { ref: await viewOf(db, same), existing: true };
    }

    let releases: BatchItem<'sqlite'>[] = [];
    if (r.role === 'source') {
      try {
        releases = await claimSource(db, orgId, r, task.id);
      } catch (err) {
        if (err instanceof RefConflictError) {
          err.task = await getTaskView(db, userId, err.taskId);
        }
        throw err;
      }
    }

    const row = {
      id: uuidv4(),
      taskId: task.id,
      orgId,
      role: r.role,
      kind: r.kind,
      ref: r.ref,
      url: r.url,
      label: r.label,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
    let sourceInserted = true;
    try {
      if (r.role === 'source') {
        const sourceInsert = insertSourceIfAvailable(db, row);
        if (releases.length) {
          const statements: BatchItem<'sqlite'>[] = [...releases, sourceInsert];
          const results = await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
          sourceInserted = (results[releases.length] as unknown[][]).length > 0;
        } else {
          sourceInserted = (await sourceInsert).length > 0;
        }
        if (!sourceInserted) {
          const raced = await findSame();
          if (raced) {
            return { ref: await viewOf(db, raced), existing: true };
          }
          const existingSource = await db
            .select({ id: schema.taskRefs.id })
            .from(schema.taskRefs)
            .where(and(eq(schema.taskRefs.taskId, task.id), eq(schema.taskRefs.role, 'source')))
            .get();
          if (existingSource) {
            throw new RefError(ONE_SOURCE_ERROR, 409);
          }
          const current = await loadEditableOr404(db, userId, task.id);
          if (current.project.orgId !== orgId) {
            throw new AccessError(NOT_FOUND, 404);
          }
          if (attempt === maxAttempts) {
            throw new RefError('Source ownership changed while adding the link. Retry the request.', 409);
          }
          continue;
        }
      } else {
        const insert = db.insert(schema.taskRefs).values(row);
        if (releases.length) {
          const statements: BatchItem<'sqlite'>[] = [...releases, insert];
          await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
        } else {
          await insert;
        }
      }
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const raced = await findSame();
      if (raced) {
        return { ref: await viewOf(db, raced), existing: true };
      }
      if (r.role !== 'source') {
        throw err;
      }
      const holder = await findSourceHolder(db, orgId, r);
      if (holder && !holder.isDeleted) {
        const conflict = sourceConflict(r, holder.taskId, holder.title);
        conflict.task = await getTaskView(db, userId, holder.taskId);
        throw conflict;
      }
      if (attempt === maxAttempts) {
        throw new RefError('Source ownership changed while adding the link. Retry the request.', 409);
      }
      continue;
    }

    if (r.kind === 'gmail.thread') {
      await refreshGmailColumn(db, task.id);
    }
    await logRef(db, userId, task, orgId, r, true);
    return { ref: await viewOf(db, row as RefRow), existing: false };
  }
  throw new RefError('Source ownership changed while adding the link. Retry the request.', 409);
}

/**
 * Remove refs from a task: one by id (or an unambiguous id prefix), or every role of a
 * kind:ref / URL unless `role` narrows it.
 */
export async function removeRef(
  db: DB,
  userId: string,
  taskId: string,
  by: { refId: string } | { ref: string; role?: string | null }
): Promise<void> {
  const { task, project } = await loadEditableOr404(db, userId, taskId);
  const onTask = await db.select().from(schema.taskRefs).where(eq(schema.taskRefs.taskId, task.id));

  let doomed: RefRow[];
  if ('refId' in by) {
    const id = by.refId.trim().toLowerCase();
    const exact = onTask.filter((r) => r.id === id);
    doomed = exact.length ? exact : id.length >= 4 ? onTask.filter((r) => r.id.startsWith(id)) : [];
    if (doomed.length > 1) {
      throw new RefError('That id matches more than one link on this task', 400);
    }
  } else {
    const parsed = parseOrThrow(by.ref);
    const role = by.role ? normaliseRole(by.role) : null;
    if (by.role && !role) {
      throw new RefError(ROLE_ERROR, 400);
    }
    doomed = onTask.filter(
      (r) => r.kind === parsed.kind && r.ref === parsed.ref && (!role || r.role === role)
    );
  }
  if (doomed.length === 0) {
    throw new AccessError(NOT_ON_TASK, 404);
  }

  await db.delete(schema.taskRefs).where(
    inArray(
      schema.taskRefs.id,
      doomed.map((r) => r.id)
    )
  );
  if (doomed.some((r) => r.kind === 'gmail.thread')) {
    await refreshGmailColumn(db, task.id);
  }
  for (const r of doomed) {
    await logRef(db, userId, task, project.orgId, r, false);
  }
}

/**
 * Validate refs for a task that is about to be created: parse each, drop repeats, and allow one
 * source at most. Returns rows to insert in the same batch as the task. Whether the source is
 * already tracked is the caller's question (see projectService.createProject).
 */
export async function prepareRefsForCreate(
  _db: DB,
  userId: string,
  taskId: string,
  orgId: string,
  inputs: RefInput[]
) {
  const resolved: ResolvedRef[] = [];
  for (const input of inputs) {
    let r: ResolvedRef;
    try {
      r = resolveRefInput(input);
    } catch (err) {
      // Several links may come at once, so say which one is wrong
      if (err instanceof RefError && inputs.length > 1) {
        throw new RefError(`"${String(input.ref ?? '').trim()}": ${err.message}`, err.status);
      }
      throw err;
    }
    if (!resolved.some((x) => sameRef(x, r))) {
      resolved.push(r);
    }
  }
  if (resolved.filter((x) => x.role === 'source').length > 1) {
    throw new RefError(ONE_SOURCE_ERROR, 400);
  }
  const now = Date.now();
  return resolved.map((r, i) => ({
    id: uuidv4(),
    taskId,
    orgId,
    ...r,
    createdBy: userId,
    // Keeps the given order when sorting by age
    createdAt: new Date(now + i).toISOString(),
  }));
}

/**
 * Insert a task and its refs together: one batch, so a clash leaves nothing behind. `before`
 * runs first in the same batch (releasing a deleted task's source). A lost race on the source
 * rule becomes the same 409 as the up-front check.
 */
export async function insertTaskWithRefs(
  db: DB,
  taskInsert: BatchItem<'sqlite'>,
  refRows: Array<typeof schema.taskRefs.$inferInsert>,
  before: BatchItem<'sqlite'>[] = [],
  after: BatchItem<'sqlite'>[] = []
) {
  if (refRows.length === 0 && before.length === 0 && after.length === 0) {
    await taskInsert;
    return;
  }
  const statements: BatchItem<'sqlite'>[] = [
    ...before,
    taskInsert,
    ...refRows.map((row) => db.insert(schema.taskRefs).values(row)),
    ...after,
  ];
  try {
    await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      for (const row of refRows.filter((r) => r.role === 'source')) {
        await assertSourceFree(db, row.orgId, row);
      }
    }
    throw err;
  }
}

/**
 * Statements to move a source task's refs to a merge target. They are returned rather than
 * executed here so the caller can make the whole task merge one D1 batch.
 */
export async function prepareRefsForMerge(
  db: DB,
  sourceTaskId: string,
  targetTaskId: string
): Promise<BatchItem<'sqlite'>[]> {
  const [fromRows, toRows] = await Promise.all([
    db.select().from(schema.taskRefs).where(eq(schema.taskRefs.taskId, sourceTaskId)),
    db.select().from(schema.taskRefs).where(eq(schema.taskRefs.taskId, targetTaskId)),
  ]);
  if (fromRows.length === 0) {
    return [];
  }
  let hasSource = toRows.some((r) => r.role === 'source');
  const kept = toRows.map((r) => ({ role: r.role, kind: r.kind, ref: r.ref }));
  const statements: BatchItem<'sqlite'>[] = [];
  for (const row of fromRows) {
    const role: RefRole = row.role === 'source' && hasSource ? 'link' : row.role;
    if (row.role === 'source' && !hasSource) {
      hasSource = true;
    }
    const next = { role, kind: row.kind, ref: row.ref };
    if (kept.some((k) => sameRef(k, next))) {
      statements.push(db.delete(schema.taskRefs).where(eq(schema.taskRefs.id, row.id)));
      continue;
    }
    kept.push(next);
    statements.push(
      db
        .update(schema.taskRefs)
        .set({ taskId: targetTaskId, role })
        .where(eq(schema.taskRefs.id, row.id))
    );
  }
  return statements;
}

/**
 * Task ids carrying a ref, within the given workspaces. Used for `?ref=` and search; callers
 * still apply their own visibility and deleted filters.
 */
export async function findTaskIdsByRef(
  db: DB,
  orgIds: string[],
  parsed: Pick<ParsedRef, 'kind' | 'ref'>,
  role?: RefRole
): Promise<string[]> {
  if (orgIds.length === 0) {
    return [];
  }
  const conditions = [
    inArray(schema.taskRefs.orgId, Array.from(new Set(orgIds))),
    eq(schema.taskRefs.kind, parsed.kind),
    eq(schema.taskRefs.ref, parsed.ref),
  ];
  if (role) {
    conditions.push(eq(schema.taskRefs.role, role));
  }
  const rows = await db
    .selectDistinct({ taskId: schema.taskRefs.taskId })
    .from(schema.taskRefs)
    .where(and(...conditions));
  return rows.map((r) => r.taskId);
}

/** SQL condition: the task carries this ref (any role unless given). For list filters. */
export function taskHasRef(parsed: Pick<ParsedRef, 'kind' | 'ref'>, role?: RefRole | null) {
  return role
    ? sql`${schema.tasks.id} in (select task_id from TaskRefs where kind = ${parsed.kind} and ref = ${parsed.ref} and role = ${role})`
    : sql`${schema.tasks.id} in (select task_id from TaskRefs where kind = ${parsed.kind} and ref = ${parsed.ref})`;
}
