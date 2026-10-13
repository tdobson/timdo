import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { canonicalRef } from '../lib/refs';
import {
  assertCursorBinding,
  CursorError,
  decodeCursor,
  decodeSequence,
  encodeCursor,
  encodeSequence,
  fingerprint,
  MAX_ACTIVITY_SEQUENCE,
} from './cursorService';

export type EventVia = 'web' | 'token' | 'owner_secret' | 'system' | null;
export type EventActorKind = 'human' | 'bot' | 'system' | null;

type DB = DrizzleD1Database<typeof schema>;
type EntityType = 'task' | 'epic' | 'note' | 'project' | 'organisation' | 'member';

interface RegistryEntry {
  entityType: EntityType;
  action: string;
  type: string;
  projectMove?: 'source' | 'destination';
}

export const EVENT_REGISTRY = [
  { entityType: 'task', action: 'created', type: 'task.created' },
  { entityType: 'task', action: 'updated', type: 'task.updated' },
  { entityType: 'task', action: 'status_changed', type: 'task.status_changed' },
  { entityType: 'task', action: 'completed', type: 'task.completed' },
  { entityType: 'task', action: 'assigned', type: 'task.assigned' },
  { entityType: 'task', action: 'moved', type: 'task.moved' },
  { entityType: 'task', action: 'deleted', type: 'task.deleted' },
  { entityType: 'task', action: 'restored', type: 'task.restored' },
  { entityType: 'task', action: 'merged', type: 'task.merged' },
  { entityType: 'task', action: 'linked', type: 'task.linked' },
  { entityType: 'task', action: 'moved_out', type: 'task.moved_out' },
  { entityType: 'task', action: 'ref_added', type: 'ref.added' },
  { entityType: 'task', action: 'ref_removed', type: 'ref.removed' },
  { entityType: 'note', action: 'note_added', type: 'note.added' },
  { entityType: 'note', action: 'note_deleted', type: 'note.deleted' },
  { entityType: 'epic', action: 'created', type: 'epic.created' },
  { entityType: 'epic', action: 'updated', type: 'epic.updated' },
  { entityType: 'epic', action: 'status_changed', type: 'epic.status_changed' },
  { entityType: 'epic', action: 'completed', type: 'epic.completed' },
  { entityType: 'epic', action: 'moved', type: 'epic.moved' },
  { entityType: 'epic', action: 'deleted', type: 'epic.deleted' },
  { entityType: 'project', action: 'created', type: 'project.created' },
  { entityType: 'project', action: 'renamed', type: 'project.renamed' },
  { entityType: 'project', action: 'archived', type: 'project.archived' },
  { entityType: 'project', action: 'unarchived', type: 'project.unarchived' },
  { entityType: 'project', action: 'moved', type: 'project.moved', projectMove: 'destination' },
  { entityType: 'project', action: 'moved', type: 'project.moved_out', projectMove: 'source' },
  { entityType: 'organisation', action: 'created', type: 'organisation.created' },
  { entityType: 'organisation', action: 'renamed', type: 'organisation.renamed' },
  { entityType: 'member', action: 'member_added', type: 'member.added' },
  { entityType: 'member', action: 'invited', type: 'member.invited' },
  { entityType: 'member', action: 'member_joined', type: 'member.joined' },
  { entityType: 'member', action: 'role_changed', type: 'member.role_changed' },
  { entityType: 'member', action: 'member_left', type: 'member.left' },
  { entityType: 'member', action: 'member_removed', type: 'member.removed' },
  { entityType: 'member', action: 'bot_created', type: 'bot.created' },
  { entityType: 'member', action: 'bot_renamed', type: 'bot.renamed' },
  { entityType: 'member', action: 'bot_role_changed', type: 'bot.role_changed' },
  { entityType: 'member', action: 'bot_disabled', type: 'bot.disabled' },
  { entityType: 'member', action: 'bot_token_created', type: 'bot.token_created' },
  { entityType: 'member', action: 'bot_token_revoked', type: 'bot.token_revoked' },
] as const satisfies readonly RegistryEntry[];

export type PublicEventType = (typeof EVENT_REGISTRY)[number]['type'];
export const PUBLIC_EVENT_TYPES = Array.from(
  new Set(EVENT_REGISTRY.map((entry) => entry.type))
).sort();
const PUBLIC_TYPE_SET = new Set<string>(PUBLIC_EVENT_TYPES);
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const HYDRATION_CHUNK_SIZE = 90;

export class EventsFeedError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code:
      | 'invalid_request'
      | 'workspace_not_found'
      | 'stale_cursor'
      | 'cursor_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'EventsFeedError';
  }
}

export function isEventsFeedError(error: unknown): error is EventsFeedError {
  return error instanceof EventsFeedError;
}

export interface EventsPrincipal {
  userId: string;
  userKind: 'human' | 'bot';
}

export interface ParsedEventsQuery {
  after: '0' | 'latest' | string;
  workspace?: string;
  types: PublicEventType[];
  include: Array<'refs' | 'text'>;
  limit: number;
}

function invalidRequest(message: string): EventsFeedError {
  return new EventsFeedError(400, 'invalid_request', message);
}

