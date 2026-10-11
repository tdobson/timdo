/**
 * Similar open tasks for a title someone is about to create, so people (and bots creating from
 * free text) can spot a likely duplicate and add a note there instead.
 *
 * Matching uses the Tasks_FTS index (porter + unicode61, migration 0005):
 * - the title is lowercased and split into words; stop words and words under 3 letters go
 * - fewer than 2 significant words: no suggestions (one word matches far too much)
 * - the words are ORed as prefix terms against title, reason and notes, ranked by bm25 with the
 *   title weighted highest
 * - each candidate then needs at least 2 of the words, and a score of at least 0.5, where a word
 *   in the title counts 1 and a word only in the reason or notes counts 0.5, over the number of
 *   words. So "Call Robin" does not suggest every task with "call" in it.
 * Only open (not done), not deleted tasks in workspaces the caller belongs to are returned.
 */
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import {
  AccessError,
  canEdit,
  getAccessibleProjects,
  matchingProjectsForCategory,
  type AccessibleProject,
} from './accessService';
import { getPeople, type PersonKind } from './personService';

type DB = DrizzleD1Database<typeof schema>;
type SimilarTaskQueryRow = [
  id: string,
  title: string,
  status: string,
  projectId: string,
  assigneeId: string | null,
  updatedAt: string | null,
  score: number,
];

export interface SimilarTask {
  id: string;
  shortId: string;
  title: string;
  status: string;
  projectId: string;
  projectName: string;
  orgId: string;
  orgName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeKind: PersonKind | null;
  /** 0.5 to 1: the share of the title's significant words found (title 1, reason or notes 0.5). */
  score: number;
  /** Whether the caller can add a note or otherwise edit the task. */
  canEdit: boolean;
  /** Always false here: these are word matches, never exact ref matches. */
  matchedRef: false;
}

export interface SimilarQuery {
  title: string;
  /** Search this project's workspace. */
  projectId?: string;
  /** Search this workspace. */
  orgId?: string;
  /** Search the workspace a create with this category name would land in. */
  category?: string;
  excludeId?: string;
  limit?: number;
}

export const DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 10;
export const MIN_WORDS = 2;
export const MIN_SCORE = 0.5;
export const MAX_TITLE_LENGTH = 500;
// bm25 weights per Tasks_FTS column: task_id, title, reason, notes, customer, tags, update_notes
const BM25 = sql.raw('bm25(Tasks_FTS, 0, 10, 4, 1, 0, 0, 0)');

/** Common English words that say nothing about which task is meant. */
export const STOP_WORDS = new Set(
  (
    'the and for with from that this these those into onto about above after again against ' +
    'are was were will would can could should shall may might must has have had having ' +
    'not but nor our ours your yours their theirs its his her hers him she they them you ' +
    'all any some each every both few more most other such only own same than then too ' +
    'very just also there here what when where which who whom whose why how been being ' +
    'does did doing done get got gets via per out off over under until while because ' +
    'need needs please one two lot lots thing things stuff etc'
  ).split(' ')
);

/**
 * The words of a title that are worth matching on: lowercase letters and digits, at least
 * 3 characters, not a stop word, each once, in order.
 */
export function significantWords(title: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const w of title.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !STOP_WORDS.has(w) && !seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  }
  return words;
}

// Significant words contain only letters and digits, so each FTS prefix literal is safe.
const term = (word: string) => `"${word}"*`;

/** Which workspaces to search, or an AccessError when the named one isn't visible. */
function scopeOrgIds(projects: AccessibleProject[], q: SimilarQuery): string[] {
  if (q.projectId) {
    const project = projects.find((p) => p.id === q.projectId);
    if (!project) {
      throw new AccessError('Project not found', 404);
    }
    return [project.orgId];
  }
  if (q.orgId) {
    if (!projects.some((p) => p.orgId === q.orgId)) {
      throw new AccessError('Workspace not found', 404);
    }
    return [q.orgId];
  }
  if (q.category?.trim()) {
    // Follow the create destination if editable; otherwise search the best visible match read-only.
    const matches = matchingProjectsForCategory(projects, q.category);
    const match = matches.find((project) => canEdit(project.role)) ?? matches[0];
    if (match) {
      return [match.orgId];
    }
    // An unknown category would create a project in the personal workspace, so search there.
    const personal = projects.find((p) => p.orgIsPersonal);
    return personal ? [personal.orgId] : [];
  }
  return Array.from(new Set(projects.map((p) => p.orgId)));
}

/**
 * Up to `limit` open tasks like `title`, best first. `projects` may be passed when the caller
 * has already loaded the user's accessible projects.
 */
