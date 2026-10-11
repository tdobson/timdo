import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { taskHasRef } from './refService';
import type { ParsedRef, RefRole } from '../lib/refs';

export const TASK_STATUSES = ['do', 'delay', 'awaiting', 'delegate', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskListFields = 'summary' | 'full';
export type TaskListSort = 'default' | 'completed';

type DB = DrizzleD1Database<typeof schema>;
type TaskRow = typeof schema.tasks.$inferSelect;

export class TaskListQueryError extends Error {}

/** Semantic filters shared by the project-shaped list, raw task list and aggregate reads. */
export interface TaskListFilters {
  category?: string;
  orgId?: string;
  projectId?: string;
  status?: string | string[];
  epicId?: string;
  goalId?: string;
  customer?: string;
  tag?: string;
  relatedTo?: string;
  /** `/projects` semantics: `me` includes unassigned tasks reported by the caller. */
  assignee?: string;
  /** `/tasks` raw-list semantics: mine means assigned to the caller only. */
  assigneeId?: string | null;
  mineOnly?: boolean;
  unassignedOnly?: boolean;
  ref?: Pick<ParsedRef, 'kind' | 'ref'>;
  refRole?: RefRole;
  shared?: boolean;
  noEpic?: boolean;
  noGoal?: boolean;
  noCategory?: boolean;
  unlinked?: 'any' | 'epic' | 'goal' | 'category';
  doneSince?: string;
  doneBefore?: string;
  sort?: TaskListSort;
}

export interface ParsedTaskListQuery {
  filters: TaskListFilters;
  fields: TaskListFields;
  limit?: number;
  cursor?: string;
}

export type TaskListRecord = Omit<TaskRow, 'notes'> & Partial<Pick<TaskRow, 'notes'>>;
type CursorTaskRecord = TaskListRecord & {
  _updatedSort: number;
  _completedSort: number;
};

export interface TaskListResult<T = TaskListRecord> {
  items: T[];
  total?: number;
  nextCursor?: string;
}

export interface TaskCounts {
  byStatus: Record<TaskStatus, number>;
  total: number;
}

export interface TaskAggregateCounts extends TaskCounts {
  byAssignee: Array<{ assigneeId: string | null; count: number }>;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INVALID_CURSOR = 'That page link has expired, start again without a cursor';
const MAX_CURSOR_LENGTH = 4096;
const UPDATED_SORT = sql<number>`coalesce(julianday(${schema.tasks.updatedAt}), julianday(${schema.tasks.createdAt}), -1e100)`;
const COMPLETED_SORT = sql<number>`coalesce(julianday(${schema.tasks.statusLastChangedOn}), julianday(${schema.tasks.createdAt}), -1e100)`;

function asBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new TaskListQueryError(`${name} must be true or false`);
}

function validateDate(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = DATE_RE.exec(value);
  if (!match) {
    throw new TaskListQueryError(`${name} must be a real date in YYYY-MM-DD format`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) {
    throw new TaskListQueryError(`${name} must be a real date in YYYY-MM-DD format`);
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new TaskListQueryError(`${name} must be a real date in YYYY-MM-DD format`);
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new TaskListQueryError('limit must be a whole number from 1 to 200');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new TaskListQueryError('limit must be a whole number from 1 to 200');
  }
  return limit;
}

function parseStatuses(value: string | string[] | undefined): TaskStatus[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = Array.isArray(value) ? value : value.split(',');
  const statuses = values.map((status) => status.trim());
  if (statuses.length === 0 || statuses.some((status) => !status)) {
    throw new TaskListQueryError(`status must be one or more of: ${TASK_STATUSES.join(', ')}`);
  }
  const invalid = statuses.filter((status) => !TASK_STATUSES.includes(status as TaskStatus));
  if (invalid.length) {
    throw new TaskListQueryError(`status must be one or more of: ${TASK_STATUSES.join(', ')}`);
  }
  return Array.from(new Set(statuses as TaskStatus[])).sort();
}

/** Parse the query vocabulary used by `/projects` list and count routes. */
export function parseProjectListQuery(
  query: Record<string, string | undefined>,
  { countOnly = false }: { countOnly?: boolean } = {}
): ParsedTaskListQuery {
  const status = parseStatuses(query.status);
  const fields = countOnly ? 'full' : query.fields ?? 'full';
  if (fields !== 'summary' && fields !== 'full') {
    throw new TaskListQueryError('fields must be summary or full');
  }
  const sortValue = query.sort ?? 'default';
  if (sortValue !== 'default' && sortValue !== 'completed') {
    throw new TaskListQueryError('sort must be default or completed');
  }
  let statuses = status;
  if (sortValue === 'completed') {
    if (statuses && statuses.some((entry) => entry !== 'done')) {
      throw new TaskListQueryError('sort=completed only supports status=done');
    }
    statuses = ['done'];
  }
  const doneSince = validateDate(query.doneSince, 'doneSince');
  const doneBefore = validateDate(query.doneBefore, 'doneBefore');
  if (doneSince && doneBefore && doneSince > doneBefore) {
    throw new TaskListQueryError('doneSince must be earlier than or equal to doneBefore');
  }
  const limit = countOnly ? undefined : parseLimit(query.limit);
  const cursor = countOnly || !Object.hasOwn(query, 'cursor')
    ? undefined
    : query.cursor ?? '';
  if (!countOnly && cursor !== undefined && !limit) {
    throw new TaskListQueryError('cursor requires limit');
  }
  if (!countOnly && cursor !== undefined && (!cursor || cursor.length > MAX_CURSOR_LENGTH)) {
    throw new TaskListQueryError(INVALID_CURSOR);
  }
  const unlinked = query.unlinked;
  if (unlinked !== undefined && !['any', 'epic', 'goal', 'category'].includes(unlinked)) {
    throw new TaskListQueryError('unlinked must be any, epic, goal or category');
  }
  return {
    filters: {
      category: query.category,
      orgId: query.orgId,
      projectId: query.projectId,
      status: statuses,
      epicId: query.epicId,
      goalId: query.goalId,
      customer: query.customer,
      tag: query.tag,
      relatedTo: query.relatedTo,
      assignee: query.assignee || undefined,
      refRole: (query.role || query.refRole) as RefRole | undefined,
      shared: asBoolean(query.shared, 'shared'),
      noEpic: asBoolean(query.noEpic, 'noEpic'),
      noGoal: asBoolean(query.noGoal, 'noGoal'),
      noCategory: asBoolean(query.noCategory, 'noCategory'),
      unlinked: unlinked as TaskListFilters['unlinked'],
      doneSince,
      doneBefore,
      sort: sortValue,
    },
    fields,
    limit,
    cursor,
  };
}

/** Parse and validate a real calendar date, then return its explicit UTC midnight boundary. */
export function utcDateBoundary(date: string): string {
  validateDate(date, 'date');
  return `${date}T00:00:00.000Z`;
}

/** A SQL predicate that checks membership without binding every accessible project id. */
export function taskIsVisibleTo(userId: string): SQL {
  return sql`exists (
    select 1
    from Projects visible_project
    inner join OrganisationMembers visible_member on visible_member.org_id = visible_project.org_id
    where visible_project.id = ${schema.tasks.projectId}
      and visible_member.user_id = ${userId}
  )`;
}

/** Resolve a full task id or prefix through membership SQL, not a list of project ids. */
export async function resolveVisibleTaskId(
  db: DB,
  userId: string,
  identifier: string
): Promise<string | null> {
  if (!identifier) {
    return null;
  }
  const row = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .innerJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, schema.projects.orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .where(
      and(
        eq(schema.tasks.isDeleted, false),
        sql`lower(${schema.tasks.id}) like lower(${`${identifier}%`})`
      )
    )
    .orderBy(sql`${schema.tasks.id} = ${identifier} desc`, asc(schema.tasks.id))
    .limit(1)
    .get();
  return row?.id ?? null;
}

interface BuiltFilters {
  conditions: SQL[];
  fingerprint: Record<string, unknown>;
}

async function buildTaskFilters(
  db: DB,
  userId: string,
  filters: TaskListFilters,
  scope: 'projects' | 'tasks'
): Promise<BuiltFilters> {
  const conditions: SQL[] = [eq(schema.tasks.isDeleted, false)];
  if (
    filters.unlinked !== undefined &&
    !['any', 'epic', 'goal', 'category'].includes(filters.unlinked)
  ) {
    throw new TaskListQueryError('unlinked must be any, epic, goal or category');
  }
  let statuses = parseStatuses(filters.status);
  if (filters.sort === 'completed') {
    if (statuses && statuses.some((status) => status !== 'done')) {
      throw new TaskListQueryError('sort=completed only supports status=done');
    }
    statuses = ['done'];
  }
  if (statuses?.length) {
    conditions.push(inArray(schema.tasks.status, statuses));
  }
  if (filters.orgId) {
    conditions.push(eq(schema.projects.orgId, filters.orgId));
  }
  if (filters.projectId) {
    conditions.push(eq(schema.tasks.projectId, filters.projectId));
  }
  if (filters.category) {
    // Preserve JS Unicode lowercasing while keeping task membership filtering in SQL.
    const category = filters.category.trim().toLowerCase();
    const projectNames = await db
      .selectDistinct({ name: schema.projects.name })
      .from(schema.projects)
      .innerJoin(
        schema.organisationMembers,
        and(
          eq(schema.organisationMembers.orgId, schema.projects.orgId),
          eq(schema.organisationMembers.userId, userId)
        )
      );
    const matchingNames = projectNames
      .map((project) => project.name)
      .filter((name) => name.toLowerCase() === category);
    conditions.push(
      matchingNames.length
        ? sql`${schema.projects.name} in (select value from json_each(${JSON.stringify(matchingNames)}))`
        : sql`0 = 1`
    );
  }
  if (filters.epicId) {
    conditions.push(eq(schema.tasks.epicId, filters.epicId));
  }
  if (filters.goalId) {
    conditions.push(sql`exists (
      select 1 from TaskUserGoals filter_goal
      where filter_goal.task_id = ${schema.tasks.id}
        and filter_goal.user_id = ${userId}
        and filter_goal.goal_id = ${filters.goalId}
    )`);
  }
  if (filters.customer) {
    conditions.push(sql`lower(${schema.tasks.customer}) = lower(${filters.customer.trim()})`);
  }
  if (filters.tag) {
    const cleanTag = filters.tag.trim().toLowerCase();
    conditions.push(sql`lower(coalesce(${schema.tasks.tags}, '')) like ${`%${cleanTag}%`}`);
  }

  let relatedTaskId: string | null | undefined;
  if (filters.relatedTo) {
    relatedTaskId = await resolveVisibleTaskId(db, userId, filters.relatedTo);
    if (!relatedTaskId) {
      conditions.push(sql`0 = 1`);
    } else {
      conditions.push(sql`${schema.tasks.id} in (
        select target_task_id from TaskRelations where source_task_id = ${relatedTaskId}
        union
        select source_task_id from TaskRelations where target_task_id = ${relatedTaskId}
      )`);
    }
  }

  if (filters.assignee !== undefined) {
    const assignee = filters.assignee;
    if (assignee === 'me') {
      conditions.push(
        sql`(${schema.tasks.assigneeId} = ${userId} or (${schema.tasks.assigneeId} is null and ${schema.tasks.reporterId} = ${userId}))`
      );
    } else if (assignee === 'unassigned') {
      conditions.push(isNull(schema.tasks.assigneeId));
    } else if (assignee === 'mine_or_unassigned') {
      conditions.push(or(eq(schema.tasks.assigneeId, userId), isNull(schema.tasks.assigneeId))!);
    } else {
      conditions.push(eq(schema.tasks.assigneeId, assignee));
    }
  } else if (filters.mineOnly) {
    conditions.push(eq(schema.tasks.assigneeId, userId));
  } else if (filters.unassignedOnly) {
    conditions.push(isNull(schema.tasks.assigneeId));
  } else if (filters.assigneeId !== undefined) {
    if (filters.assigneeId === null || filters.assigneeId === '') {
      conditions.push(isNull(schema.tasks.assigneeId));
    } else {
      conditions.push(eq(schema.tasks.assigneeId, filters.assigneeId));
    }
  }

  if (filters.ref) {
    conditions.push(taskHasRef(filters.ref, filters.refRole));
  }
  if (filters.shared !== undefined) {
    const comparison = sql`(select count(*) from OrganisationMembers shared_member where shared_member.org_id = ${schema.projects.orgId}) > 1`;
    conditions.push(filters.shared ? comparison : sql`(select count(*) from OrganisationMembers shared_member where shared_member.org_id = ${schema.projects.orgId}) <= 1`);
  }

  const missingEpic = sql`${schema.tasks.epicId} is null`;
  const missingGoal = sql`not exists (
    select 1 from TaskUserGoals missing_goal
    where missing_goal.task_id = ${schema.tasks.id} and missing_goal.user_id = ${userId}
  )`;
  const missingCategory = sql`trim(coalesce(${schema.projects.name}, '')) = ''`;
  if (filters.noEpic) {
    conditions.push(missingEpic);
  }
  if (filters.noGoal) {
    conditions.push(missingGoal);
  }
  if (filters.noCategory) {
    conditions.push(missingCategory);
  }
  if (filters.unlinked === 'any') {
    conditions.push(or(missingEpic, missingGoal, missingCategory)!);
  } else if (filters.unlinked === 'epic') {
    conditions.push(missingEpic);
  } else if (filters.unlinked === 'goal') {
    conditions.push(missingGoal);
  } else if (filters.unlinked === 'category') {
    conditions.push(missingCategory);
  }

  if (filters.doneSince) {
    conditions.push(
      or(
        sql`${schema.tasks.status} != 'done'`,
        sql`${COMPLETED_SORT} >= julianday(${utcDateBoundary(filters.doneSince)})`
      )!
    );
  }
  if (filters.doneBefore) {
    conditions.push(
      or(
        sql`${schema.tasks.status} != 'done'`,
        sql`${COMPLETED_SORT} < julianday(${utcDateBoundary(filters.doneBefore)})`
      )!
    );
  }

  const normalised = normalisedFingerprintFilters(filters, statuses, relatedTaskId, scope, userId);
  return { conditions, fingerprint: normalised };
}

function sqliteLower(value: string): string {
  // SQLite's built-in lower() folds ASCII only, matching the customer SQL predicate.
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function normalisedFingerprintFilters(
  filters: TaskListFilters,
  statuses: TaskStatus[] | undefined,
  relatedTaskId: string | null | undefined,
  scope: 'projects' | 'tasks',
  userId: string
): Record<string, unknown> {
  const ref = filters.ref ? { kind: filters.ref.kind, ref: filters.ref.ref, role: filters.refRole ?? null } : null;
  return {
    scope,
    userId,
    category: filters.category ? filters.category.trim().toLowerCase() : null,
    orgId: filters.orgId ?? null,
    projectId: filters.projectId ?? null,
    status: statuses ?? null,
    epicId: filters.epicId ?? null,
    goalId: filters.goalId ?? null,
    customer: filters.customer ? sqliteLower(filters.customer.trim()) : null,
    tag: filters.tag?.trim().toLowerCase() ?? null,
    relatedTo: filters.relatedTo ? relatedTaskId ?? { unresolved: true } : null,
    assignee: filters.assignee ?? null,
    assigneeId: filters.assigneeId ?? null,
    mineOnly: !!filters.mineOnly,
    unassignedOnly: !!filters.unassignedOnly,
    ref,
    shared: filters.shared ?? null,
    noEpic: !!filters.noEpic,
    noGoal: !!filters.noGoal,
    noCategory: !!filters.noCategory,
    unlinked: filters.unlinked ?? null,
    doneSince: filters.doneSince ?? null,
    doneBefore: filters.doneBefore ?? null,
    sort: filters.sort ?? 'default',
  };
}

interface CursorDefaultKey {
  status: TaskStatus;
  priority: number;
  updated: number;
  id: string;
}
interface CursorCompletedKey {
  completed: number;
  priority: number;
  updated: number;
  id: string;
}
interface TaskCursor {
  v: 1;
  sort: TaskListSort;
  filter: string;
  key: CursorDefaultKey | CursorCompletedKey;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_CURSOR_LENGTH) {
    throw new Error('bad cursor');
  }
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function fingerprint(value: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validKey(sort: TaskListSort, key: unknown): key is CursorDefaultKey | CursorCompletedKey {
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    return false;
  }
  const value = key as Record<string, unknown>;
  if (
    !Number.isInteger(value.priority) ||
    Number(value.priority) < 1 ||
    Number(value.priority) > 10 ||
    !Number.isFinite(value.updated) ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    return false;
  }
  if (sort === 'default') {
    return (
      typeof value.status === 'string' &&
      TASK_STATUSES.includes(value.status as TaskStatus) &&
      Number.isFinite(value.updated)
    );
  }
  return Number.isFinite(value.completed);
}

function readCursor(value: string, sort: TaskListSort, filter: string): TaskCursor {
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as Partial<TaskCursor>;
    if (
      parsed.v !== 1 ||
      parsed.sort !== sort ||
      parsed.filter !== filter ||
      !validKey(sort, parsed.key)
    ) {
      throw new Error('bad cursor');
    }
    return parsed as TaskCursor;
  } catch {
    throw new TaskListQueryError(INVALID_CURSOR);
  }
}

function cursorForRow(row: CursorTaskRecord, sort: TaskListSort, filter: string): string {
  const key: CursorDefaultKey | CursorCompletedKey =
    sort === 'completed'
      ? {
          completed: Number(row._completedSort),
          priority: row.priority,
          updated: Number(row._updatedSort),
          id: row.id,
        }
      : {
          status: row.status,
          priority: row.priority,
          updated: Number(row._updatedSort),
          id: row.id,
        };
  const cursor = base64UrlEncode(JSON.stringify({ v: 1, sort, filter, key } satisfies TaskCursor));
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new TaskListQueryError('The next page cursor would exceed the 4096-character limit');
  }
  return cursor;
}

function keysetCondition(sort: TaskListSort, key: CursorDefaultKey | CursorCompletedKey): SQL {
  if (sort === 'completed') {
    const value = key as CursorCompletedKey;
    return or(
      lt(COMPLETED_SORT, value.completed),
      and(eq(COMPLETED_SORT, value.completed), lt(schema.tasks.priority, value.priority)),
      and(
        eq(COMPLETED_SORT, value.completed),
        eq(schema.tasks.priority, value.priority),
        lt(UPDATED_SORT, value.updated)
      ),
      and(
        eq(COMPLETED_SORT, value.completed),
        eq(schema.tasks.priority, value.priority),
        eq(UPDATED_SORT, value.updated),
        gt(schema.tasks.id, value.id)
      )
    )!;
  }
  const value = key as CursorDefaultKey;
  return or(
    gt(schema.tasks.status, value.status),
    and(eq(schema.tasks.status, value.status), lt(schema.tasks.priority, value.priority)),
    and(
      eq(schema.tasks.status, value.status),
      eq(schema.tasks.priority, value.priority),
      lt(UPDATED_SORT, value.updated)
    ),
    and(
      eq(schema.tasks.status, value.status),
      eq(schema.tasks.priority, value.priority),
      eq(UPDATED_SORT, value.updated),
      gt(schema.tasks.id, value.id)
    )
  )!;
}

function taskSelection(fields: TaskListFields) {
  const projection: Record<string, unknown> = {
    id: schema.tasks.id,
    projectId: schema.tasks.projectId,
    epicId: schema.tasks.epicId,
    reporterId: schema.tasks.reporterId,
    assigneeId: schema.tasks.assigneeId,
    title: schema.tasks.title,
    reason: schema.tasks.reason,
    status: schema.tasks.status,
    priority: schema.tasks.priority,
    size: schema.tasks.size,
    statusLastChangedOn: schema.tasks.statusLastChangedOn,
    awaitUntil: schema.tasks.awaitUntil,
    gmailThreadId: schema.tasks.gmailThreadId,
    customer: schema.tasks.customer,
    tags: schema.tasks.tags,
    isDeleted: schema.tasks.isDeleted,
    updatedBy: schema.tasks.updatedBy,
    createdAt: schema.tasks.createdAt,
    updatedAt: schema.tasks.updatedAt,
    _updatedSort: UPDATED_SORT,
    _completedSort: COMPLETED_SORT,
  };
  if (fields === 'full') {
    projection.notes = schema.tasks.notes;
  }
  return projection as any;
}

function withoutCursorColumns(row: CursorTaskRecord): TaskListRecord {
  const { _updatedSort: _updated, _completedSort: _completed, ...task } = row;
  return task;
}

async function runTaskSelection(
  db: DB,
  userId: string,
  conditions: SQL[],
  fields: TaskListFields,
  limit?: number,
  cursor?: TaskCursor,
  sort: TaskListSort = 'default'
): Promise<CursorTaskRecord[]> {
  let query: any = db
    .select(taskSelection(fields))
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .innerJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, schema.projects.orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .where(and(...conditions, ...(cursor ? [keysetCondition(sort, cursor.key)] : [])));
  query = query.orderBy(
    ...(sort === 'completed'
      ? [desc(COMPLETED_SORT), desc(schema.tasks.priority), desc(UPDATED_SORT), asc(schema.tasks.id)]
      : [
          asc(schema.tasks.status),
          desc(schema.tasks.priority),
          desc(UPDATED_SORT),
          asc(schema.tasks.id),
        ])
  );
  if (limit !== undefined) {
    query = query.limit(limit);
  }
  return (await query) as CursorTaskRecord[];
}

async function countsWithConditions(db: DB, userId: string, conditions: SQL[]): Promise<TaskCounts> {
  const rows = await db
    .select({ status: schema.tasks.status, count: sql<number>`count(*)` })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .innerJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, schema.projects.orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .where(and(...conditions))
    .groupBy(schema.tasks.status);
  const byStatus: Record<TaskStatus, number> = {
    do: 0,
    delay: 0,
    awaiting: 0,
    delegate: 0,
    done: 0,
  };
  for (const row of rows) {
    byStatus[row.status as TaskStatus] = Number(row.count || 0);
  }
  return { byStatus, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0) };
}

