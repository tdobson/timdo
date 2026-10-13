/**
 * Activity log: who did what, when, across tasks, epics, notes and sharing.
 * Writes never block the action they describe; a failed log write is only reported.
 */
import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import { getAccessibleProjects } from './accessService';
import {
  assertCursorBinding,
  assertCursorKey,
  CursorError,
  decodeCursor,
  encodeCursor,
  encodeSequence,
  fingerprint,
  MAX_ACTIVITY_SEQUENCE,
} from './cursorService';
import { EVENT_REGISTRY } from './eventsFeedService';
import { getPeople, type PersonKind } from './personService';
import { getActorContext } from './requestActorContext';

type DB = DrizzleD1Database<typeof schema>;

export type EntityType = 'task' | 'epic' | 'note' | 'project' | 'organisation' | 'member';
export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export interface ActivityInput {
  actorId: string | null;
  orgId?: string | null;
  projectId?: string | null;
  entityType: EntityType;
  entityId: string;
  taskId?: string | null;
  epicId?: string | null;
  action: string;
  summary: string;
  changes?: FieldChanges | null;
}

export interface ActivityEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  actorKind: PersonKind | null;
  orgId: string | null;
  projectId: string | null;
  projectName: string | null;
  entityType: EntityType;
  entityId: string;
  taskId: string | null;
  epicId: string | null;
  action: string;
  summary: string;
  changes: FieldChanges | null;
  via: 'web' | 'token' | 'owner_secret' | 'system' | null;
  viaDetail: string | null;
  createdAt: string | null;
}