export function parseEventsQuery(input: {
  after?: string;
  workspace?: string;
  types?: string;
  include?: string;
  limit?: string;
}): ParsedEventsQuery {
  const after = input.after === undefined ? '0' : input.after;
  if (after !== '0' && after !== 'latest' && (!after || after.length > 2048)) {
    throw invalidRequest('after must be 0, latest or an opaque cursor');
  }
  if (input.workspace !== undefined && (!input.workspace.trim() || input.workspace.length > 200)) {
    throw invalidRequest('workspace must be a workspace ID or slug');
  }

  let types = [...PUBLIC_EVENT_TYPES];
  if (input.types !== undefined) {
    const requested = input.types.split(',').map((type) => type.trim());
    if (requested.some((type) => !type)) {
      throw invalidRequest('types must contain registered event types');
    }
    const expanded = new Set<string>();
    for (const type of requested) {
      if (type.endsWith('.*')) {
        const prefix = type.slice(0, -1);
        const matches = PUBLIC_EVENT_TYPES.filter((known) => known.startsWith(prefix));
        if (matches.length === 0) {
          throw invalidRequest(`Unknown event type: ${type}`);
        }
        matches.forEach((known) => expanded.add(known));
      } else if (PUBLIC_TYPE_SET.has(type)) {
        expanded.add(type);
      } else {
        throw invalidRequest(`Unknown event type: ${type}`);
      }
    }
    types = Array.from(expanded).sort() as PublicEventType[];
  }

  let include: Array<'refs' | 'text'> = [];
  if (input.include !== undefined) {
    const requested = input.include.split(',').map((part) => part.trim());
    if (
      requested.some((part) => !part) ||
      requested.some((part) => part !== 'refs' && part !== 'text')
    ) {
      throw invalidRequest('include accepts refs and text');
    }
    include = Array.from(new Set(requested as Array<'refs' | 'text'>)).sort();
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (!/^\d+$/.test(input.limit)) {
      throw invalidRequest('limit must be an integer between 1 and 500');
    }
    limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw invalidRequest('limit must be an integer between 1 and 500');
    }
  }

  return {
    after: after as ParsedEventsQuery['after'],
    ...(input.workspace !== undefined ? { workspace: input.workspace.trim() } : {}),
    types: types as PublicEventType[],
    include,
    limit,
  };
}

interface MembershipRow {
  membershipId: string;
  orgId: string;
  role: string;
  slug: string;
}

interface ResolvedScope {
  canonical: string;
  fingerprint: string;
  rows: MembershipRow[];
  explicitOrgId: string | null;
  botOrgId: string | null;
  isBot: boolean;
}

async function resolveEventsScope(
  db: DB,
  principal: EventsPrincipal,
  workspace?: string
): Promise<ResolvedScope> {
  const user = await db
    .select({ kind: schema.users.kind, botOrgId: schema.users.botOrgId })
    .from(schema.users)
    .where(eq(schema.users.id, principal.userId))
    .get();
  const isBot = principal.userKind === 'bot' || user?.kind === 'bot';
  const botOrgId = isBot ? (user?.botOrgId ?? null) : null;
  const conditions = [eq(schema.organisationMembers.userId, principal.userId)];
  if (isBot) {
    conditions.push(botOrgId ? eq(schema.organisationMembers.orgId, botOrgId) : sql`1 = 0`);
  }
  if (workspace !== undefined) {
    const idMatch = await db
      .select({ id: schema.organisations.id })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, workspace))
      .get();
    conditions.push(
      idMatch
        ? eq(schema.organisationMembers.orgId, idMatch.id)
        : eq(schema.organisations.slug, workspace)
    );
  }
  const rows = await db
    .select({
      membershipId: schema.organisationMembers.id,
      orgId: schema.organisationMembers.orgId,
      role: schema.organisationMembers.role,
      slug: schema.organisations.slug,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.organisationMembers.orgId))
    .where(and(...conditions))
    .orderBy(asc(schema.organisationMembers.orgId), asc(schema.organisationMembers.id));
  if (workspace !== undefined && rows.length === 0) {
    throw new EventsFeedError(404, 'workspace_not_found', 'Workspace not found');
  }
  const selected = rows;
  const explicitOrgId = workspace === undefined ? null : selected[0].orgId;
  const canonical = explicitOrgId ? `workspace:${explicitOrgId}` : 'all';
  const membership = selected.map((row) => ({
    id: row.membershipId,
    orgId: row.orgId,
    role: row.role,
  }));
  const scopeFingerprint = await fingerprint({ canonical, membership });
  return {
    canonical,
    fingerprint: scopeFingerprint,
    rows: selected,
    explicitOrgId,
    botOrgId,
    isBot,
  };
}

async function getHighWater(db: DB): Promise<number> {
  const row = await db
    .select({ lastSeq: schema.activitySequence.lastSeq })
    .from(schema.activitySequence)
    .where(eq(schema.activitySequence.id, 1))
    .get();
  if (
    !row ||
    !Number.isSafeInteger(row.lastSeq) ||
    row.lastSeq < 0 ||
    row.lastSeq > MAX_ACTIVITY_SEQUENCE
  ) {
    throw new EventsFeedError(503, 'cursor_unavailable', 'The event sequence is unavailable');
  }
  return row.lastSeq;
}

