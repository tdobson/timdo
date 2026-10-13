/**
 * Voice commands in a multi-user TimDo.
 *
 * loadVoiceContext() gathers the user's workspaces with role, projects, people, epics and a bounded
 * task sample. Aggregate counts cover every visible task; full bodies load only for proposed changes.
 * describeContextForPrompt() turns that into compact text for the LLM.
 * resolveProposals() checks the LLM's proposals against the same context: names become
 * ids, view-only and unknown targets are dropped or flagged, and each proposal gains the
 * labels the review screen shows (workspace, project, assignee). Proposed links (refs) are
 * checked with the shared parser and against the links already in use in that workspace.
 * addSimilarTasks() then looks up open tasks like each proposed new task, so the review screen
 * can say "Looks like an existing task" and offer to add a note there instead.
 */
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { canonicalRef, normaliseRole, parseRef, shortRefLabel, type RefRole } from '../lib/refs';
import { canEdit, getAccessibleProjects, type AccessibleProject, type Role } from './accessService';
import * as botService from './botService';
import type { BotTaskCreationCount } from './botService';
import { getEpicsForUser } from './epicService';
import { getRecentRecordedActivity, type RecentRecordedActivityResult } from './eventsFeedService';
import { getGoalsForUser } from './goalService';
import { getLondonDayWindow } from './londonDayWindow';
import { getOrganisationMembers } from './organisationService';
import { getSelectedTaskSummariesForUser, type TaskView } from './projectService';
import { findSimilarTasks, type SimilarQuery, type SimilarTask } from './similarService';
import { getSelectedTaskRows, getTaskAggregateCountsForUser } from './taskListService';
import {
  findVoiceSourceHolders,
  getVoicePromptFields,
  selectVoiceTaskIds,
  VOICE_TASK_SAMPLE_CAP,
  type VoicePromptFields,
  type VoiceSourceHolder,
  type VoiceSourceRef,
} from './voiceTaskSelectionService';

type DB = DrizzleD1Database<typeof schema>;

export interface VoicePerson {
  userId: string;
  name: string;
  email: string;
  role: Role;
}

/** A safe bot identity. It has no email or credential fields and is never assignable. */
export interface VoiceBot {
  userId: string;
  name: string;
  role: Role;
}

export interface VoiceWorkspace {
  id: string;
  name: string;
  isPersonal: boolean;
  role: Role;
  canEdit: boolean;
  /** Human members only. */
  members: VoicePerson[];
  /** Active bots are separate from the assignable people list. */
  bots: VoiceBot[];
  projects: AccessibleProject[];
}

export interface VoiceBotTaskCreationFacts {
  status: 'available' | 'unavailable';
  localDate: string;
  timeZone: 'Europe/London';
  from: string;
  to: string;
  items: BotTaskCreationCount[];
  total: number | null;
  omitted: number | null;
}

export interface VoiceEpic {
  id: string;
  title: string;
  projectId: string | null;
  category: string | null;
  status: string;
}

export interface VoiceGoal {
  id: string;
  title: string;
}

/** A task as voice sees it: the TaskView fields we rely on, all optional except the basics. */
export type VoiceTask = Partial<TaskView> & {
  id: string;
  project: string;
  status: TaskView['status'];
  priority: number;
  size: TaskView['size'];
};

export interface VoiceContext {
  me: { id: string; name: string; email?: string };
  workspaces: VoiceWorkspace[];
  projects: AccessibleProject[];
  tasks: VoiceTask[];
  epics: VoiceEpic[];
  goals: VoiceGoal[];
  /** Today's visible bot task-created aggregates, with explicit bounds and availability. */
  botTaskCreationsToday?: VoiceBotTaskCreationFacts;
  /** Safe recorded activity for the exact trailing 24 hours, separate from UK-day bot counts. */
  recentRecordedActivity?: RecentRecordedActivityResult;
  /** True SQL totals, independent of the selected task sample. */
  taskCounts?: import('./taskListService').TaskAggregateCounts;
  /** The limit applied to the selected task sample. */
  sampleCap?: number;
  /** Warnings raised when unusually long transcript searches are bounded. */
  selectionWarnings?: string[];
  /** SQL-clipped text used only to build the prompt, never treated as full task bodies. */
  promptFields?: Map<string, VoicePromptFields>;
  /** Hydrate bodies only after a selected task is actually targeted by a proposal. */
  hydrateTaskBodies?: (
    taskIds: string[]
  ) => Promise<Map<string, { reason: string | null; notes: string | null }>>;
  /** Authoritative, targeted source checks, including holders outside the selected sample. */
  findSourceHolders?: (refs: VoiceSourceRef[]) => Promise<Map<string, VoiceSourceHolder>>;
  /**
   * Open tasks like a title, from the database (set by loadVoiceContext). A context built
   * by hand has none, and its proposals simply carry no duplicate hints.
   */
  findSimilar?: (query: SimilarQuery) => Promise<SimilarTask[]>;
}

/* ------------------------------------------------------------------ loading */

/**
 * Load a bounded, permission-checked task sample after transcription. Counts remain aggregates
 * over every visible task; full bodies are fetched only if a selected task is proposed for change.
 */
