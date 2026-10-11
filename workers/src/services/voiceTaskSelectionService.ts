import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { parseRef, type ParsedRef } from '../lib/refs';
import { significantWords } from './similarService';
import { taskIsVisibleTo } from './taskListService';

type DB = DrizzleD1Database<typeof schema>;

export const VOICE_TASK_SAMPLE_CAP = 150;
export const VOICE_TRANSCRIPT_TERM_CAP = 16;
export const VOICE_TRANSCRIPT_ID_CAP = 12;
export const VOICE_TRANSCRIPT_REF_CAP = 20;
export const VOICE_PROMPT_TEXT_LIMIT = 160;
const SOURCE_REF_BATCH_SIZE = 20;
const SELECTED_TEXT_BATCH_SIZE = 80;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface VoiceSourceRef {
  orgId: string;
  kind: string;
  ref: string;
}

export interface VoiceSourceHolder extends VoiceSourceRef {
  taskId: string;
  title: string;
  isDeleted: boolean;
}

export interface VoicePromptFields {
  reason: string | null;
  notes: string | null;
}

export interface VoiceTaskSelection {
  taskIds: string[];
  warnings: string[];
}

function transcriptIds(transcript: string): string[] {
  const candidates = transcript.match(/[\p{L}\p{N}_-]{6,}/gu) ?? [];
  return Array.from(
    new Set(
      candidates.filter(
        (candidate) => /[-_\d]/.test(candidate) || /^[a-f0-9]{8,}$/i.test(candidate)
      )
    )
  );
}