/**
 * Return full Tasks rows for the legacy `/tasks` list. Its no-filter and `mine=true` semantics
 * stay raw and unlimited, while access is checked by an SQL membership join.
 */
export async function getRawTasksForUser(
  db: DB,
  userId: string,
  filters: TaskListFilters = {}
): Promise<TaskRow[]> {
  const { conditions } = await buildTaskFilters(db, userId, filters, 'tasks');
  return db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      epicId: schema.tasks.epicId,
      reporterId: schema.tasks.reporterId,
      assigneeId: schema.tasks.assigneeId,
      title: schema.tasks.title,
      reason: schema.tasks.reason,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      size: schema.tasks.size,
      notes: schema.tasks.notes,
      statusLastChangedOn: schema.tasks.statusLastChangedOn,
      awaitUntil: schema.tasks.awaitUntil,
      gmailThreadId: schema.tasks.gmailThreadId,
      customer: schema.tasks.customer,
      tags: schema.tasks.tags,
      isDeleted: schema.tasks.isDeleted,
      updatedBy: schema.tasks.updatedBy,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .innerJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, schema.projects.orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .where(and(...conditions)) as Promise<TaskRow[]>;
}

/**
 * Select all matching task rows or one keyset page. Counts are computed before the cursor and
 * limit. `fields=summary` never selects Tasks.notes.
 */