function registryEntryFor(row: Pick<ActivityRow, 'entityType' | 'action' | 'projectId'>) {
  const registry: readonly RegistryEntry[] = EVENT_REGISTRY;
  return registry.find(
    (entry) =>
      entry.entityType === row.entityType &&
      entry.action === row.action &&
      (entry.projectMove === undefined ||
        (entry.projectMove === 'source' && row.projectId === null) ||
        (entry.projectMove === 'destination' && row.projectId !== null))
  );
}

function sqlForRegistryEntry(entry: RegistryEntry): SQL {
  const parts: SQL[] = [
    eq(schema.activityLog.entityType, entry.entityType),
    eq(schema.activityLog.action, entry.action),
  ];
  if (entry.projectMove === 'source') {
    parts.push(isNull(schema.activityLog.projectId));
  } else if (entry.projectMove === 'destination') {
    parts.push(isNotNull(schema.activityLog.projectId));
  }
  return and(...parts)!;
}

function activityVisibilityCondition(principal: EventsPrincipal, scope: ResolvedScope): SQL {
  const homeConstraint = scope.isBot
    ? scope.botOrgId
      ? sql`AND feed_member.org_id = ${scope.botOrgId}`
      : sql`AND 1 = 0`
    : sql``;
  const workspaceConstraint = scope.explicitOrgId
    ? sql`AND ${schema.activityLog.orgId} = ${scope.explicitOrgId}`
    : sql``;
  return sql`
    EXISTS (
      SELECT 1
      FROM OrganisationMembers feed_member
      WHERE feed_member.org_id = ${schema.activityLog.orgId}
        AND feed_member.user_id = ${principal.userId}
        ${homeConstraint}
    )
    ${workspaceConstraint}
  `;
}

function currentEntityEligibility(): SQL {
  const taskKey = sql`CASE
    WHEN ${schema.activityLog.taskId} IS NOT NULL THEN ${schema.activityLog.taskId}
    WHEN ${schema.activityLog.entityType} = 'task' THEN ${schema.activityLog.entityId}
    ELSE NULL END`;
  const taskScope = sql`(
    ${taskKey} IS NULL
    OR (${schema.activityLog.entityType} = 'task' AND ${schema.activityLog.action} = 'moved_out')
    OR NOT EXISTS (SELECT 1 FROM Tasks feed_task WHERE feed_task.id = ${taskKey})
    OR EXISTS (
      SELECT 1 FROM Tasks feed_task
      INNER JOIN Projects feed_task_project ON feed_task_project.id = feed_task.project_id
      WHERE feed_task.id = ${taskKey} AND feed_task_project.org_id = ${schema.activityLog.orgId}
    )
  )`;
  const projectContext = sql`(
    ${taskKey} IS NOT NULL
    OR ${schema.activityLog.entityType} = 'epic'
    OR ${schema.activityLog.entityType} = 'project'
    OR ${schema.activityLog.projectId} IS NULL
    OR NOT EXISTS (SELECT 1 FROM Projects feed_context_project WHERE feed_context_project.id = ${schema.activityLog.projectId})
    OR EXISTS (
      SELECT 1 FROM Projects feed_context_project
      WHERE feed_context_project.id = ${schema.activityLog.projectId}
        AND feed_context_project.org_id = ${schema.activityLog.orgId}
    )
  )`;
  const epicScope = sql`(
    ${schema.activityLog.entityType} <> 'epic'
    OR NOT EXISTS (SELECT 1 FROM Epics feed_epic WHERE feed_epic.id = ${schema.activityLog.entityId})
    OR EXISTS (
      SELECT 1 FROM Epics feed_epic
      INNER JOIN Projects feed_epic_project ON feed_epic_project.id = feed_epic.project_id
      WHERE feed_epic.id = ${schema.activityLog.entityId}
        AND feed_epic_project.org_id = ${schema.activityLog.orgId}
    )
  )`;
  const projectEntityScope = sql`(
    ${schema.activityLog.entityType} <> 'project'
    OR (${schema.activityLog.action} = 'moved' AND ${schema.activityLog.projectId} IS NULL)
    OR NOT EXISTS (SELECT 1 FROM Projects feed_project WHERE feed_project.id = ${schema.activityLog.entityId})
    OR EXISTS (
      SELECT 1 FROM Projects feed_project
      WHERE feed_project.id = ${schema.activityLog.entityId}
        AND feed_project.org_id = ${schema.activityLog.orgId}
    )
  )`;
  return and(taskScope, projectContext, epicScope, projectEntityScope)!;
}

interface ActivityRow {
  id: string;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  entityType: string;
  entityId: string;
  taskId: string | null;
  epicId: string | null;
  action: string;
  summary: string;
  changes: string | null;
  via: string | null;
  createdAt: string | null;
  seq: number;
}