function transcriptRefs(transcript: string): ParsedRef[] {
  const tokens = transcript.match(/[^\s<>"']+/g) ?? [];
  const refs = new Map<string, ParsedRef>();
  for (const token of tokens) {
    const candidate = token.replace(/^[([{]+/, '').replace(/[.,!?;)}\]]+$/, '');
    const parsed = parseRef(candidate);
    if (parsed.ok) {
      refs.set(`${parsed.value.kind}\u0000${parsed.value.ref}`, parsed.value);
    }
  }
  return Array.from(refs.values());
}

function appendDistinct(target: string[], seen: Set<string>, rows: Array<{ id: string }>) {
  for (const row of rows) {
    if (target.length >= VOICE_TASK_SAMPLE_CAP) {
      return;
    }
    if (!seen.has(row.id)) {
      seen.add(row.id);
      target.push(row.id);
    }
  }
}

/**
 * Select task ids from bounded SQL candidates after transcription. Each candidate query returns
 * at most the voice cap; JavaScript only deduplicates these bounded batches, never all visible ids.
 */
export async function selectVoiceTaskIds(
  db: DB,
  userId: string,
  transcript: string,
  now: Date = new Date()
): Promise<VoiceTaskSelection> {
  const warnings: string[] = [];
  const allTerms = significantWords(transcript);
  const terms = allTerms.slice(0, VOICE_TRANSCRIPT_TERM_CAP);
  if (allTerms.length > terms.length) {
    warnings.push(
      `I searched task titles using the first ${VOICE_TRANSCRIPT_TERM_CAP} distinctive words in the transcript.`
    );
  }

  const allIds = transcriptIds(transcript);
  const ids = allIds.slice(0, VOICE_TRANSCRIPT_ID_CAP);
  if (allIds.length > ids.length) {
    warnings.push(
      `I checked the first ${VOICE_TRANSCRIPT_ID_CAP} task id-like strings in the transcript.`
    );
  }

  const allRefs = transcriptRefs(transcript);
  const refs = allRefs.slice(0, VOICE_TRANSCRIPT_REF_CAP);
  if (allRefs.length > refs.length) {
    warnings.push(`I checked the first ${VOICE_TRANSCRIPT_REF_CAP} links in the transcript.`);
  }

  const selected: string[] = [];
  const seen = new Set<string>();

  // Tier 1a: explicit task ids and sufficiently specific id prefixes.
  if (ids.length) {
    const idConditions = ids.map(
      (id) => sql`substr(lower(${schema.tasks.id}), 1, ${id.length}) = lower(${id})`
    );
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.isDeleted, false), taskIsVisibleTo(userId), or(...idConditions)!))
      .orderBy(asc(schema.tasks.id))
      .limit(VOICE_TASK_SAMPLE_CAP);
    appendDistinct(selected, seen, rows);
  }

  // Tier 1b: exact refs are looked up in TaskRefs, separately from title FTS.
  if (selected.length < VOICE_TASK_SAMPLE_CAP && refs.length) {
    const refConditions = refs.map((ref) =>
      and(eq(schema.taskRefs.kind, ref.kind), eq(schema.taskRefs.ref, ref.ref))
    );
    const rows = await db
      .selectDistinct({ id: schema.taskRefs.taskId })
      .from(schema.taskRefs)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskRefs.taskId))
      .where(and(eq(schema.tasks.isDeleted, false), taskIsVisibleTo(userId), or(...refConditions)!))
      .orderBy(asc(schema.taskRefs.taskId))
      .limit(VOICE_TASK_SAMPLE_CAP);
    appendDistinct(selected, seen, rows);
  }

  // Tier 1c: a single distinctive word is enough. Title FTS is not the duplicate-suggestion API.
  if (selected.length < VOICE_TASK_SAMPLE_CAP && terms.length) {
    const ftsQuery = `{title} : (${terms.map((word) => `"${word}"*`).join(' OR ')})`;
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasksFts)
      .innerJoin(schema.tasks, eq(schema.tasksFts.taskId, schema.tasks.id))
      .where(
        and(
          sql`Tasks_FTS match ${ftsQuery}`,
          eq(schema.tasks.isDeleted, false),
          taskIsVisibleTo(userId)
        )
      )
      .orderBy(
        sql`bm25(Tasks_FTS, 0, 10, 0, 0, 0, 0, 0)`,
        desc(schema.tasks.priority),
        desc(
          sql`coalesce(julianday(${schema.tasks.updatedAt}), julianday(${schema.tasks.createdAt}), -1e100)`
        ),
        asc(schema.tasks.id)
      )
      .limit(VOICE_TASK_SAMPLE_CAP);
    appendDistinct(selected, seen, rows);
  }

  // Tier 2: the caller's Do tasks, including their unassigned reports as on /projects?assignee=me.
  if (selected.length < VOICE_TASK_SAMPLE_CAP) {
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.isDeleted, false),
          taskIsVisibleTo(userId),
          eq(schema.tasks.status, 'do'),
          or(
            eq(schema.tasks.assigneeId, userId),
            and(isNull(schema.tasks.assigneeId), eq(schema.tasks.reporterId, userId))
          )!
        )
      )
      .orderBy(
        desc(schema.tasks.priority),
        desc(
          sql`coalesce(julianday(${schema.tasks.updatedAt}), julianday(${schema.tasks.createdAt}), -1e100)`
        ),
        asc(schema.tasks.id)
      )
      .limit(VOICE_TASK_SAMPLE_CAP);
    appendDistinct(selected, seen, rows);
  }

  // Tier 3: other open work touched in the last fortnight, ordered by recency and stable id.
  if (selected.length < VOICE_TASK_SAMPLE_CAP) {
    const cutoff = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    const isCallersDoTask = sql`(
      ${schema.tasks.status} = 'do'
      and (
        (${schema.tasks.assigneeId} is not null and ${schema.tasks.assigneeId} = ${userId})
        or (${schema.tasks.assigneeId} is null and ${schema.tasks.reporterId} = ${userId})
      )
    )`;
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.isDeleted, false),
          taskIsVisibleTo(userId),
          ne(schema.tasks.status, 'done'),
          sql`coalesce(julianday(${schema.tasks.updatedAt}), julianday(${schema.tasks.createdAt}), -1e100) >= julianday(${cutoff})`,
          sql`not (${isCallersDoTask})`
        )
      )
      .orderBy(
        desc(
          sql`coalesce(julianday(${schema.tasks.updatedAt}), julianday(${schema.tasks.createdAt}), -1e100)`
        ),
        desc(schema.tasks.priority),
        asc(schema.tasks.id)
      )
      .limit(VOICE_TASK_SAMPLE_CAP);
    appendDistinct(selected, seen, rows);
  }

  return { taskIds: selected, warnings };
}