export async function getTaskListForUser(
  db: DB,
  userId: string,
  filters: TaskListFilters = {},
  options: { fields?: TaskListFields; limit?: number; cursor?: string; scope?: 'projects' | 'tasks' } = {}
): Promise<TaskListResult> {
  const fields = options.fields ?? 'full';
  if (fields !== 'summary' && fields !== 'full') {
    throw new TaskListQueryError('fields must be summary or full');
  }
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)
  ) {
    throw new TaskListQueryError('limit must be a whole number from 1 to 200');
  }
  if (options.cursor !== undefined && options.limit === undefined) {
    throw new TaskListQueryError('cursor requires limit');
  }
  if (options.cursor !== undefined && (!options.cursor || options.cursor.length > MAX_CURSOR_LENGTH)) {
    throw new TaskListQueryError(INVALID_CURSOR);
  }
  const sort = filters.sort ?? 'default';
  const scope = options.scope ?? 'projects';
  const { conditions, fingerprint: filterFingerprint } = await buildTaskFilters(
    db,
    userId,
    filters,
    scope
  );
  const filterHash = await fingerprint(filterFingerprint);
  const cursor = options.cursor ? readCursor(options.cursor, sort, filterHash) : undefined;
  const listLimit = options.limit === undefined ? undefined : options.limit + 1;
  const selected = await runTaskSelection(
    db,
    userId,
    conditions,
    fields,
    listLimit,
    cursor,
    sort
  );
  if (options.limit === undefined) {
    return { items: selected.map(withoutCursorColumns) };
  }
  const counts = await countsWithConditions(db, userId, conditions);
  const hasMore = selected.length > options.limit;
  const selectedPage = selected.slice(0, options.limit);
  const items = selectedPage.map(withoutCursorColumns);
  return {
    items,
    total: counts.total,
    ...(hasMore && selectedPage.length
      ? { nextCursor: cursorForRow(selectedPage[selectedPage.length - 1], sort, filterHash) }
      : {}),
  };
}