async function queryEligibleRows(
  db: DB,
  principal: EventsPrincipal,
  scope: ResolvedScope,
  entries: RegistryEntry[],
  afterSequence: number,
  highWater: number,
  limit: number,
  timeRange?: { from: string; to: string }
): Promise<ActivityRow[]> {
  const conditions: SQL[] = [
    isNotNull(schema.activityLog.id),
    ne(schema.activityLog.id, ''),
    isNotNull(schema.activityLog.orgId),
    sql`${schema.activityLog.seq} > ${afterSequence}`,
    sql`${schema.activityLog.seq} <= ${highWater}`,
    or(...entries.map(sqlForRegistryEntry))!,
    activityVisibilityCondition(principal, scope),
    currentEntityEligibility(),
  ];
  if (timeRange) {
    conditions.push(
      isNotNull(schema.activityLog.createdAt),
      sql`${schema.activityLog.createdAt} >= ${timeRange.from}`,
      sql`${schema.activityLog.createdAt} < ${timeRange.to}`
    );
  }
  const selected = db
    .select({
      id: schema.activityLog.id,
      actorId: schema.activityLog.actorId,
      orgId: schema.activityLog.orgId,
      projectId: schema.activityLog.projectId,
      entityType: schema.activityLog.entityType,
      entityId: schema.activityLog.entityId,
      taskId: schema.activityLog.taskId,
      epicId: schema.activityLog.epicId,
      action: schema.activityLog.action,
      summary: schema.activityLog.summary,
      changes: schema.activityLog.changes,
      via: schema.activityLog.via,
      createdAt: schema.activityLog.createdAt,
      seq: schema.activityLog.seq,
    })
    .from(schema.activityLog)
    .where(and(...conditions));
  const ordered = timeRange
    ? selected.orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.seq))
    : selected.orderBy(asc(schema.activityLog.seq));
  return (await ordered.limit(limit)) as ActivityRow[];
}

function scopeKey(orgId: string, id: string) {
  return `${orgId}\u0000${id}`;
}

function chunkIds(ids: string[]) {
  const unique = Array.from(new Set(ids));
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += HYDRATION_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + HYDRATION_CHUNK_SIZE));
  }
  return chunks;
}

interface TaskState {
  id: string;
  status: string;
  title: string;
  isDeleted: boolean | null;
}

interface NoteState {
  taskId: string;
}

interface ActorState {
  id: string;
  name: string | null;
  kind: string | null;
}

interface HydratedRows {
  tasks: Map<string, TaskState>;
  existingTaskIds: Map<string, Set<string>>;
  notes: Map<string, NoteState>;
  existingNoteIds: Map<string, Set<string>>;
  projectsInScope: Map<string, Set<string>>;
  existingProjectIds: Map<string, Set<string>>;
  epicsInScope: Map<string, Set<string>>;
  existingEpicIds: Map<string, Set<string>>;
  refs: Map<string, Array<{ role: string; kind: string; ref: string }>>;
  actors: Map<string, ActorState>;
}

function collectIdsByOrg(rows: ActivityRow[], selector: (row: ActivityRow) => string | null) {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.orgId) {
      continue;
    }
    const id = selector(row);
    if (!id) {
      continue;
    }
    const ids = grouped.get(row.orgId) ?? new Set<string>();
    ids.add(id);
    grouped.set(row.orgId, ids);
  }
  return grouped;
}

function addSet(map: Map<string, Set<string>>, key: string, ids: string[]) {
  const current = map.get(key) ?? new Set<string>();
  ids.forEach((id) => current.add(id));
  map.set(key, current);
}