export async function loadVoiceContext(
  db: DB,
  userId: string,
  transcript = '',
  now: Date = new Date()
): Promise<VoiceContext> {
  const capturedNow = new Date(now.getTime());
  const recentBounds = {
    from: new Date(capturedNow.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    to: capturedNow.toISOString(),
  };
  const dayWindow = getLondonDayWindow(capturedNow);
  const recentRecordedActivityPromise = getRecentRecordedActivity(
    db,
    { userId, userKind: 'human' },
    recentBounds
  );
  const botTaskCreationsPromise: Promise<VoiceBotTaskCreationFacts> = botService
    .getBotTaskCreationCounts(db, userId, {
      from: dayWindow.from,
      to: dayWindow.to,
      limit: 50,
    })
    .then(({ items, total }) => {
      const boundedItems = items.slice(0, 50);
      const boundedTotal = Math.max(0, Math.floor(total));
      return {
        ...dayWindow,
        status: 'available' as const,
        items: boundedItems,
        total: boundedTotal,
        omitted: Math.max(0, boundedTotal - boundedItems.length),
      };
    })
    .catch(() => ({
      ...dayWindow,
      status: 'unavailable' as const,
      items: [],
      total: null,
      omitted: null,
    }));

  const [
    projects,
    meRow,
    epicsRaw,
    goalsRaw,
    taskCounts,
    selection,
    botTaskCreationsToday,
    recentRecordedActivityRaw,
  ] = await Promise.all([
    getAccessibleProjects(db, userId),
    db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        kind: schema.users.kind,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .get(),
    getEpicsForUser(db, userId).catch(() => []),
    getGoalsForUser(db, userId).catch(() => []),
    getTaskAggregateCountsForUser(db, userId),
    selectVoiceTaskIds(db, userId, transcript),
    botTaskCreationsPromise,
    recentRecordedActivityPromise,
  ]);

  const orgIds = Array.from(new Set(projects.map((p) => p.orgId)));
  const memberLists = await Promise.all(orgIds.map((id) => getOrganisationMembers(db, id)));

  const workspaces: VoiceWorkspace[] = orgIds.map((orgId, i) => {
    const orgProjects = projects.filter((p) => p.orgId === orgId);
    const orgMembers = memberLists[i];
    const first = orgProjects[0];
    return {
      id: orgId,
      name: first.orgName,
      isPersonal: first.orgIsPersonal,
      role: first.role,
      canEdit: canEdit(first.role),
      projects: orgProjects,
      members: orgMembers
        .filter((m) => m.kind !== 'bot')
        .map((m) => ({
          userId: m.userId,
          name: m.userName || m.userEmail?.split('@')[0] || 'Someone',
          email: m.userEmail ?? '',
          role: m.role as Role,
        })),
      bots: orgMembers
        .filter((m) => m.kind === 'bot')
        .map((m) => ({
          userId: m.userId,
          name: m.userName || 'Bot',
          role: m.role as Role,
        })),
    };
  });
  // Personal first, then by name: matches how the rest of the app lists workspaces
  workspaces.sort(
    (a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name)
  );

  const tasks = await getSelectedTaskSummariesForUser(db, userId, selection.taskIds);
  const promptFields = await getVoicePromptFields(
    db,
    userId,
    tasks.map((task) => task.id)
  );
  const selectedIds = new Set(tasks.map((task) => task.id));
  const email = meRow?.kind === 'bot' ? undefined : meRow?.email || undefined;
  return {
    me: {
      id: userId,
      name: meRow?.name || email?.split('@')[0] || 'You',
      ...(email ? { email } : {}),
    },
    workspaces,
    projects,
    tasks,
    epics: (epicsRaw as any[]).map((e) => ({
      id: e.id,
      title: e.title,
      projectId: e.projectId ?? null,
      category: e.category ?? null,
      status: e.status,
    })),
    goals: (goalsRaw as any[]).map((g) => ({ id: g.id, title: g.title })),
    taskCounts,
    botTaskCreationsToday,
    recentRecordedActivity: recentRecordedActivityRaw,
    sampleCap: VOICE_TASK_SAMPLE_CAP,
    selectionWarnings: selection.warnings,
    promptFields,
    hydrateTaskBodies: async (taskIds) => {
      const requested = Array.from(new Set(taskIds)).filter((id) => selectedIds.has(id));
      const rows = await getSelectedTaskRows(db, userId, requested, { fields: 'full' });
      return new Map(
        rows.map((row) => [row.id, { reason: row.reason ?? null, notes: row.notes ?? null }])
      );
    },
    findSourceHolders: (refs) => findVoiceSourceHolders(db, userId, refs),
    // Always the database, never the client's cache: duplicate suggestions are authoritative.
    findSimilar: (query) => findSimilarTasks(db, userId, query, projects),
  };
}

/* ------------------------------------------------------------------ prompt context */

function roleLabel(role: Role) {
  return role === 'viewer' ? 'viewer, VIEW ONLY' : role;
}

/** Workspaces, projects and people, as short lines the model can read. */
export function describeWorkspaces(ctx: VoiceContext): string {
  if (ctx.workspaces.length === 0) {
    return '(none yet)';
  }
  return ctx.workspaces
    .map((w) => {
      const kind = w.isPersonal ? 'personal' : 'shared';
      const projects = w.projects
        .filter((p) => !p.isArchived)
        .map((p) => `${p.name} [${p.key}]`)
        .join(', ');
      const people = w.members
        .map((m) => `${m.name}${m.userId === ctx.me.id ? ' (you)' : ''} <${m.email}> ${m.role}`)
        .join('; ');
      const bots = (w.bots ?? [])
        .map((bot) => `${bot.name} [bot, not assignable] ${bot.role}`)
        .join('; ');
      return [
        `- Workspace "${w.name}" (${kind}, your role: ${roleLabel(w.role)})`,
        `  Projects: ${projects || '(none)'}`,
        `  People you can assign to: ${people || '(none)'}`,
        `  Bots (not assignable): ${bots || '(none)'}`,
      ].join('\n');
    })
    .join('\n');
}

export function describeEpics(ctx: VoiceContext): string {
  const byId = new Map(ctx.projects.map((p) => [p.id, p]));
  const active = ctx.epics.filter((e) => e.status !== 'completed');
  if (active.length === 0) {
    return '(none)';
  }
  return active
    .map((e) => {
      const project = e.projectId ? byId.get(e.projectId)?.name : e.category;
      return `- "${e.title}"${project ? ` in ${project}` : ''}`;
    })
    .join('\n');
}

/** Kinds the parser knows without any refs in use: voice may propose them anywhere */
const BUILT_IN_KINDS = new Set([
  'github.issue',
  'github.pr',
  'gmail.thread',
  'sentry.issue',
  'email',
  'url',
]);
/** Kinds whose ids say nothing useful as an example (or are long, or are addresses) */
const NO_EXAMPLE_KINDS = new Set(['gmail.thread', 'email', 'url']);
const KINDS_PER_WORKSPACE = 10;
const REPOS_PER_WORKSPACE = 5;

const isGithub = (kind: string) => kind === 'github.issue' || kind === 'github.pr';

/** "acme/widgets" from "acme/widgets#12", or null */
function repoOf(ref: string): string | null {
  const m = /^([^/\s#]+\/[^/\s#]+)#\d+$/.exec(ref);
  return m ? m[1] : null;
}

interface KindsInUse {
  /** kind -> how many refs use it, most used first when listed */
  counts: Map<string, number>;
  /** kind -> one example id */
  examples: Map<string, string>;
  /** GitHub repositories linked from issues or PRs, "owner/repo" */
  repos: Set<string>;
}

/** The ref kinds already used on the tasks of each workspace, keyed by workspace id. */
export function refKindsInUse(ctx: VoiceContext): Map<string, KindsInUse> {
  const projectOrg = new Map(ctx.projects.map((p) => [p.id, p.orgId]));
  const byOrg = new Map<string, KindsInUse>();
  for (const t of ctx.tasks) {
    const orgId = (t.projectId && projectOrg.get(t.projectId)) || t.orgId;
    if (!orgId || !Array.isArray(t.refs) || t.refs.length === 0) {
      continue;
    }
    let entry = byOrg.get(orgId);
    if (!entry) {
      entry = { counts: new Map(), examples: new Map(), repos: new Set() };
      byOrg.set(orgId, entry);
    }
    for (const r of t.refs) {
      entry.counts.set(r.kind, (entry.counts.get(r.kind) ?? 0) + 1);
      if (!entry.examples.has(r.kind)) {
        entry.examples.set(r.kind, r.ref);
      }
      const repo = isGithub(r.kind) ? repoOf(r.ref) : null;
      if (repo) {
        entry.repos.add(repo);
      }
    }
  }
  return byOrg;
}

/**
 * One line per workspace that has links: the kinds in use with an example id, and the
 * GitHub repositories, e.g. `- Acme Solar: github.issue (acme/widgets), acme.member (e.g. 123456)`.
 */
export function describeRefKinds(ctx: VoiceContext): string {
  const inUse = refKindsInUse(ctx);
  const lines = ctx.workspaces
    .filter((w) => inUse.has(w.id))
    .map((w) => {
      const entry = inUse.get(w.id)!;
      const repos = Array.from(entry.repos).slice(0, REPOS_PER_WORKSPACE).join(', ');
      const kinds = Array.from(entry.counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, KINDS_PER_WORKSPACE)
        .map(([kind]) => {
          if (isGithub(kind)) {
            return repos ? `${kind} (${repos})` : kind;
          }
          if (NO_EXAMPLE_KINDS.has(kind)) {
            return kind;
          }
          return `${kind} (e.g. ${clip(entry.examples.get(kind))})`;
        });
      return `- ${w.name}: ${kinds.join(', ')}`;
    });
  return lines.length ? lines.join('\n') : '(none yet)';
}

/** Long prompt text is capped; production excerpts are clipped in SQL before reaching this layer. */
const TEXT_LIMIT = 160;

const clip = (text: string | null | undefined) =>
  text && text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text || undefined;

/** Links per task in the prompt; canonical text only, never labels or URLs */
const REFS_PER_TASK = 10;

const compactRefs = (t: VoiceTask) =>
  Array.isArray(t.refs) && t.refs.length > 0
    ? {
        refs: Array.from(new Set(t.refs.map((r) => clip(canonicalRef(r))!))).slice(
          0,
          REFS_PER_TASK
        ),
      }
    : {};

/**
 * Tasks in sample order: enough to find, update and answer questions about them. Prompt body
 * fields come from SQL-clipped excerpts, while the task summaries remain distinct from full bodies.
 */
export function compactTasks(ctx: VoiceContext) {
  const byId = new Map(ctx.projects.map((p) => [p.id, p]));
  const epicTitles = new Map(ctx.epics.map((e) => [e.id, e.title]));
  const live = ctx.tasks.filter((t) => !t.isDeleted);

  return live.map((t) => {
    const project = t.projectId ? byId.get(t.projectId) : undefined;
    const promptFields = ctx.promptFields?.get(t.id);
    const base = {
      id: t.id,
      project: t.project,
      status: t.status,
      category: project?.name ?? t.category ?? null,
      workspace: project?.orgName ?? t.orgName ?? null,
      assignee: t.assigneeName ?? (t.assigneeId ? 'someone' : 'unassigned'),
      ...(project && !canEdit(project.role) ? { viewOnly: true } : {}),
      ...compactRefs(t),
    };
    if (t.status === 'done') {
      return base;
    }
    const reason = ctx.promptFields ? promptFields?.reason : clip(t.reason);
    const notes = ctx.promptFields ? promptFields?.notes : clip(t.notes);
    return {
      ...base,
      priority: t.priority,
      size: t.size,
      ...(reason ? { reason } : {}),
      ...(notes ? { notes } : {}),
      ...(t.awaitUntil ? { awaitUntil: t.awaitUntil } : {}),
      ...(t.epicId && epicTitles.has(t.epicId) ? { epic: epicTitles.get(t.epicId) } : {}),
    };
  });
}

/* ------------------------------------------------------------------ matching helpers */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Pick the candidates whose label best matches the spoken text: exact first, then the
 * same letters ignoring spaces and punctuation ("Acme-Solar" = "Acme Solar"), then a near miss
 * of at most two letters for longer names (Whisper mishearing).
 */
function bestMatches<T>(spoken: string, items: T[], labels: (item: T) => string[]): T[] {
  const s = spoken.trim().toLowerCase();
  const n = norm(spoken);
  if (!n) {
    return [];
  }
  const tiers: Array<(label: string) => boolean> = [
    (l) => l.trim().toLowerCase() === s,
    (l) => norm(l) === n,
    (l) => n.length >= 5 && norm(l).length >= 5 && levenshtein(norm(l), n) <= 2,
  ];
  for (const test of tiers) {
    const hits = items.filter((item) => labels(item).some(test));
    if (hits.length > 0) {
      return hits;
    }
  }
  return [];
}

const ME_WORDS = new Set(['me', 'myself', 'mine', 'i', 'my']);
const NOBODY_WORDS = new Set(['unassigned', 'nobody', 'noone', 'none', 'no one', 'null']);

type PersonMatch =
  | { kind: 'me' }
  | { kind: 'nobody' }
  | { kind: 'person'; person: VoicePerson }
  | { kind: 'bot'; bots: VoiceBot[] }
  | { kind: 'ambiguous'; people: VoicePerson[] }
  | { kind: 'none' };

/** Match a spoken name, human email or exact id against the supplied identities. */
export function matchPerson(
  spoken: string,
  people: Array<VoicePerson | VoiceBot>,
  meId: string
): PersonMatch {
  const raw = spoken.trim().toLowerCase();
  if (!raw) {
    return { kind: 'none' };
  }
  if (ME_WORDS.has(raw)) {
    return { kind: 'me' };
  }
  if (NOBODY_WORDS.has(raw) || NOBODY_WORDS.has(raw.replace(/-/g, ' '))) {
    return { kind: 'nobody' };
  }

  const pick = (hits: Array<VoicePerson | VoiceBot>): PersonMatch | null => {
    const unique = Array.from(new Map(hits.map((p) => [p.userId, p])).values());
    const bots = unique.filter((p): p is VoiceBot => !('email' in p));
    if (bots.length > 0) {
      return { kind: 'bot', bots };
    }
    const humans = unique as VoicePerson[];
    if (humans.length === 1) {
      return humans[0].userId === meId ? { kind: 'me' } : { kind: 'person', person: humans[0] };
    }
    if (humans.length > 1) {
      return { kind: 'ambiguous', people: humans };
    }
    return null;
  };

  const first = (p: VoicePerson | VoiceBot) => p.name.trim().split(/\s+/)[0] || '';
  const last = (p: VoicePerson | VoiceBot) => {
    const parts = p.name.trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : '';
  };
  const n = norm(raw);
  const tests: Array<(p: VoicePerson | VoiceBot) => boolean> = [
    (p) => p.userId.toLowerCase() === raw,
    (p) => 'email' in p && p.email.toLowerCase() === raw,
    (p) => p.name.trim().toLowerCase() === raw || norm(p.name) === n,
    (p) => norm(first(p)) === n,
    (p) => !!last(p) && norm(last(p)) === n,
    (p) => 'email' in p && norm(p.email.split('@')[0]) === n,
    // "Jor" for Jordan, "Jordan E" for Jordan Example
    (p) => n.length >= 2 && (norm(first(p)).startsWith(n) || norm(p.name).startsWith(n)),
    (p) => n.length >= 5 && levenshtein(norm(first(p)), n) <= 1,
    (p) =>
      !('email' in p) &&
      n.length >= 5 &&
      (levenshtein(norm(p.name), n) <= 2 || (!!last(p) && levenshtein(norm(last(p)), n) <= 1)),
  ];
  for (const test of tests) {
    const result = pick(people.filter(test));
    if (result) {
      return result;
    }
  }
  return { kind: 'none' };
}

/** "Robin" or "Sam Smith or Sam Jones" */
function listNames(people: VoicePerson[]) {
  const names = people.map((p) => p.name);
  if (names.length <= 2) {
    return names.join(' or ');
  }
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/* ------------------------------------------------------------------ resolution */

export type ChangeType = 'create' | 'update' | 'delete' | 'createEpic' | 'createProject' | 'claim';

/** What the model returns for one change (loosely typed: it is model output). */
export interface RawChange {
  type: ChangeType;
  projectId?: string;
  after?: Record<string, any> | null;
}

export interface ResolvedProposal {
  type: ChangeType;
  /** The existing task, for update, delete and claim */
  before: VoiceTask | null;
  /** The proposed task, epic or project fields */
  after: Record<string, any> | null;
  /** Existing task id, for update, delete and claim */
  taskId: string | null;
  /** The project (container) this lands in. null when it will be created on apply. */
  projectId: string | null;
  projectName: string | null;
  orgId: string | null;
  orgName: string | null;
  /** True when applying this creates a new project (from the category name) */
  isNewProject: boolean;
  /** undefined = leave as is (or the API default), null = unassigned */
  assigneeId?: string | null;
  assigneeName: string | null;
  assigneeChanged: boolean;
  epicId: string | null;
  epicTitle: string | null;
  goalId: string | null;
  /** Links to add once the task change succeeds (create and update only) */
  refs?: VoiceRefAdd[];
  /** Links to take off the task (update only) */
  removeRefs?: VoiceRefRemove[];
  /** Problems with this change, also included in the response's warnings */
  warnings: string[];
  /** For create: open tasks that look like this one, best first (absent when none) */
  similar?: SimilarTask[];
}

/** A link a change would add, checked with the shared parser. */
export interface VoiceRefAdd {
  /** Canonical `kind:ref` */
  ref: string;
  role: RefRole;
  kind: string;
  url: string | null;
  /** The default label, e.g. "GitHub issue acme/widgets#12" */
  label: string;
}

/** A link a change would take off; role null means every role it has on the task. */
export interface VoiceRefRemove {
  /** Canonical `kind:ref` */
  ref: string;
  role: RefRole | null;
}

export interface ResolveResult {
  proposals: ResolvedProposal[];
  warnings: string[];
}

function personalWorkspace(ctx: VoiceContext) {
  return ctx.workspaces.find((w) => w.isPersonal && w.role === 'owner') ?? null;
}

function workspaceFor(ctx: VoiceContext, orgId: string | null | undefined) {
  return orgId ? (ctx.workspaces.find((w) => w.id === orgId) ?? null) : null;
}

type ProjectTarget =
  | { kind: 'project'; project: AccessibleProject }
  | { kind: 'new'; name: string; workspace: VoiceWorkspace | null }
  | { kind: 'viewOnly'; project: AccessibleProject }
  | { kind: 'none' };

/**
 * Find the project a change is aimed at. Tries the explicit id or key, then the category
 * name. When a name exists in several workspaces, prefers ones the user can edit, then
 * one where the intended assignee is a member.
 */
function resolveProjectTarget(
  ctx: VoiceContext,
  category: string | null | undefined,
  idOrKey: string | null | undefined,
  assigneeHint: string | null | undefined,
  warnings: string[]
): ProjectTarget {
  const live = ctx.projects.filter((p) => !p.isArchived);
  if (idOrKey) {
    const k = idOrKey.trim().toLowerCase();
    const byId = ctx.projects.find((p) => p.id === idOrKey || p.key.toLowerCase() === k);
    if (byId) {
      return canEdit(byId.role)
        ? { kind: 'project', project: byId }
        : { kind: 'viewOnly', project: byId };
    }
  }
  const name = (category || '').trim();
  if (!name) {
    return { kind: 'none' };
  }

  let hits = bestMatches(name, live, (p) => [p.name, p.key]);
  if (hits.length === 0) {
    hits = bestMatches(name, ctx.projects, (p) => [p.name, p.key]);
  }
  if (hits.length === 0) {
    return { kind: 'new', name, workspace: personalWorkspace(ctx) };
  }

  const editable = hits.filter((p) => canEdit(p.role));
  if (editable.length === 0) {
    return { kind: 'viewOnly', project: hits[0] };
  }
  if (editable.length === 1) {
    return { kind: 'project', project: editable[0] };
  }

  if (assigneeHint) {
    const withAssignee = editable.filter((p) => {
      const ws = workspaceFor(ctx, p.orgId);
      const m = ws ? matchPerson(assigneeHint, ws.members, ctx.me.id) : { kind: 'none' };
      return m.kind === 'person' || m.kind === 'me';
    });
    if (withAssignee.length === 1) {
      return { kind: 'project', project: withAssignee[0] };
    }
  }
  const chosen = editable[0];
  warnings.push(
    `There's a "${chosen.name}" project in ${editable.map((p) => p.orgName).join(' and ')}. I used the one in ${chosen.orgName}.`
  );
  return { kind: 'project', project: chosen };
}

interface AssigneeOutcome {
  /** undefined = no change requested */
  assigneeId?: string | null;
  assigneeName: string | null;
}

/**
 * Resolve the spoken assignee against the members of the target workspace.
 * Unresolvable names fall back to `fallback` and add a warning saying what happened.
 */
function resolveAssignee(
  ctx: VoiceContext,
  spoken: string | null | undefined,
  workspace: VoiceWorkspace | null,
  fallback: { assigneeId?: string | null; assigneeName: string | null; label: string },
  warnings: string[]
): AssigneeOutcome {
  if (spoken === undefined || spoken === null || !String(spoken).trim()) {
    return { assigneeId: fallback.assigneeId, assigneeName: fallback.assigneeName };
  }
  const people = workspace?.members ?? [
    { userId: ctx.me.id, name: ctx.me.name, email: ctx.me.email ?? '', role: 'owner' as Role },
  ];
  const identities = [...people, ...(workspace?.bots ?? [])];
  const match = matchPerson(String(spoken), identities, ctx.me.id);
  const wsName = workspace?.name ?? 'your personal';
  if (match.kind === 'me') {
    return { assigneeId: ctx.me.id, assigneeName: ctx.me.name };
  }
  if (match.kind === 'nobody') {
    return { assigneeId: null, assigneeName: null };
  }
  if (match.kind === 'person') {
    return { assigneeId: match.person.userId, assigneeName: match.person.name };
  }
  if (match.kind === 'bot') {
    warnings.push(`Bots can't be assigned tasks, so I ${fallback.label}.`);
    return { assigneeId: fallback.assigneeId, assigneeName: fallback.assigneeName };
  }
  if (match.kind === 'ambiguous') {
    warnings.push(
      `"${spoken}" could be ${listNames(match.people)}, so I ${fallback.label}. Pick the person on the task.`
    );
    return { assigneeId: fallback.assigneeId, assigneeName: fallback.assigneeName };
  }
  // Not in this workspace: say whether they are someone the user knows elsewhere
  const everyone = Array.from(
    new Map(ctx.workspaces.flatMap((w) => w.members).map((p) => [p.userId, p])).values()
  );
  const bots = Array.from(
    new Map(ctx.workspaces.flatMap((w) => w.bots ?? []).map((bot) => [bot.userId, bot])).values()
  );
  const elsewhere = matchPerson(String(spoken), [...everyone, ...bots], ctx.me.id);
  if (elsewhere.kind === 'bot') {
    warnings.push(`Bots can't be assigned tasks, so I ${fallback.label}.`);
  } else if (elsewhere.kind === 'person') {
    warnings.push(
      `${elsewhere.person.name} isn't in the ${wsName} workspace, so I ${fallback.label}.`
    );
  } else {
    warnings.push(
      `I couldn't find anyone called "${spoken}" in the ${wsName} workspace, so I ${fallback.label}.`
    );
  }
  return { assigneeId: fallback.assigneeId, assigneeName: fallback.assigneeName };
}

function resolveEpic(
  ctx: VoiceContext,
  title: string | null | undefined,
  projectId: string | null,
  categoryName: string | null,
  pendingEpicTitles: string[],
  warnings: string[]
): { epicId: string | null; epicTitle: string | null } {
  if (!title || !title.trim()) {
    return { epicId: null, epicTitle: null };
  }
  const inScope = ctx.epics.filter((e) =>
    projectId
      ? e.projectId === projectId
      : !e.projectId && (e.category || '').toLowerCase() === (categoryName || '').toLowerCase()
  );
  const hits = bestMatches(title, inScope, (e) => [e.title]);
  if (hits.length >= 1) {
    return { epicId: hits[0].id, epicTitle: hits[0].title };
  }
  // Created earlier in this same command: the review screen links it once it exists
  const pending = pendingEpicTitles.find((t) => norm(t) === norm(title));
  if (pending) {
    return { epicId: null, epicTitle: pending };
  }
  const where = categoryName ? ` in ${categoryName}` : '';
  warnings.push(`There's no "${title}" epic${where}, so the task won't be linked to an epic.`);
  return { epicId: null, epicTitle: null };
}

function resolveGoal(ctx: VoiceContext, title: string | null | undefined, warnings: string[]) {
  if (!title || !title.trim()) {
    return null;
  }
  const hits = bestMatches(title, ctx.goals, (g) => [g.title]);
  if (hits.length >= 1) {
    return hits[0].id;
  }
  warnings.push(`I couldn't find a life goal called "${title}", so I didn't link one.`);
  return null;
}

/* ------------------------------------------------------------------ links (refs) */

const DIGIT_WORDS = new Map(
  Object.entries({
    zero: '0',
    oh: '0',
    nought: '0',
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
  })
);

/** "four four one one" -> "4411" when an id was spelt out digit by digit; anything else as is */
export function spokenDigits(id: string): string {
  const words = id
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0 || !words.every((w) => DIGIT_WORDS.has(w))) {
    return id;
  }
  return words.map((w) => DIGIT_WORDS.get(w)).join('');
}

/** Spoken digits in the id part of what the model heard: after the last # or after kind: */
function tidyHeard(text: string): string {
  const t = text.trim();
  if (/^(https?|mailto):/i.test(t)) {
    return t;
  }
  const hash = t.lastIndexOf('#');
  if (hash >= 0) {
    return `${t.slice(0, hash + 1)}${spokenDigits(t.slice(hash + 1))}`;
  }
  const colon = t.indexOf(':');
  return colon > 0
    ? `${t.slice(0, colon + 1)}${spokenDigits(t.slice(colon + 1))}`
    : spokenDigits(t);
}

function taskOrgId(ctx: VoiceContext, t: VoiceTask): string | null {
  return (t.projectId && ctx.projects.find((p) => p.id === t.projectId)?.orgId) || t.orgId || null;
}

/** "GitHub issue 12 on widgets" with no owner: find the repository among those in use */
function completeGithubRef(
  kind: string,
  ref: string,
  repos: string[]
): { ref: string } | { heard: string } {
  const m = /^(?:(.*?)#)?(\d+)$/.exec(ref.trim());
  const what = kind === 'github.pr' ? 'pull request' : 'GitHub issue';
  if (!m) {
    return { heard: `${what} ${ref}` };
  }
  const repoPart = (m[1] || '').trim();
  const heard = `${what} ${m[2]}${repoPart ? ` on ${repoPart}` : ''}`;
  // Exact names only: near misses are other repositories as often as mishearings
  const hits = repoPart
    ? repos.filter((r) => [r, r.split('/')[1] || r].some((name) => norm(name) === norm(repoPart)))
    : repos.length === 1
      ? repos
      : [];
  return hits.length === 1 ? { ref: `${hits[0]}#${m[2]}` } : { heard };
}

/**
 * Check the links the model wants to add. Each must parse; GitHub refs need a known
 * repository; a bare kind such as `member` becomes the workspace's `acme.member`; links the
 * task already has are skipped; a source another task already owns becomes a plain link.
 */
function resolveRefAdds(
  ctx: VoiceContext,
  raw: unknown,
  orgId: string | null,
  wsName: string,
  before: VoiceTask | null,
  warnings: string[]
): VoiceRefAdd[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const inUse = refKindsInUse(ctx);
  const here = orgId ? inUse.get(orgId) : undefined;
  const repos = Array.from(here?.repos ?? []);
  const anyRepo = new Set(Array.from(inUse.values()).flatMap((e) => Array.from(e.repos)));
  const out: VoiceRefAdd[] = [];

  for (const item of raw) {
    const said = typeof item === 'string' ? item : item?.ref;
    if (typeof said !== 'string' || !said.trim()) {
      continue;
    }
    const heard = tidyHeard(said);
    const spokenRole = typeof item === 'object' ? item?.role : undefined;
    let role = normaliseRole(typeof spokenRole === 'string' ? spokenRole : undefined);
    if (!role) {
      warnings.push(
        `I didn't recognise "${spokenRole}" as a role (link, source, reported by or about), so ${heard} is added as a plain link.`
      );
      role = 'link';
    }
    const explicitKind =
      typeof item === 'object' && typeof item?.kind === 'string' ? item.kind : '';
    let parsed = parseRef(heard, explicitKind || undefined);
    if (!parsed.ok) {
      warnings.push(`I couldn't make a link out of "${said.trim()}", so I left it out.`);
      continue;
    }

    let { kind, ref } = parsed.value;
    if (isGithub(kind) && !repoOf(ref)) {
      const done = completeGithubRef(kind, ref, repos);
      if ('heard' in done) {
        warnings.push(
          `I heard ${done.heard} but couldn't tell which repository it's in, so I left it out. Paste its URL on the task instead.`
        );
        continue;
      }
      parsed = parseRef(`${kind}:${done.ref}`);
    } else if (isGithub(kind) && !anyRepo.has(repoOf(ref)!)) {
      warnings.push(
        `No task links to the ${repoOf(ref)} repository yet, so check ${canonicalRef({ kind, ref })} is right before applying.`
      );
    } else if (!BUILT_IN_KINDS.has(kind) && !here?.counts.has(kind)) {
      if (!kind.includes('.')) {
        // "member 4411": the workspace's own member kind, if there is exactly one
        const known = Array.from(here?.counts.keys() ?? []).filter(
          (k) => !BUILT_IN_KINDS.has(k) && [kind, `${kind}s`].includes(k.split('.').pop()!)
        );
        if (known.length !== 1) {
          warnings.push(
            known.length > 1
              ? `"${heard}" could be ${known.join(' or ')}, so I left that link out.`
              : `I couldn't tell which system "${heard}" belongs to, so I left that link out.`
          );
          continue;
        }
        parsed = parseRef(ref, known[0]);
      } else {
        warnings.push(
          `Nothing in the ${wsName} workspace links to ${kind} yet, so check ${canonicalRef({ kind, ref })} is right before applying.`
        );
      }
    }
    if (!parsed.ok) {
      warnings.push(`I couldn't make a link out of "${said.trim()}", so I left it out.`);
      continue;
    }
    ({ kind, ref } = parsed.value);
    const canonical = canonicalRef({ kind, ref });

    if (role === 'source' && orgId) {
      const owner = ctx.tasks.find(
        (t) =>
          t.id !== before?.id &&
          taskOrgId(ctx, t) === orgId &&
          (t.refs ?? []).some((r) => r.role === 'source' && r.kind === kind && r.ref === ref)
      );
      if (owner) {
        warnings.push(
          `${canonical} is already the source of "${owner.project}", so it's added as a plain link instead.`
        );
        role = 'link';
      }
    }
    // A ref the task has already, given without a role, is the model echoing the task back
    const roleGiven = typeof spokenRole === 'string' && spokenRole.trim() !== '';
    const already =
      out.some((r) => r.role === role && r.ref === canonical) ||
      (before?.refs ?? []).some(
        (r) => (r.role === role || !roleGiven) && r.kind === kind && r.ref === ref
      );
    if (already) {
      continue;
    }
    out.push({ ref: canonical, role, kind, url: parsed.value.url, label: parsed.value.label });
  }
  return out;
}

/**
 * Match the links the model wants to remove against the ones on the task: by canonical form
 * or URL, else by a unique ending ("#12", "4411"). Without the task's links (an old client
 * cache) a well-formed ref is passed through and the API says if it isn't there.
 */
function resolveRefRemovals(
  raw: unknown,
  before: VoiceTask,
  title: string,
  warnings: string[]
): VoiceRefRemove[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const onTask = Array.isArray(before.refs) ? before.refs : null;
  const out: VoiceRefRemove[] = [];
  const add = (ref: string, role: RefRole | null) => {
    if (!out.some((o) => o.ref === ref && o.role === role)) {
      out.push({ ref, role });
    }
  };

  for (const item of raw) {
    const said = typeof item === 'string' ? item : item?.ref;
    if (typeof said !== 'string' || !said.trim()) {
      continue;
    }
    const heard = tidyHeard(said);
    const parsed = parseRef(heard);
    if (!onTask) {
      if (parsed.ok) {
        add(canonicalRef(parsed.value), null);
      } else {
        warnings.push(`I couldn't tell which link "${said.trim()}" is, so I didn't remove it.`);
      }
      continue;
    }
    let hits = parsed.ok
      ? onTask.filter((r) => r.kind === parsed.value.kind && r.ref === parsed.value.ref)
      : [];
    if (hits.length === 0) {
      const text = heard.toLowerCase();
      const clipped = text.endsWith('...') ? text.slice(0, -3) : null;
      // "member:4411" for acme.member:4411, "github.issue:widgets#12" for acme/widgets#12
      const id = parsed.ok ? parsed.value.ref.toLowerCase() : null;
      const sameKind = (k: string) =>
        parsed.ok && (k === parsed.value.kind || k.split('.').pop() === parsed.value.kind);
      hits = onTask.filter((r) => {
        const c = canonicalRef(r).toLowerCase();
        const rid = r.ref.toLowerCase();
        const url = (r.url || '').toLowerCase();
        if (clipped) {
          return c.startsWith(clipped) || (!!url && url.startsWith(clipped));
        }
        if (
          id &&
          sameKind(r.kind) &&
          (rid === id || rid.endsWith(`#${id}`) || rid.endsWith(`/${id}`))
        ) {
          return true;
        }
        return (
          c === text ||
          rid === text ||
          url === text ||
          shortRefLabel(r.kind, r.ref).toLowerCase() === text ||
          [`:${text}`, `/${text}`, `#${text}`].some((end) => c.endsWith(end)) ||
          (text.startsWith('#') && c.endsWith(text))
        );
      });
    }
    const distinct = Array.from(new Set(hits.map((r) => canonicalRef(r))));
    if (distinct.length === 0) {
      warnings.push(`${title} isn't linked to "${said.trim()}", so there was nothing to remove.`);
      continue;
    }
    if (distinct.length > 1) {
      warnings.push(
        `"${said.trim()}" matches more than one link on ${title} (${distinct.join(', ')}), so I didn't remove any.`
      );
      continue;
    }
    for (const r of hits) {
      add(canonicalRef(r), r.role);
    }
  }
  return out;
}

function taskLabel(after: Record<string, any> | null | undefined, before?: VoiceTask | null) {
  return `"${(after?.project || before?.project || 'that task').toString().trim()}"`;
}

function findTask(ctx: VoiceContext, id: string | undefined, after?: Record<string, any> | null) {
  if (id) {
    const exact = ctx.tasks.find((t) => t.id === id && !t.isDeleted);
    if (exact) {
      return exact;
    }
    const prefix = id.length >= 6 ? ctx.tasks.filter((t) => t.id.startsWith(id)) : [];
    if (prefix.length === 1) {
      return prefix[0];
    }
  }
  if (after?.id && after.id !== id) {
    const byAfterId = ctx.tasks.find((t) => t.id === after.id && !t.isDeleted);
    if (byAfterId) {
      return byAfterId;
    }
  }
  return null;
}

/**
 * Check and enrich the model's proposals. Never throws: anything it can't do safely is
 * dropped or left unresolved, with a plain-English warning.
 */
export function resolveProposals(changes: RawChange[], ctx: VoiceContext): ResolveResult {
  const proposals: ResolvedProposal[] = [];
  const allWarnings: string[] = [];
  const projectById = new Map(ctx.projects.map((p) => [p.id, p]));
  const pendingEpicTitles = changes
    .filter((c) => c.type === 'createEpic' && c.after?.project)
    .map((c) => String(c.after!.project).trim());
  const pendingProjectNames = changes
    .filter((c) => c.type === 'createProject' && c.after?.project)
    .map((c) => String(c.after!.project).trim().toLowerCase());

  for (const change of changes) {
    const warnings: string[] = [];
    const after = change.after ? { ...change.after } : null;
    // Links are checked below and carried on the proposal, not inside the task fields
    const rawRefs = after?.refs;
    const rawRemoveRefs = after?.removeRefs;
    if (after) {
      delete after.refs;
      delete after.removeRefs;
    }
    const base = {
      type: change.type,
      before: null as VoiceTask | null,
      after,
      taskId: null as string | null,
      projectId: null as string | null,
      projectName: null as string | null,
      orgId: null as string | null,
      orgName: null as string | null,
      isNewProject: false,
      assigneeName: null as string | null,
      assigneeChanged: false,
      epicId: null as string | null,
      epicTitle: null as string | null,
      goalId: null as string | null,
    };
    const drop = (message: string) => {
      allWarnings.push(...warnings, message);
    };
    const keep = (p: ResolvedProposal) => {
      p.warnings = warnings;
      allWarnings.push(...warnings);
      proposals.push(p);
    };

    /* ---------- new project (container) ---------- */
    if (change.type === 'createProject') {
      const name = String(after?.project || after?.category || '').trim();
      if (!name) {
        drop("I couldn't tell what the new project should be called, so I left it out.");
        continue;
      }
      const spokenWs = after?.workspace ? String(after.workspace) : '';
      let ws: VoiceWorkspace | null = null;
      if (spokenWs) {
        const hits = bestMatches(spokenWs, ctx.workspaces, (w) => [w.name]);
        ws = hits[0] ?? null;
        if (!ws) {
          warnings.push(`There's no "${spokenWs}" workspace, so I put it in your personal one.`);
        }
      }
      ws = ws ?? personalWorkspace(ctx);
      if (ws && !ws.canEdit) {
        drop(
          `You have view-only access to the ${ws.name} workspace, so I didn't add the "${name}" project.`
        );
        continue;
      }
      const clash = ws?.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (clash) {
        drop(`There's already a "${clash.name}" project in ${ws!.name}, so I didn't add another.`);
        continue;
      }
      keep({
        ...base,
        after: { ...(after || {}), project: name },
        projectName: name,
        orgId: ws?.id ?? null,
        orgName: ws?.name ?? null,
        isNewProject: true,
        warnings: [],
      });
      continue;
    }

    /* ---------- existing task: update, delete, claim ---------- */
    let before: VoiceTask | null = null;
    if (change.type === 'update' || change.type === 'delete' || change.type === 'claim') {
      before = findTask(ctx, change.projectId, after);
      if (!before) {
        drop(
          `I couldn't find the task ${taskLabel(after)} in the selected task sample, so I left that change out. Mention a listed task title or id instead.`
        );
        continue;
      }
      const current = before.projectId ? projectById.get(before.projectId) : undefined;
      if (current && !canEdit(current.role)) {
        drop(
          `You have view-only access to "${current.name}", so I can't change ${taskLabel(null, before)}.`
        );
        continue;
      }
      base.before = before;
      base.taskId = before.id;
      base.projectId = before.projectId ?? null;
      base.projectName = current?.name ?? before.projectName ?? before.category ?? null;
      base.orgId = current?.orgId ?? before.orgId ?? null;
      base.orgName = current?.orgName ?? before.orgName ?? null;
      base.assigneeName = before.assigneeName ?? null;
      base.epicId = before.epicId ?? null;
      base.epicTitle = before.epicId
        ? (ctx.epics.find((e) => e.id === before!.epicId)?.title ?? null)
        : null;
      base.goalId = before.goalId ?? null;
    }

    if (change.type === 'delete') {
      keep({ ...base, after: null, warnings: [] });
      continue;
    }

    if (change.type === 'claim') {
      const ws = workspaceFor(ctx, base.orgId);
      if (ws && !ws.members.some((m) => m.userId === ctx.me.id)) {
        drop(
          `You aren't in the ${ws.name} workspace, so you can't claim ${taskLabel(null, before)}.`
        );
        continue;
      }
      if (before!.assigneeId === ctx.me.id) {
        drop(`${taskLabel(null, before)} is already yours.`);
        continue;
      }
      if (before!.assigneeId && before!.assigneeName) {
        warnings.push(
          `${taskLabel(null, before)} is assigned to ${before!.assigneeName} at the moment.`
        );
      }
      keep({
        ...base,
        after: { ...before, ...(after || {}), id: before!.id, assignee: 'me' },
        assigneeId: ctx.me.id,
        assigneeName: ctx.me.name,
        assigneeChanged: true,
        warnings: [],
      });
      continue;
    }

    /* ---------- create, update, createEpic: where does it go? ---------- */
    const spokenCategory: string | null = after?.category ? String(after.category) : null;
    const spokenKey: string | null =
      after?.projectId && after.projectId !== before?.projectId ? String(after.projectId) : null;
    const assigneeHint: string | null = after?.assignee ? String(after.assignee) : null;
    const wantsMove =
      change.type === 'update' &&
      !!before &&
      ((spokenKey && spokenKey !== before.projectId) ||
        (spokenCategory &&
          norm(spokenCategory) !== norm(base.projectName || before.category || '')));

    let targetProject: AccessibleProject | null =
      change.type === 'update' && base.projectId ? (projectById.get(base.projectId) ?? null) : null;
    let isNewProject = false;
    let newProjectName: string | null = null;
    let targetWorkspace: VoiceWorkspace | null = workspaceFor(ctx, base.orgId);

    if (change.type !== 'update' || wantsMove) {
      const target = resolveProjectTarget(ctx, spokenCategory, spokenKey, assigneeHint, warnings);
      const what =
        change.type === 'createEpic'
          ? `the "${after?.project ?? ''}" epic`
          : taskLabel(after, before);
      if (target.kind === 'viewOnly') {
        drop(`You have view-only access to "${target.project.name}", so I left out ${what}.`);
        continue;
      }
      if (target.kind === 'project') {
        targetProject = target.project;
        targetWorkspace = workspaceFor(ctx, target.project.orgId);
      } else if (target.kind === 'new') {
        isNewProject = true;
        newProjectName = target.name;
        targetProject = null;
        targetWorkspace = target.workspace;
        if (!pendingProjectNames.includes(target.name.toLowerCase())) {
          warnings.push(
            `There's no "${target.name}" project yet, so applying ${what} will create it in your personal workspace.`
          );
        }
      } else if (change.type !== 'update') {
        // No project mentioned: the API files it under General in the personal workspace
        const general = ctx.projects.find(
          (p) => p.name.toLowerCase() === 'general' && canEdit(p.role) && p.orgIsPersonal
        );
        if (general) {
          targetProject = general;
          targetWorkspace = workspaceFor(ctx, general.orgId);
        } else {
          isNewProject = true;
          newProjectName = 'General';
          targetWorkspace = personalWorkspace(ctx);
        }
      }
    }

    const projectId = targetProject?.id ?? null;
    const projectName = targetProject?.name ?? newProjectName ?? base.projectName;
    const orgId = targetProject?.orgId ?? targetWorkspace?.id ?? null;
    const orgName = targetProject?.orgName ?? targetWorkspace?.name ?? null;

    if (change.type === 'createEpic') {
      const title = String(after?.project || '').trim();
      if (!title) {
        drop("I couldn't tell what the new epic should be called, so I left it out.");
        continue;
      }
      keep({
        ...base,
        after: { ...(after || {}), project: title, category: projectName },
        projectId,
        projectName,
        orgId,
        orgName,
        isNewProject,
        warnings: [],
      });
      continue;
    }

    /* ---------- assignee ---------- */
    let assignee: AssigneeOutcome;
    if (change.type === 'create') {
      assignee = resolveAssignee(
        ctx,
        assigneeHint,
        targetWorkspace,
        { assigneeId: null, assigneeName: null, label: 'left it unassigned' },
        warnings
      );
      if (!assigneeHint) {
        // The API assigns new tasks to their creator
        assignee = { assigneeId: ctx.me.id, assigneeName: ctx.me.name };
      }
    } else {
      const keepCurrent = {
        assigneeId: undefined,
        assigneeName: before!.assigneeName ?? null,
        label: "didn't change who it's assigned to",
      };
      // The model often echoes the task's current assignee back: that isn't a request
      const requestedMatch = assigneeHint
        ? matchPerson(
            assigneeHint,
            [...(targetWorkspace?.members ?? []), ...(targetWorkspace?.bots ?? [])],
            ctx.me.id
          )
        : null;
      const echoed =
        !!assigneeHint &&
        requestedMatch?.kind !== 'bot' &&
        [before!.assigneeName ?? 'unassigned', 'someone'].some(
          (n) => norm(n) === norm(assigneeHint)
        );
      assignee = resolveAssignee(
        ctx,
        echoed ? null : assigneeHint,
        targetWorkspace,
        keepCurrent,
        warnings
      );
      // Moving to another workspace: the current assignee has to be a member there too
      if (
        assignee.assigneeId === undefined &&
        before!.assigneeId &&
        targetWorkspace &&
        orgId !== base.orgId &&
        !targetWorkspace.members.some((m) => m.userId === before!.assigneeId)
      ) {
        warnings.push(
          `${before!.assigneeName ?? 'The current assignee'} isn't in the ${targetWorkspace.name} workspace, so moving it there leaves it unassigned.`
        );
        assignee = { assigneeId: null, assigneeName: null };
      }
      if (
        assignee.assigneeId !== undefined &&
        assignee.assigneeId === (before!.assigneeId ?? null)
      ) {
        assignee = { assigneeId: undefined, assigneeName: before!.assigneeName ?? null };
      }
    }

    /* ---------- epic and goal ---------- */
    const epicChanged =
      after?.epicTitle && norm(String(after.epicTitle)) !== norm(base.epicTitle || '');
    const epic =
      change.type === 'create' || epicChanged
        ? resolveEpic(ctx, after?.epicTitle, projectId, projectName, pendingEpicTitles, warnings)
        : { epicId: base.epicId, epicTitle: base.epicTitle };
    const goalId =
      after?.goalTitle !== undefined && after?.goalTitle !== null
        ? resolveGoal(ctx, after.goalTitle, warnings)
        : base.goalId;

    // The model saw clipped notes: if it echoed them back, keep the full text
    if (after && before) {
      for (const field of ['notes', 'reason'] as const) {
        const full = before[field];
        const echoed = after[field];
        if (
          typeof full === 'string' &&
          typeof echoed === 'string' &&
          echoed !== full &&
          echoed.endsWith('...') &&
          full.startsWith(echoed.slice(0, -3))
        ) {
          after[field] = full;
        }
      }
    }

    /* ---------- links ---------- */
    const refs = resolveRefAdds(ctx, rawRefs, orgId, orgName ?? 'your personal', before, warnings);
    const removeRefs =
      change.type === 'update' && before
        ? resolveRefRemovals(rawRemoveRefs, before, taskLabel(after, before), warnings)
        : [];

    const resolvedAfter = {
      ...(after || {}),
      category: projectName,
      projectId: projectId ?? undefined,
      projectName,
      orgName,
      ...(assignee.assigneeId !== undefined ? { assigneeId: assignee.assigneeId } : {}),
      assigneeName: assignee.assigneeName,
      epicId: epic.epicId,
      epicTitle: epic.epicTitle,
      goalId,
    };

    keep({
      ...base,
      after: resolvedAfter,
      projectId,
      projectName,
      orgId,
      orgName,
      isNewProject,
      assigneeId: assignee.assigneeId,
      assigneeName: assignee.assigneeName,
      assigneeChanged: change.type === 'create' ? true : assignee.assigneeId !== undefined,
      epicId: epic.epicId,
      epicTitle: epic.epicTitle,
      goalId,
      ...(refs.length ? { refs } : {}),
      ...(removeRefs.length ? { removeRefs } : {}),
      warnings: [],
    });
  }

  return { proposals, warnings: Array.from(new Set(allWarnings)) };
}

/* ------------------------------------------------------------------ likely duplicates */

/** New tasks checked per voice command: one similar-task query each */
export const SIMILAR_LOOKUPS_PER_COMMAND = 5;
/** Existing tasks offered per new task */
const SIMILAR_PER_CREATE = 3;

/**
 * Look for open tasks like each proposed new task, in the workspace it would land in, and put
 * them on the proposal as `similar`. Only the first few creates are checked, in parallel. Never
 * throws: a lookup that fails only means that proposal has no hint.
 */
export async function addSimilarTasks(
  proposals: ResolvedProposal[],
  ctx: VoiceContext
): Promise<void> {
  const findSimilar = ctx.findSimilar;
  if (!findSimilar) {
    return;
  }
  const creates = proposals
    .filter(
      (p) =>
        p.type === 'create' &&
        typeof p.after?.project === 'string' &&
        p.after.project.trim() &&
        (p.projectId || p.orgId)
    )
    .slice(0, SIMILAR_LOOKUPS_PER_COMMAND);

  await Promise.all(
    creates.map(async (p) => {
      // A project that doesn't exist yet: search the workspace it will be made in
      const scope = p.projectId ? { projectId: p.projectId } : { orgId: p.orgId! };
      try {
        const similar = await findSimilar({
          title: String(p.after!.project).trim(),
          ...scope,
          limit: SIMILAR_PER_CREATE,
        });
        if (similar.length > 0) {
          p.similar = similar;
        }
      } catch (error) {
        console.warn('Similar-task lookup for a voice create failed:', error);
      }
    })
  );
}
