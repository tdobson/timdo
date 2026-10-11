/**
 * Activity log: who did what, when, across tasks, epics, notes and sharing.
 * Writes never block the action they describe; a failed log write is only reported.
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import { getAccessibleProjects, getUserNames } from './accessService';

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

  const names = await getUserNames(
    db,
    rows.map((r) => r.actorId)
  );
  const projectNames = new Map(projects.map((p) => [p.id, p.name]));

  return rows.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    actorName: r.actorId ? (names.get(r.actorId) ?? 'Someone') : 'TimDo',
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
    createdAt: r.createdAt,
  }));
}

function safeParse(s: string): FieldChanges | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