async function hydrateRows(
  db: DB,
  rows: ActivityRow[],
  includeRefs: boolean
): Promise<HydratedRows> {
  const tasks = new Map<string, TaskState>();
  const existingTaskIds = new Map<string, Set<string>>();
  const notes = new Map<string, NoteState>();
  const existingNoteIds = new Map<string, Set<string>>();
  const projectsInScope = new Map<string, Set<string>>();
  const existingProjectIds = new Map<string, Set<string>>();
  const epicsInScope = new Map<string, Set<string>>();
  const existingEpicIds = new Map<string, Set<string>>();
  const refs = new Map<string, Array<{ role: string; kind: string; ref: string }>>();
  const actors = new Map<string, ActorState>();

  const taskIdsByOrg = collectIdsByOrg(rows, (row) => {
    if (row.entityType === 'task' && row.action === 'moved_out') {
      return null;
    }
    return row.taskId ?? (row.entityType === 'task' ? row.entityId : null);
  });
  for (const [orgId, ids] of taskIdsByOrg) {
    for (const chunk of chunkIds(Array.from(ids))) {
      const sameWorkspace = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          title: schema.tasks.title,
          isDeleted: schema.tasks.isDeleted,
        })
        .from(schema.tasks)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
        .where(and(inArray(schema.tasks.id, chunk), eq(schema.projects.orgId, orgId)));
      for (const task of sameWorkspace) {
        tasks.set(scopeKey(orgId, task.id), {
          id: task.id,
          status: task.status,
          title: task.title,
          isDeleted: task.isDeleted,
        });
      }
      const existing = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(inArray(schema.tasks.id, chunk));
      addSet(
        existingTaskIds,
        orgId,
        existing.map((task) => task.id)
      );
    }
  }

  const projectIdsByOrg = collectIdsByOrg(rows, (row) =>
    row.entityType === 'project' ? row.entityId : row.projectId
  );
  for (const [orgId, ids] of projectIdsByOrg) {
    for (const chunk of chunkIds(Array.from(ids))) {
      const sameWorkspace = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(inArray(schema.projects.id, chunk), eq(schema.projects.orgId, orgId)));
      const existing = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(inArray(schema.projects.id, chunk));
      addSet(
        projectsInScope,
        orgId,
        sameWorkspace.map((project) => project.id)
      );
      addSet(
        existingProjectIds,
        orgId,
        existing.map((project) => project.id)
      );
    }
  }

  const epicIdsByOrg = collectIdsByOrg(rows, (row) =>
    row.entityType === 'epic' ? row.entityId : row.epicId
  );
  for (const [orgId, ids] of epicIdsByOrg) {
    for (const chunk of chunkIds(Array.from(ids))) {
      const sameWorkspace = await db
        .select({ id: schema.epics.id })
        .from(schema.epics)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.epics.projectId))
        .where(and(inArray(schema.epics.id, chunk), eq(schema.projects.orgId, orgId)));
      const existing = await db
        .select({ id: schema.epics.id })
        .from(schema.epics)
        .where(inArray(schema.epics.id, chunk));
      addSet(
        epicsInScope,
        orgId,
        sameWorkspace.map((epic) => epic.id)
      );
      addSet(
        existingEpicIds,
        orgId,
        existing.map((epic) => epic.id)
      );
    }
  }

  const noteIdsByOrg = collectIdsByOrg(rows, (row) =>
    row.entityType === 'note' ? row.entityId : null
  );
  for (const [orgId, ids] of noteIdsByOrg) {
    for (const chunk of chunkIds(Array.from(ids))) {
      const sameWorkspace = await db
        .select({ id: schema.taskUpdates.id, taskId: schema.taskUpdates.taskId })
        .from(schema.taskUpdates)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskUpdates.taskId))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
        .where(and(inArray(schema.taskUpdates.id, chunk), eq(schema.projects.orgId, orgId)));
      for (const note of sameWorkspace) {
        notes.set(scopeKey(orgId, note.id), { taskId: note.taskId });
      }
      const existing = await db
        .select({ id: schema.taskUpdates.id })
        .from(schema.taskUpdates)
        .where(inArray(schema.taskUpdates.id, chunk));
      addSet(
        existingNoteIds,
        orgId,
        existing.map((note) => note.id)
      );
    }
  }

  if (includeRefs) {
    for (const [orgId, ids] of taskIdsByOrg) {
      for (const chunk of chunkIds(Array.from(ids))) {
        const result = await db
          .select({
            taskId: schema.taskRefs.taskId,
            role: schema.taskRefs.role,
            kind: schema.taskRefs.kind,
            ref: schema.taskRefs.ref,
          })
          .from(schema.taskRefs)
          .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskRefs.taskId))
          .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
          .where(
            and(
              inArray(schema.taskRefs.taskId, chunk),
              eq(schema.taskRefs.orgId, orgId),
              eq(schema.projects.orgId, orgId),
              sql`${schema.tasks.isDeleted} = 0`
            )
          );
        for (const ref of result) {
          const key = scopeKey(orgId, ref.taskId);
          const list = refs.get(key) ?? [];
          list.push({ role: ref.role, kind: ref.kind, ref: ref.ref });
          refs.set(key, list);
        }
      }
    }
  }

  const actorIds = Array.from(
    new Set(rows.map((row) => row.actorId).filter((id): id is string => !!id))
  );
  for (const chunk of chunkIds(actorIds)) {
    if (chunk.length === 0) {
      continue;
    }
    const people = await db
      .select({ id: schema.users.id, name: schema.users.name, kind: schema.users.kind })
      .from(schema.users)
      .where(inArray(schema.users.id, chunk));
    for (const person of people) {
      actors.set(person.id, { id: person.id, name: person.name, kind: person.kind });
    }
  }

  return {
    tasks,
    existingTaskIds,
    notes,
    existingNoteIds,
    projectsInScope,
    existingProjectIds,
    epicsInScope,
    existingEpicIds,
    refs,
    actors,
  };
}

const TASK_STATUSES = new Set(['do', 'delay', 'done', 'delegate', 'awaiting']);
const EPIC_STATUSES = new Set(['active', 'completed', 'on_hold']);
const VIA_VALUES = new Set(['web', 'token', 'owner_secret', 'system']);