function clippedPromptText(column: typeof schema.tasks.reason | typeof schema.tasks.notes) {
  return sql<string | null>`case
    when ${column} is null then null
    when length(${column}) > ${VOICE_PROMPT_TEXT_LIMIT}
      then substr(${column}, 1, ${VOICE_PROMPT_TEXT_LIMIT}) || '...'
    else ${column}
  end`;
}

/** SQL-clipped prompt text for selected visible tasks only. Full bodies are not returned here. */
export async function getVoicePromptFields(
  db: DB,
  userId: string,
  taskIds: string[]
): Promise<Map<string, VoicePromptFields>> {
  const ids = Array.from(new Set(taskIds));
  const fields = new Map<string, VoicePromptFields>();
  for (let index = 0; index < ids.length; index += SELECTED_TEXT_BATCH_SIZE) {
    const chunk = ids.slice(index, index + SELECTED_TEXT_BATCH_SIZE);
    const rows = await db
      .select({
        id: schema.tasks.id,
        reason: clippedPromptText(schema.tasks.reason),
        notes: clippedPromptText(schema.tasks.notes),
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.isDeleted, false),
          taskIsVisibleTo(userId),
          inArray(schema.tasks.id, chunk)
        )
      );
    for (const row of rows) {
      fields.set(row.id, { reason: row.reason, notes: row.notes });
    }
  }
  return fields;
}

/** Target source-holder checks to the exact proposed workspace/ref pairs, never the sample. */
export async function findVoiceSourceHolders(
  db: DB,
  userId: string,
  sourceRefs: VoiceSourceRef[]
): Promise<Map<string, VoiceSourceHolder>> {
  const unique = Array.from(
    new Map(
      sourceRefs.map((source) => [`${source.orgId}\u0000${source.kind}\u0000${source.ref}`, source])
    ).values()
  );
  const holders = new Map<string, VoiceSourceHolder>();
  for (let index = 0; index < unique.length; index += SOURCE_REF_BATCH_SIZE) {
    const chunk = unique.slice(index, index + SOURCE_REF_BATCH_SIZE);
    const conditions = chunk.map((source) =>
      and(
        eq(schema.taskRefs.orgId, source.orgId),
        eq(schema.taskRefs.kind, source.kind),
        eq(schema.taskRefs.ref, source.ref),
        eq(schema.taskRefs.role, 'source')
      )
    );
    const rows = await db
      .select({
        orgId: schema.taskRefs.orgId,
        kind: schema.taskRefs.kind,
        ref: schema.taskRefs.ref,
        taskId: schema.tasks.id,
        title: schema.tasks.title,
        isDeleted: schema.tasks.isDeleted,
      })
      .from(schema.taskRefs)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskRefs.taskId))
      .where(and(taskIsVisibleTo(userId), or(...conditions)!))
      .orderBy(
        asc(schema.taskRefs.orgId),
        asc(schema.taskRefs.kind),
        asc(schema.taskRefs.ref),
        asc(schema.tasks.id)
      )
      .limit(VOICE_TASK_SAMPLE_CAP);
    for (const row of rows) {
      const holder: VoiceSourceHolder = {
        ...row,
        isDeleted: !!row.isDeleted,
      };
      const key = `${row.orgId}\u0000${row.kind}\u0000${row.ref}`;
      if (!holders.has(key)) {
        holders.set(key, holder);
      }
    }
  }
  return holders;
}