/** Counts before any cursor, limit or projection. Every status is present, including zeroes. */
export async function getTaskCountsForUser(
  db: DB,
  userId: string,
  filters: TaskListFilters = {},
  scope: 'projects' | 'tasks' = 'projects'
): Promise<TaskCounts> {
  const { conditions } = await buildTaskFilters(db, userId, filters, scope);
  return countsWithConditions(db, userId, conditions);
}

/** SQL aggregates for later bounded voice selection, not counts of a sampled task list. */
export async function getTaskAggregateCountsForUser(
  db: DB,
  userId: string,
  filters: TaskListFilters = {}
): Promise<TaskAggregateCounts> {
  const { conditions } = await buildTaskFilters(db, userId, filters, 'projects');
  const [statusCounts, assigneeRows] = await Promise.all([
    countsWithConditions(db, userId, conditions),
    db
      .select({ assigneeId: schema.tasks.assigneeId, count: sql<number>`count(*)` })
      .from(schema.tasks)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
      .innerJoin(
        schema.organisationMembers,
        and(
          eq(schema.organisationMembers.orgId, schema.projects.orgId),
          eq(schema.organisationMembers.userId, userId)
        )
      )
      .where(and(...conditions))
      .groupBy(schema.tasks.assigneeId),
  ]);
  return {
    ...statusCounts,
    byAssignee: assigneeRows.map((row) => ({
      assigneeId: row.assigneeId,
      count: Number(row.count || 0),
    })),
  };
}