function safeChanges(row: ActivityRow, type: string) {
  if (
    !['task.status_changed', 'task.completed', 'epic.status_changed', 'epic.completed'].includes(
      type
    )
  ) {
    return undefined;
  }
  if (!row.changes) {
    return undefined;
  }
  let changes: unknown;
  try {
    changes = JSON.parse(row.changes);
  } catch {
    return undefined;
  }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return undefined;
  }
  const status = (changes as Record<string, unknown>).status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return undefined;
  }
  const pair = status as Record<string, unknown>;
  const allowed = type.startsWith('task.') ? TASK_STATUSES : EPIC_STATUSES;
  if (
    typeof pair.from !== 'string' ||
    typeof pair.to !== 'string' ||
    !allowed.has(pair.from) ||
    !allowed.has(pair.to) ||
    pair.from === pair.to ||
    (type === 'task.completed' && pair.to !== 'done') ||
    (type === 'task.status_changed' && pair.to === 'done') ||
    (type === 'epic.completed' && pair.to !== 'completed') ||
    (type === 'epic.status_changed' && pair.to === 'completed')
  ) {
    return undefined;
  }
  return { status: { from: pair.from, to: pair.to } };
}

function occurredAt(value: string | null) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeVia(value: string | null): EventVia {
  return value && VIA_VALUES.has(value) ? (value as EventVia) : null;
}

function eventTypeFor(row: ActivityRow): PublicEventType | null {
  return (registryEntryFor(row)?.type as PublicEventType | undefined) ?? null;
}

function taskKeyFor(row: ActivityRow) {
  if (row.entityType === 'task') {
    return row.taskId ?? row.entityId;
  }
  return row.taskId;
}

function safeTokenSummary(type: string, summary: string) {
  if (type === 'bot.token_created') {
    return 'A bot token was created';
  }
  if (type === 'bot.token_revoked') {
    return 'A bot token was revoked';
  }
  return summary;
}

export interface EventActor {
  id: string | null;
  kind: EventActorKind;
  name?: string;
}

export interface EventTask {
  id: string;
  status?: string;
  deleted: boolean;
  title?: string;
  refs?: Array<{ role: string; ref: string }>;
}

export interface RecordedEvent {
  id: string;
  type: PublicEventType;
  occurredAt: string | null;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  epicId: string | null;
  actor: EventActor;
  via: EventVia;
  changes?: { status: { from: string; to: string } };
  task: EventTask | null;
  summary?: string;
}

function actorKind(person: ActorState | undefined, row: ActivityRow): EventActorKind {
  if (person?.kind === 'human' || person?.kind === 'bot') {
    return person.kind;
  }
  if (!row.actorId && row.via === 'system') {
    return 'system';
  }
  return null;
}

function toRecordedEvent(
  row: ActivityRow,
  type: PublicEventType,
  hydrated: HydratedRows,
  include: Array<'refs' | 'text'>
): RecordedEvent | null {
  const orgId = row.orgId;
  if (!orgId || !row.id) {
    return null;
  }
  const redactedMove = type === 'task.moved_out' || type === 'project.moved_out';
  const taskId = taskKeyFor(row);
  const key = taskId ? scopeKey(orgId, taskId) : null;
  const currentTask = key ? hydrated.tasks.get(key) : undefined;
  const existingTasks = key ? hydrated.existingTaskIds.get(orgId) : undefined;
  if (type === 'task.moved_out') {
    // This invalidation marker intentionally does not hydrate the destination task.
  } else if (taskId && !currentTask && existingTasks?.has(taskId)) {
    return null;
  }
  const taskTombstone =
    !!taskId && type !== 'task.moved_out' && (!currentTask || !!currentTask.isDeleted);
  const noteKey = row.entityType === 'note' ? scopeKey(orgId, row.entityId) : null;
  const currentNote = noteKey ? hydrated.notes.get(noteKey) : undefined;
  const existingNotes = noteKey ? hydrated.existingNoteIds.get(orgId) : undefined;
  if (row.entityType === 'note' && currentNote && currentNote.taskId !== row.taskId) {
    return null;
  }
  if (row.entityType === 'note' && !currentNote && existingNotes?.has(row.entityId)) {
    return null;
  }
  const noteTombstone = row.entityType === 'note' && (type === 'note.deleted' || !currentNote);

  const projectScope = hydrated.projectsInScope.get(orgId);
  const anyProject = hydrated.existingProjectIds.get(orgId);
  let projectId: string | null = null;
  if (type === 'project.moved_out') {
    projectId = row.entityId;
  } else if (row.entityType === 'project') {
    if (projectScope?.has(row.entityId)) {
      projectId = row.entityId;
    } else if (anyProject?.has(row.entityId)) {
      return null;
    }
  } else if (row.projectId && projectScope?.has(row.projectId)) {
    projectId = row.projectId;
  }

  const epicKey = row.entityType === 'epic' ? row.entityId : row.epicId;
  const visibleEpicIds = hydrated.epicsInScope.get(orgId);
  const existingEpicIds = hydrated.existingEpicIds.get(orgId);
  if (
    row.entityType === 'epic' &&
    epicKey &&
    !visibleEpicIds?.has(epicKey) &&
    existingEpicIds?.has(epicKey)
  ) {
    return null;
  }
  const epicId =
    epicKey &&
    (visibleEpicIds?.has(epicKey) || (row.entityType === 'epic' && !existingEpicIds?.has(epicKey)))
      ? epicKey
      : null;
  const epicTombstone = row.entityType === 'epic' && (!epicKey || !visibleEpicIds?.has(epicKey));
  const projectTombstone =
    row.entityType === 'project' &&
    type !== 'project.moved_out' &&
    !projectScope?.has(row.entityId);
  const entityTombstone = noteTombstone || epicTombstone || projectTombstone;
  const includeSafeText =
    include.includes('text') && !redactedMove && !taskTombstone && !entityTombstone;
  const includeSafeRefs =
    include.includes('refs') && !redactedMove && !taskTombstone && !entityTombstone;

  let task: EventTask | null = null;
  if (type !== 'task.moved_out' && taskId) {
    if (!currentTask || currentTask.isDeleted) {
      task = { id: taskId, deleted: true };
    } else {
      const status = TASK_STATUSES.has(currentTask.status) ? currentTask.status : undefined;
      task = { id: taskId, ...(status ? { status } : {}), deleted: false };
      if (includeSafeText) {
        task.title = currentTask.title;
      }
      if (includeSafeRefs) {
        task.refs = (hydrated.refs.get(key!) ?? []).map((ref) => ({
          role: ref.role,
          ref: canonicalRef({ kind: ref.kind, ref: ref.ref }),
        }));
      }
    }
  }

  const person = row.actorId ? hydrated.actors.get(row.actorId) : undefined;
  const actor: EventActor = {
    id: row.actorId,
    kind: actorKind(person, row),
  };
  if (includeSafeText && person?.name?.trim()) {
    actor.name = person.name;
  }
  const event: RecordedEvent = {
    id: row.id,
    type,
    occurredAt: occurredAt(row.createdAt),
    workspaceId: orgId,
    projectId,
    taskId,
    epicId,
    actor,
    via: safeVia(row.via),
    task,
  };
  const changes = taskTombstone ? undefined : safeChanges(row, type);
  if (changes) {
    event.changes = changes;
  }
  if (includeSafeText) {
    event.summary = safeTokenSummary(type, row.summary);
  }
  return event;
}