export async function findSimilarTasks(
  db: DB,
  userId: string,
  q: SimilarQuery,
  projects?: AccessibleProject[]
): Promise<SimilarTask[]> {
  if (q.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  }
  const words = significantWords(q.title);
  const all = projects ?? (await getAccessibleProjects(db, userId));
  // Scope first, so a bad project or workspace is a 404 even for a one-word title
  const orgIds = scopeOrgIds(all, q);
  if (words.length < MIN_WORDS || orgIds.length === 0) {
    return [];
  }
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Permission-scoped subquery: even a user with many workspace memberships uses one user id
  // binding, rather than one bound parameter per workspace.
  const projectScope: SQL[] = [sql`om.user_id = ${userId}`];
  if (q.projectId) {
    projectScope.push(sql`p.org_id = ${orgIds[0]}`);
  } else if (q.orgId) {
    projectScope.push(sql`p.org_id = ${q.orgId}`);
  } else if (q.category?.trim()) {
    projectScope.push(sql`p.org_id = ${orgIds[0]}`);
  }
  const visibleProject = sql`${schema.tasks.projectId} in (
    select p.id from Projects p
    inner join OrganisationMembers om on om.org_id = p.org_id
    where ${sql.join(projectScope, sql` and `)}
  )`;

  const conditions: SQL[] = [
    sql`Tasks_FTS match ${`{title reason notes} : (${words.map(term).join(' OR ')})`}`,
    eq(schema.tasks.isDeleted, false),
    ne(schema.tasks.status, 'done'),
    visibleProject,
  ];
  if (q.excludeId) {
    conditions.push(ne(schema.tasks.id, q.excludeId));
  }

  const matches = db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      projectId: schema.tasks.projectId,
      assigneeId: schema.tasks.assigneeId,
      updatedAt: schema.tasks.updatedAt,
      rank: sql<number>`${BM25}`.as('rank'),
    })
    .from(schema.tasksFts)
    .innerJoin(schema.tasks, eq(schema.tasksFts.taskId, schema.tasks.id))
    .where(and(...conditions));

  // Search the full word set through two dynamic FTS cursors, rather than compiling one
  // correlated FTS subquery per word. The JSON term table keeps SQL shape and binding count fixed.
  const scoredRows = await db.values<SimilarTaskQueryRow>(sql`
    WITH similar_task_matches AS ${matches},
    similar_query_words AS (
      SELECT value AS word FROM json_each(${JSON.stringify(words)})
    ),
    similar_total_hit_counts AS (
      SELECT total_fts.task_id AS task_id, COUNT(*) AS total_hits
      FROM similar_query_words
      JOIN Tasks_FTS(
        '{title reason notes} : ("' || similar_query_words.word || '"*)'
      ) AS total_fts ON 1 = 1
      JOIN similar_task_matches AS candidate ON candidate.id = total_fts.task_id
      GROUP BY total_fts.task_id
    ),
    similar_title_hit_counts AS (
      SELECT title_fts.task_id AS task_id, COUNT(*) AS title_hits
      FROM similar_query_words
      JOIN Tasks_FTS(
        '{title} : ("' || similar_query_words.word || '"*)'
      ) AS title_fts ON 1 = 1
      JOIN similar_task_matches AS candidate ON candidate.id = title_fts.task_id
      GROUP BY title_fts.task_id
    ),
    similar_scored_candidates AS (
      SELECT
        candidate.id AS id,
        candidate.title AS title,
        candidate.status AS status,
        candidate.project_id AS project_id,
        candidate.assignee_id AS assignee_id,
        candidate.updated_at AS updated_at,
        candidate.rank AS rank,
        total_hits.total_hits AS hits,
        COALESCE(title_hits.title_hits, 0) AS title_hits,
        (
          COALESCE(title_hits.title_hits, 0)
          + (total_hits.total_hits - COALESCE(title_hits.title_hits, 0)) / 2.0
        ) / ${words.length} AS score
      FROM similar_task_matches AS candidate
      INNER JOIN similar_total_hit_counts AS total_hits ON total_hits.task_id = candidate.id
      LEFT JOIN similar_title_hit_counts AS title_hits ON title_hits.task_id = candidate.id
    )
    SELECT id, title, status, project_id, assignee_id, updated_at, score
    FROM similar_scored_candidates
    WHERE hits >= ${MIN_WORDS} AND score >= ${MIN_SCORE}
    ORDER BY score DESC, rank ASC, updated_at DESC
    LIMIT ${limit}
  `);
  const scored = scoredRows.map(([id, title, status, projectId, assigneeId, updatedAt, score]) => ({
    id,
    title,
    status,
    projectId,
    assigneeId,
    updatedAt,
    score,
  }));

  const byId = new Map(all.map((p) => [p.id, p]));
  const people = await getPeople(
    db,
    scored.map((r) => r.assigneeId)
  );
  return scored.map((r) => {
    const project = byId.get(r.projectId)!;
    return {
      id: r.id,
      shortId: r.id.slice(0, 8),
      title: r.title,
      status: r.status,
      projectId: r.projectId,
      projectName: project.name,
      orgId: project.orgId,
      orgName: project.orgName,
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeId ? (people.get(r.assigneeId)?.name ?? null) : null,
      assigneeKind: r.assigneeId ? (people.get(r.assigneeId)?.kind ?? 'human') : null,
      score: Math.round(r.score * 100) / 100,
      matchedRef: false as const,
      canEdit: canEdit(project.role),
    };
  });
}