/**
 * Fetch selected, visible task ids in first-seen caller order, using bounded chunks. The helper
 * is capped at 150 ids for voice and returns lightweight projections unless bodies are requested.
 */
export async function getSelectedTaskRows(
  db: DB,
  userId: string,
  taskIds: string[],
  options: { fields?: TaskListFields } = {}
): Promise<TaskListRecord[]> {
  const ids = Array.from(new Set(taskIds));
  if (ids.length > 150) {
    throw new TaskListQueryError('Selected task reads are limited to 150 ids');
  }
  if (ids.length === 0) {
    return [];
  }
  const fields = options.fields ?? 'summary';
  const results = new Map<string, TaskListRecord>();
  for (let index = 0; index < ids.length; index += 80) {
    const chunk = ids.slice(index, index + 80);
    const conditions = [eq(schema.tasks.isDeleted, false), inArray(schema.tasks.id, chunk)];
    const rows = await runTaskSelection(db, userId, conditions, fields);
    for (const row of rows) {
      results.set(row.id, withoutCursorColumns(row));
    }
  }
  return ids.flatMap((id) => {
    const row = results.get(id);
    return row ? [row] : [];
  });
}

/** Grouped note count and latest valid UTC timestamp for returned task ids only. */
export async function getTaskNoteMetadata(
  db: DB,
  taskIds: string[]
): Promise<Map<string, { noteCount: number; lastNoteAt: string | null }>> {
  const metadata = new Map<string, { noteCount: number; lastNoteAt: string | null }>();
  for (let index = 0; index < taskIds.length; index += 90) {
    const chunk = taskIds.slice(index, index + 90);
    if (chunk.length === 0) {
      continue;
    }
    const rows = await db
      .select({
        taskId: schema.taskUpdates.taskId,
        noteCount: sql<number>`count(*)`,
        lastNoteAt: sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(${schema.taskUpdates.createdAt})))`,
      })
      .from(schema.taskUpdates)
      .where(inArray(schema.taskUpdates.taskId, chunk))
      .groupBy(schema.taskUpdates.taskId);
    for (const row of rows) {
      metadata.set(row.taskId, {
        noteCount: Number(row.noteCount || 0),
        lastNoteAt: row.lastNoteAt ?? null,
      });
    }
  }
  return metadata;
}