function cursorPrincipal(userId: string) {
  return fingerprint({ userId });
}

export async function getEventsPage(
  db: DB,
  key: string | undefined,
  principal: EventsPrincipal,
  query: ParsedEventsQuery
): Promise<{ version: 1; events: RecordedEvent[]; next: string; hasMore: boolean }> {
  const scope = await resolveEventsScope(db, principal, query.workspace);
  const [principalFingerprint, filtersFingerprint, currentHighWater] = await Promise.all([
    cursorPrincipal(principal.userId),
    fingerprint({ types: query.types, include: query.include }),
    getHighWater(db),
  ]);
  const currentBinding = {
    principal: await principalFingerprint,
    scope: scope.fingerprint,
    filters: await filtersFingerprint,
  };

  let position = 0;
  let highWater = currentHighWater;
  if (query.after === 'latest') {
    position = currentHighWater;
  } else if (query.after !== '0') {
    const cursor = await decodeCursor(key, 'events', query.after);
    if (cursor.d !== 'events') {
      throw new CursorError(400, 'invalid_cursor', 'The cursor is invalid or cannot be decrypted');
    }
    assertCursorBinding(cursor, currentBinding);
    const cursorHighWater = decodeSequence(cursor.h);
    position = decodeSequence(cursor.a);
    if (cursorHighWater > currentHighWater || position > currentHighWater) {
      throw new CursorError(
        409,
        'stale_cursor',
        'The event sequence moved backwards; restart from a fresh page'
      );
    }
    highWater = position === cursorHighWater ? currentHighWater : cursorHighWater;
  }

  const selectedEntries = EVENT_REGISTRY.filter((entry) => query.types.includes(entry.type));
  const pageEvents: RecordedEvent[] = [];
  let hasMore = false;
  let nextPositionAfterMore = position;
  let scanPosition = position;
  const candidateLimit = query.limit + 1;

  while (true) {
    const rows = await queryEligibleRows(
      db,
      principal,
      scope,
      selectedEntries as unknown as RegistryEntry[],
      scanPosition,
      highWater,
      candidateLimit
    );
    if (rows.length === 0) {
      break;
    }
    const hydrated = await hydrateRows(db, rows, query.include.includes('refs'));
    for (const row of rows) {
      const previousPosition = scanPosition;
      scanPosition = row.seq;
      const type = eventTypeFor(row);
      if (!type || !query.types.includes(type)) {
        continue;
      }
      const event = toRecordedEvent(row, type, hydrated, query.include);
      if (!event) {
        continue;
      }
      if (pageEvents.length === query.limit) {
        hasMore = true;
        nextPositionAfterMore = previousPosition;
        break;
      }
      pageEvents.push(event);
    }
    if (hasMore || rows.length < candidateLimit) {
      break;
    }
  }

  const refreshedScope = await resolveEventsScope(db, principal, query.workspace);
  if (refreshedScope.fingerprint !== scope.fingerprint) {
    throw new CursorError(
      409,
      'stale_cursor',
      'Workspace membership changed; restart from a fresh page'
    );
  }
  const nextPosition = hasMore ? nextPositionAfterMore : highWater;
  const next = await encodeCursor(key, {
    v: 1,
    d: 'events',
    p: currentBinding.principal,
    s: currentBinding.scope,
    f: currentBinding.filters,
    h: encodeSequence(highWater),
    a: encodeSequence(nextPosition),
  });
  return { version: 1, events: pageEvents, next, hasMore };
}