export async function logActivity(db: DB, input: ActivityInput) {
  try {
    await db.insert(schema.activityLog).values({
      id: uuidv4(),
      actorId: input.actorId,
      orgId: input.orgId ?? null,
      projectId: input.projectId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      taskId: input.taskId ?? null,
      epicId: input.epicId ?? null,
      action: input.action,
      summary: input.summary,
      changes: input.changes ? JSON.stringify(input.changes) : null,
      via: getActorContext(db)?.via ?? null,
      viaDetail: getActorContext(db)?.viaDetail ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[activity] failed to log', input.action, input.entityId, err);
  }
}

/** Compare the fields that matter and return only the ones that changed. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[]
): FieldChanges {
  const changes: FieldChanges = {};
  for (const f of fields) {
    if (!(f in after)) {
      continue;
    }
    // '' and null both mean "nothing", so switching between them isn't a change
    const a = before[f] === '' ? null : (before[f] ?? null);
    const b = after[f] === '' ? null : (after[f] ?? null);
    if (a !== b) {
      changes[f] = { from: a, to: b };
    }
  }
  return changes;
}

const STATUS_LABELS: Record<string, string> = {
  do: 'Do',
  delay: 'Delay',
  done: 'Done',
  delegate: 'Delegate',
  awaiting: 'Awaiting',
  active: 'Active',
  completed: 'Completed',
  on_hold: 'On hold',
};
export const statusLabel = (s: unknown) => STATUS_LABELS[String(s)] ?? String(s);

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  reason: 'reason',
  notes: 'notes',
  priority: 'priority',
  size: 'size',
  awaitUntil: 'return date',
  gmailThreadId: 'email thread',
  customer: 'customer',
  tags: 'tags',
  epicId: 'epic',
  description: 'description',
  goalId: 'life goal',
};

/** "Updated priority and notes" style summary for field edits that aren't status/assignee/project moves. */
export function describeFieldEdits(changes: FieldChanges): string | null {
  const labels = Object.keys(changes)
    .map((k) => FIELD_LABELS[k])
    .filter(Boolean);
  if (labels.length === 0) {
    return null;
  }
  if (labels.length === 1) {
    return `Updated ${labels[0]}`;
  }
  return `Updated ${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export interface ActivityQuery {
  taskId?: string;
  epicId?: string;
  projectId?: string;
  orgId?: string;
  limit?: number;
}

/**
 * Activity the user is allowed to see: anything in a project or workspace they belong to.
 */
export async function getActivity(
  db: DB,
  userId: string,
  query: ActivityQuery = {}
): Promise<ActivityEntry[]> {
  const projects = await getAccessibleProjects(db, userId);

  // Resolve visibility in SQL so large workspaces do not become oversized bound id lists.
  const clauses: SQL[] = [
    // Personal things with no project or workspace (e.g. an unscoped epic) by this user
    and(
      isNull(schema.activityLog.projectId),
      isNull(schema.activityLog.orgId),
      eq(schema.activityLog.actorId, userId)
    )!,
    sql`exists (
      select 1
      from Projects visible_project
      inner join OrganisationMembers visible_member on visible_member.org_id = visible_project.org_id
      where visible_project.id = ${schema.activityLog.projectId}
        and visible_member.user_id = ${userId}
    )`,
    and(
      isNull(schema.activityLog.projectId),
      sql`exists (
        select 1
        from OrganisationMembers visible_org_member
        where visible_org_member.org_id = ${schema.activityLog.orgId}
          and visible_org_member.user_id = ${userId}
      )`
    )!,
  ];
  const visibility = or(...clauses)!;

  const conditions = [visibility];
  if (query.taskId) {
    conditions.push(eq(schema.activityLog.taskId, query.taskId));
  }
  if (query.epicId) {
    conditions.push(eq(schema.activityLog.epicId, query.epicId));
  }
  if (query.projectId) {
    conditions.push(eq(schema.activityLog.projectId, query.projectId));
  }
  if (query.orgId) {
    conditions.push(eq(schema.activityLog.orgId, query.orgId));
  }

  const rows = await db
    .select()
    .from(schema.activityLog)
    .where(and(...conditions))
    .orderBy(desc(schema.activityLog.createdAt))
    .limit(Math.min(query.limit ?? 100, 500));

  const people = await getPeople(
    db,
    rows.map((r) => r.actorId)
  );
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  return rows.map((r) => {
    const actor = r.actorId ? people.get(r.actorId) : undefined;
    return {
      id: r.id,
      actorId: r.actorId,
      actorName: actor?.name ?? (r.actorId ? 'Someone' : 'TimDo'),
      actorKind: actor?.kind ?? null,
      orgId: r.orgId,
      projectId: r.projectId,
      projectName: r.projectId ? (projectNames.get(r.projectId) ?? null) : null,
      entityType: r.entityType as EntityType,
      entityId: r.entityId,
      taskId: r.taskId,
      epicId: r.epicId,
      action: r.action,
      summary: r.summary,
      changes: r.changes ? safeParse(r.changes) : null,
      via: r.via ?? null,
      viaDetail: r.viaDetail ?? null,
      createdAt: r.createdAt,
    };
  });
}

function safeParse(s: string): FieldChanges | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface PagedActivityQuery extends Omit<ActivityQuery, 'limit'> {}

export interface PagedActivityResult {
  entries: ActivityEntry[];
  nextCursor?: string;
}

const KNOWN_ACTIVITY_PAIRS = Array.from(
  new Map(
    EVENT_REGISTRY.map((entry) => [`${entry.entityType}:${entry.action}`, entry] as const)
  ).values()
);

function knownActivityClause() {
  return or(
    ...KNOWN_ACTIVITY_PAIRS.map((entry) =>
      and(
        eq(schema.activityLog.entityType, entry.entityType),
        eq(schema.activityLog.action, entry.action)
      )
    )
  )!;
}

/** Page the legacy activity view without changing its visibility or response projection. */
export async function getPagedActivity(
  db: DB,
  key: string | undefined,
  userId: string,
  query: PagedActivityQuery,
  limit: number,
  beforeToken?: string
): Promise<PagedActivityResult> {
  assertCursorKey(key);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new CursorError(400, 'invalid_cursor', 'limit must be an integer between 1 and 500');
  }

  const membershipRows = await db
    .select({
      membershipId: schema.organisationMembers.id,
      orgId: schema.organisationMembers.orgId,
      role: schema.organisationMembers.role,
    })
    .from(schema.organisationMembers)
    .where(eq(schema.organisationMembers.userId, userId))
    .orderBy(asc(schema.organisationMembers.orgId), asc(schema.organisationMembers.id));
  const [principalFingerprint, scopeFingerprint, filtersFingerprint, sequenceRow] =
    await Promise.all([
      fingerprint({ userId }),
      fingerprint({
        scope: 'legacy-activity',
        membership: membershipRows.map((row) => ({
          id: row.membershipId,
          orgId: row.orgId,
          role: row.role,
        })),
      }),
      fingerprint({
        taskId: query.taskId ?? null,
        epicId: query.epicId ?? null,
        projectId: query.projectId ?? null,
        orgId: query.orgId ?? null,
      }),
      db
        .select({ lastSeq: schema.activitySequence.lastSeq })
        .from(schema.activitySequence)
        .where(eq(schema.activitySequence.id, 1))
        .get(),
    ]);
  const highWater = sequenceRow?.lastSeq;
  if (!Number.isSafeInteger(highWater) || highWater! < 0 || highWater! > MAX_ACTIVITY_SEQUENCE) {
    throw new CursorError(503, 'cursor_unavailable', 'The activity sequence is unavailable');
  }
  const binding = {
    principal: principalFingerprint,
    scope: scopeFingerprint,
    filters: filtersFingerprint,
  };
  let cursorHighWater = highWater!;
  let before: { t: string | null; i: string } | undefined;
  if (beforeToken !== undefined) {
    const cursor = await decodeCursor(key, 'activity', beforeToken);
    if (cursor.d !== 'activity') {
      throw new CursorError(400, 'invalid_cursor', 'The cursor is invalid or cannot be decrypted');
    }
    assertCursorBinding(cursor, binding);
    const decodedHighWater = Number.parseInt(cursor.h, 16);
    if (!Number.isSafeInteger(decodedHighWater) || decodedHighWater > highWater!) {
      throw new CursorError(
        409,
        'stale_cursor',
        'The activity sequence moved backwards; restart from a fresh page'
      );
    }
    cursorHighWater = decodedHighWater;
    before = cursor.b;
  }

  const projects = await getAccessibleProjects(db, userId);
  const conditions: SQL[] = [
    or(
      and(
        isNull(schema.activityLog.projectId),
        isNull(schema.activityLog.orgId),
        eq(schema.activityLog.actorId, userId)
      )!,
      sql`exists (
        select 1
        from Projects visible_project
        inner join OrganisationMembers visible_member on visible_member.org_id = visible_project.org_id
        where visible_project.id = ${schema.activityLog.projectId}
          and visible_member.user_id = ${userId}
      )`,
      and(
        isNull(schema.activityLog.projectId),
        sql`exists (
          select 1
          from OrganisationMembers visible_org_member
          where visible_org_member.org_id = ${schema.activityLog.orgId}
            and visible_org_member.user_id = ${userId}
        )`
      )!
    )!,
    isNotNull(schema.activityLog.id),
    ne(schema.activityLog.id, ''),
    knownActivityClause(),
    sql`${schema.activityLog.seq} <= ${cursorHighWater}`,
  ];
  if (query.taskId) {
    conditions.push(eq(schema.activityLog.taskId, query.taskId));
  }
  if (query.epicId) {
    conditions.push(eq(schema.activityLog.epicId, query.epicId));
  }
  if (query.projectId) {
    conditions.push(eq(schema.activityLog.projectId, query.projectId));
  }
  if (query.orgId) {
    conditions.push(eq(schema.activityLog.orgId, query.orgId));
  }
  if (before) {
    if (before.t === null) {
      conditions.push(
        and(isNull(schema.activityLog.createdAt), lt(schema.activityLog.id, before.i))!
      );
    } else {
      conditions.push(
        or(
          isNull(schema.activityLog.createdAt),
          lt(schema.activityLog.createdAt, before.t),
          and(eq(schema.activityLog.createdAt, before.t), lt(schema.activityLog.id, before.i))
        )!
      );
    }
  }

  const rows = await db
    .select()
    .from(schema.activityLog)
    .where(and(...conditions))
    .orderBy(
      sql`${schema.activityLog.createdAt} IS NULL ASC`,
      desc(schema.activityLog.createdAt),
      desc(schema.activityLog.id)
    )
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const people = await getPeople(
    db,
    pageRows.map((row) => row.actorId)
  );
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const entries = pageRows.map((row) => {
    const actor = row.actorId ? people.get(row.actorId) : undefined;
    return {
      id: row.id,
      actorId: row.actorId,
      actorName: actor?.name ?? (row.actorId ? 'Someone' : 'TimDo'),
      actorKind: actor?.kind ?? null,
      orgId: row.orgId,
      projectId: row.projectId,
      projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
      entityType: row.entityType as EntityType,
      entityId: row.entityId,
      taskId: row.taskId,
      epicId: row.epicId,
      action: row.action,
      summary: row.summary,
      changes: row.changes ? safeParse(row.changes) : null,
      via: row.via ?? null,
      viaDetail: row.viaDetail ?? null,
      createdAt: row.createdAt,
    };
  });
  const refreshedMemberships = await db
    .select({
      membershipId: schema.organisationMembers.id,
      orgId: schema.organisationMembers.orgId,
      role: schema.organisationMembers.role,
    })
    .from(schema.organisationMembers)
    .where(eq(schema.organisationMembers.userId, userId))
    .orderBy(asc(schema.organisationMembers.orgId), asc(schema.organisationMembers.id));
  const refreshedScopeFingerprint = await fingerprint({
    scope: 'legacy-activity',
    membership: refreshedMemberships.map((row) => ({
      id: row.membershipId,
      orgId: row.orgId,
      role: row.role,
    })),
  });
  if (refreshedScopeFingerprint !== scopeFingerprint) {
    throw new CursorError(
      409,
      'stale_cursor',
      'Workspace membership changed; restart from a fresh page'
    );
  }
  if (!hasMore) {
    return { entries };
  }
  const last = pageRows[pageRows.length - 1];
  const nextCursor = await encodeCursor(key, {
    v: 1,
    d: 'activity',
    p: binding.principal,
    s: binding.scope,
    f: binding.filters,
    h: encodeSequence(cursorHighWater),
    b: { t: last.createdAt, i: last.id },
  });
  return { entries, nextCursor };
}