function validateUtcBound(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw invalidRequest('Recent activity bounds must be exact UTC ISO timestamps');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw invalidRequest('Recent activity bounds must be valid UTC timestamps');
  }
  return date.getTime();
}

export interface RecentRecordedActivityItem {
  id: string;
  type: PublicEventType;
  occurredAt: string;
  workspaceId: string;
  taskId: string | null;
  actor: { id: string | null; kind: EventActorKind };
  via: EventVia;
  summary: string | null;
  summaryTruncated: boolean;
}

export interface RecentRecordedActivityResult {
  from: string;
  to: string;
  timezone: 'UTC';
  events: RecentRecordedActivityItem[];
  truncated: boolean;
  unavailable: boolean;
}

const VOICE_GENERIC_SUMMARIES: Partial<Record<PublicEventType, string>> = {
  'bot.created': 'A workspace bot was created',
  'bot.renamed': 'A workspace bot was renamed',
  'bot.role_changed': 'A workspace bot role changed',
  'bot.disabled': 'A workspace bot was disabled',
  'bot.token_created': 'A bot token was created',
  'bot.token_revoked': 'A bot token was revoked',
  'member.added': 'A workspace member was added',
  'member.invited': 'A workspace invitation was sent',
  'member.joined': 'A workspace member joined',
  'member.role_changed': 'A workspace member role changed',
  'member.left': 'A workspace member left',
  'member.removed': 'A workspace member was removed',
  'task.moved_out': 'A task moved out of this workspace',
  'project.moved_out': 'A project moved out of this workspace',
};

export async function getRecentRecordedActivity(
  db: DB,
  principal: EventsPrincipal,
  bounds: { from: string; to: string }
): Promise<RecentRecordedActivityResult> {
  const fromMs = validateUtcBound(bounds.from);
  const toMs = validateUtcBound(bounds.to);
  if (toMs <= fromMs || toMs - fromMs > 24 * 60 * 60 * 1000) {
    throw invalidRequest('Recent activity bounds must cover no more than 24 hours');
  }
  try {
    const scope = await resolveEventsScope(db, principal);
    const highWater = await getHighWater(db);
    const rows = await queryEligibleRows(
      db,
      principal,
      scope,
      EVENT_REGISTRY as unknown as RegistryEntry[],
      0,
      highWater,
      31,
      bounds
    );
    const newestFirst = rows;
    const hydrated = await hydrateRows(db, newestFirst, false);
    const refreshedScope = await resolveEventsScope(db, principal);
    if (refreshedScope.fingerprint !== scope.fingerprint) {
      throw new Error('Workspace membership changed while loading recent activity');
    }
    const truncatedByCount = newestFirst.length > 30;
    const events = newestFirst.slice(0, 30).flatMap((row) => {
      const type = eventTypeFor(row);
      if (!type || !row.id || !row.orgId || !row.createdAt) {
        return [];
      }
      const projected = toRecordedEvent(row, type, hydrated, []);
      if (!projected) {
        return [];
      }
      const taskId = taskKeyFor(row);
      const currentTask = taskId ? hydrated.tasks.get(scopeKey(row.orgId, taskId)) : undefined;
      const taskTombstone =
        !!taskId && type !== 'task.moved_out' && (!currentTask || !!currentTask.isDeleted);
      const noteKey = row.entityType === 'note' ? scopeKey(row.orgId, row.entityId) : null;
      const currentNote = noteKey ? hydrated.notes.get(noteKey) : undefined;
      const noteTombstone = row.entityType === 'note' && (type === 'note.deleted' || !currentNote);
      const projectTombstone =
        row.entityType === 'project' && !hydrated.projectsInScope.get(row.orgId)?.has(row.entityId);
      const epicTombstone =
        row.entityType === 'epic' && !hydrated.epicsInScope.get(row.orgId)?.has(row.entityId);
      const generic = VOICE_GENERIC_SUMMARIES[type];
      const rawSummary =
        generic ??
        (taskTombstone || noteTombstone || projectTombstone || epicTombstone ? null : row.summary);
      const summaryCharacters = rawSummary ? Array.from(rawSummary) : [];
      const summaryTruncated = summaryCharacters.length > 400;
      return [
        {
          id: row.id,
          type,
          occurredAt: occurredAt(row.createdAt) ?? row.createdAt,
          workspaceId: row.orgId,
          taskId: projected.taskId,
          actor: projected.actor,
          via: projected.via,
          summary: rawSummary ? summaryCharacters.slice(0, 400).join('') : null,
          summaryTruncated,
        },
      ];
    });
    return {
      from: bounds.from,
      to: bounds.to,
      timezone: 'UTC',
      events,
      truncated: truncatedByCount || events.some((event) => event.summaryTruncated),
      unavailable: false,
    };
  } catch {
    return {
      from: bounds.from,
      to: bounds.to,
      timezone: 'UTC',
      events: [],
      truncated: false,
      unavailable: true,
    };
  }
}
