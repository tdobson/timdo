/**
 * Apply one reviewed voice change through the API, using the ids the server resolved
 * (projectId, assigneeId, epicId). Failures throw VoiceApplyError with the API's own
 * message, e.g. `You have view-only access to "Acme Solar"`.
 *
 * Proposed links (refs) are added with a new task in the create request. For updates and notes,
 * link changes still go through the refs endpoints once the task change has succeeded.
 *
 * A new task the server found `similar` open tasks for can instead be added as a note on one of
 * them (applyAsNote), with its links going to that task.
 */
import type {
  VoiceProposal,
  VoiceRefAdd,
  VoiceRefRemove,
  VoiceSimilarTask,
} from '../../../components/VoiceCommand/voiceTypes';
import { apiFetch } from '../../lib/apiClient';
import { getWorkerApiBaseUrl } from '../../lib/apiConfig';

export class VoiceApplyError extends Error {
  status: number;
  existingTask: VoiceSimilarTask | null;

  constructor(message: string, status: number, existingTask: VoiceSimilarTask | null = null) {
    super(message);
    this.status = status;
    this.existingTask = existingTask;
  }
}

/** Ids created earlier in the same review, so later changes can link to them. */
export interface ApplySession {
  epicIdsByTitle: Record<string, string>;
  projectIdsByName: Record<string, string>;
}

export const newApplySession = (): ApplySession => ({ epicIdsByTitle: {}, projectIdsByName: {} });

export interface ApplyOutcome {
  /** Short line for the success notification */
  message: string;
  /** Links that couldn't be added or removed, one sentence each */
  problems: string[];
}

export type { VoiceRefAdd, VoiceRefRemove, VoiceSimilarTask };

/** Kept for callers written before VoiceProposal carried refs; the same type now. */
export type VoiceProposalWithRefs = VoiceProposal;

/** A proposal with the likely duplicates the server found (create only). */
export type VoiceProposalWithSimilar = VoiceProposal;

/** The open tasks a new task looks like, best first; empty for every other change. */
export function similarOf(change: VoiceProposalWithSimilar): VoiceSimilarTask[] {
  const { similar } = change;
  if (change.type !== 'create' || !Array.isArray(similar)) {
    return [];
  }
  return similar.filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string');
}

/** What a new task becomes as a note: its title, then its reason and notes, a line each. */
export function noteTextFor(change: VoiceProposal): string {
  const after = change.after;
  return [after?.project, after?.reason, after?.notes]
    .map((text) => (typeof text === 'string' ? text.trim() : ''))
    .filter(Boolean)
    .join('\n');
}

/** The links a change adds and removes (none for other change types). */
export function refChangesOf(change: VoiceProposal): {
  add: VoiceRefAdd[];
  remove: VoiceRefRemove[];
} {
  const { refs, removeRefs } = change;
  if (change.type !== 'create' && change.type !== 'update') {
    return { add: [], remove: [] };
  }
  return {
    add: Array.isArray(refs) ? refs : [],
    remove: change.type === 'update' && Array.isArray(removeRefs) ? removeRefs : [],
  };
}

const key = (s: string) => s.trim().toLowerCase();

/** Drop null and undefined so the API's optional fields validate. */
function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

// A canonical ref already contains its kind; preserve metadata without sending kind twice.
function refPayload({ ref, role, url, label }: VoiceRefAdd) {
  return clean({ ref, role, url, label });
}

function inThirtyDays() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

function existingTaskFrom(payload: unknown, taskId?: unknown): VoiceSimilarTask | null {
  const task = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const id = typeof task.id === 'string' ? task.id : typeof taskId === 'string' ? taskId : null;
  if (!id) {
    return null;
  }
  const title =
    typeof task.project === 'string'
      ? task.project
      : typeof task.title === 'string'
        ? task.title
        : 'Existing task';
  return {
    id,
    shortId: typeof task.shortId === 'string' ? task.shortId : id.slice(0, 8),
    title,
    ...(typeof task.projectName === 'string' || task.projectName === null
      ? { projectName: task.projectName }
      : {}),
    ...(typeof task.orgName === 'string' || task.orgName === null ? { orgName: task.orgName } : {}),
    ...(typeof task.canEdit === 'boolean' ? { canEdit: task.canEdit } : {}),
  };
}

async function readError(response: Response, fallback: string): Promise<VoiceApplyError> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    taskId?: unknown;
    task?: unknown;
  } | null;
  const existingTask = existingTaskFrom(body?.task, body?.taskId);
  const text =
    typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : null;
  if (text) {
    return new VoiceApplyError(text, response.status, existingTask);
  }
  if (response.status === 400) {
    return new VoiceApplyError(`${fallback}: some of the details weren't valid.`, 400);
  }
  if (response.status === 403) {
    return new VoiceApplyError("You don't have permission to do that.", 403);
  }
  if (response.status === 404) {
    return new VoiceApplyError("That task isn't there any more, or you can't see it.", 404);
  }
  return new VoiceApplyError(fallback, response.status, existingTask);
}

async function send(
  token: string,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  fallback: string
) {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw await readError(response, fallback);
  }
  return response.json().catch(() => ({}));
}

const links = (n: number) => `${n} ${n === 1 ? 'link' : 'links'}`;

/** " (2 links added, 1 removed)" for the success line */
function linkNote(added: number, removed: number) {
  if (added && removed) {
    return ` (${links(added)} added, ${removed} removed)`;
  }
  if (added) {
    return ` (${links(added)} added)`;
  }
  return removed ? ` (${links(removed)} removed)` : '';
}

/** Removals first (so a replaced source is free again), then additions, one call each. */
async function applyRefs(
  token: string,
  taskId: string,
  add: VoiceRefAdd[],
  remove: VoiceRefRemove[]
) {
  let added = 0;
  let removed = 0;
  const problems: string[] = [];
  const explain = (ref: string, error: unknown, what: string) => {
    const message = error instanceof Error ? error.message : 'something went wrong';
    problems.push(message.includes(ref) ? message : `${what} ${ref}: ${message}`);
  };
  for (const r of remove) {
    const query = new URLSearchParams({ ref: r.ref, ...(r.role ? { role: r.role } : {}) });
    try {
      await send(
        token,
        'DELETE',
        `/tasks/${taskId}/refs?${query.toString()}`,
        undefined,
        `Couldn't remove ${r.ref}`
      );
      removed += 1;
    } catch (error) {
      // Already gone is what was asked for
      if (!(error instanceof VoiceApplyError && error.status === 404)) {
        explain(r.ref, error, "Couldn't remove");
      }
    }
  }
  for (const r of add) {
    try {
      await send(token, 'POST', `/tasks/${taskId}/refs`, refPayload(r), `Couldn't link ${r.ref}`);
      added += 1;
    } catch (error) {
      explain(r.ref, error, "Couldn't link");
    }
  }
  return { note: linkNote(added, removed), problems };
}

/**
 * Add a proposed new task to an existing one as a note instead of creating it. Its ticked links
 * go to that task too. Nothing is created: no task, project or epic.
 */
export async function applyAsNote(
  change: VoiceProposal,
  target: VoiceSimilarTask,
  token: string
): Promise<ApplyOutcome> {
  const note = noteTextFor(change);
  if (!note) {
    throw new VoiceApplyError('There is nothing to add as a note.', 400);
  }
  try {
    await send(
      token,
      'POST',
      `/projects/${target.id}/updates`,
      { note },
      `Couldn't add a note to "${target.title}"`
    );
  } catch (error) {
    // The notes endpoint answers 404 for a task that's gone and for one you can only view
    if (error instanceof VoiceApplyError && error.status === 404) {
      throw new VoiceApplyError(
        `"${target.title}" isn't there any more, or you can't add notes to it.`,
        404
      );
    }
    throw error;
  }
  const { add } = refChangesOf(change);
  const linked = add.length
    ? await applyRefs(token, target.id, add, [])
    : { note: '', problems: [] as string[] };
  return {
    message: `Added a note to "${target.title}"${linked.note}`,
    problems: linked.problems,
  };
}

/** Where a change lands: an id when known, else the project name (the API then creates it). */
function placement(change: VoiceProposal, session: ApplySession) {
  if (change.projectId) {
    return { projectId: change.projectId };
  }
  const name = change.projectName || change.after?.category || undefined;
  if (name && session.projectIdsByName[key(name)]) {
    return { projectId: session.projectIdsByName[key(name)] };
  }
  return name ? { category: name } : {};
}

function epicFor(change: VoiceProposal, session: ApplySession) {
  if (change.epicId) {
    return change.epicId;
  }
  if (change.epicTitle) {
    return session.epicIdsByTitle[key(change.epicTitle)];
  }
  return undefined;
}

function where(change: VoiceProposal) {
  return change.projectName ? ` in ${change.projectName}` : '';
}

export async function applyVoiceChange(
  change: VoiceProposal,
  token: string,
  session: ApplySession,
  meId?: string | null
): Promise<ApplyOutcome> {
  const after = change.after;
  const taskId = change.taskId || change.before?.id;

  switch (change.type) {
    case 'createProject': {
      const name = (after?.project || change.projectName || '').trim();
      if (!change.orgId) {
        throw new VoiceApplyError('There is no workspace to add this project to.', 400);
      }
      const created = (await send(
        token,
        'POST',
        `/organisations/${change.orgId}/projects`,
        clean({ name, description: after?.notes || after?.reason }),
        `Couldn't add the "${name}" project`
      )) as { id?: string };
      if (created?.id) {
        session.projectIdsByName[key(name)] = created.id;
      }
      return {
        message: `Added the ${name} project to ${change.orgName ?? 'your workspace'}`,
        problems: [],
      };
    }

    case 'createEpic': {
      const title = (after?.project || '').trim();
      const created = (await send(
        token,
        'POST',
        '/epics',
        clean({
          title,
          description: after?.notes || after?.reason,
          status: 'active',
          ...placement(change, session),
        }),
        `Couldn't add the "${title}" epic`
      )) as { id?: string };
      if (created?.id) {
        session.epicIdsByTitle[key(title)] = created.id;
      }
      return { message: `Added the "${title}" epic${where(change)}`, problems: [] };
    }

    case 'create': {
      if (!after) {
        throw new VoiceApplyError('This change has no task details.', 400);
      }
      const status = after.status ?? 'do';
      const { add } = refChangesOf(change);
      const body = clean({
        project: after.project,
        reason: after.reason,
        status,
        priority: Math.min(10, Math.max(1, Math.round(after.priority ?? 5))),
        size: after.size ?? '***',
        notes: after.notes,
        awaitUntil: status === 'awaiting' ? after.awaitUntil || inThirtyDays() : undefined,
        customer: after.customer,
        tags: after.tags,
        epicId: epicFor(change, session),
        goalId: change.goalId,
        refs: add.length ? add.map(refPayload) : undefined,
        ...placement(change, session),
      });
      // null is meaningful here (unassigned), so add it after cleaning
      const payload =
        change.assigneeId !== undefined ? { ...body, assigneeId: change.assigneeId } : body;
      const created = (await send(
        token,
        'POST',
        '/projects',
        payload,
        `Couldn't add "${after.project}"`
      )) as { id?: string; created?: boolean } & Record<string, unknown>;
      if (created?.created === false) {
        const existingTask = existingTaskFrom(created);
        const source = add.find((ref) => ref.role === 'source');
        const message = existingTask
          ? source
            ? `${source.ref} is already the source of ${existingTask.shortId} "${existingTask.title}". No new task was created.`
            : `The request returned the existing task "${existingTask.title}". No new task was created.`
          : source
            ? `${source.ref} is already the source of an existing task. No new task was created.`
            : 'The request returned an existing task. No new task was created.';
        throw new VoiceApplyError(message, 409, existingTask);
      }
      const forWhom =
        change.assigneeId && change.assigneeId !== meId && change.assigneeName
          ? ` for ${change.assigneeName}`
          : '';
      return {
        message: `Added "${after.project}"${where(change)}${forWhom}${linkNote(add.length, 0)}`,
        problems: [],
      };
    }

    case 'update': {
      if (!after || !taskId) {
        throw new VoiceApplyError('This change has no task to update.', 400);
      }
      const before = change.before;
      const status = after.status ?? before?.status;
      const moved = !!change.projectId && change.projectId !== before?.projectId;
      const proposed = clean({
        project: after.project,
        reason: after.reason,
        status,
        priority:
          after.priority !== undefined
            ? Math.min(10, Math.max(1, Math.round(after.priority)))
            : undefined,
        size: after.size,
        notes: after.notes,
        customer: after.customer,
        tags: after.tags,
      });
      // Send only what changed, so the activity log shows the real edit
      const body: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(proposed)) {
        if (!before || (before as unknown as Record<string, unknown>)[field] !== value) {
          body[field] = value;
        }
      }
      if (status === 'awaiting') {
        const awaitUntil = after.awaitUntil || before?.awaitUntil || inThirtyDays();
        if (awaitUntil !== before?.awaitUntil || before?.status !== 'awaiting') {
          body.awaitUntil = awaitUntil;
          body.status = 'awaiting';
        }
      }
      if (moved) {
        body.projectId = change.projectId;
      } else if (!change.projectId && change.isNewProject) {
        Object.assign(body, placement(change, session));
      }
      if (change.assigneeId !== undefined) {
        body.assigneeId = change.assigneeId;
      }
      const epicId = epicFor(change, session);
      if (epicId && epicId !== before?.epicId) {
        body.epicId = epicId;
      }
      if (change.goalId && change.goalId !== before?.goalId) {
        body.goalId = change.goalId;
      }
      const title = after.project || before?.project || 'the task';
      const { add, remove } = refChangesOf(change);
      const hasFields = Object.keys(body).length > 0;
      if (!hasFields && add.length === 0 && remove.length === 0) {
        return { message: `"${title}" was already up to date`, problems: [] };
      }
      if (hasFields) {
        await send(token, 'PUT', `/projects/${taskId}`, body, `Couldn't update "${title}"`);
      }
      const linked = await applyRefs(token, taskId, add, remove);
      return {
        message: `${hasFields ? 'Updated' : 'Updated the links on'} "${title}"${linked.note}`,
        problems: linked.problems,
      };
    }

    case 'claim': {
      if (!taskId) {
        throw new VoiceApplyError('This change has no task to claim.', 400);
      }
      const assigneeId = change.assigneeId ?? meId;
      if (!assigneeId) {
        throw new VoiceApplyError("Couldn't work out who you are. Try again.", 400);
      }
      const title = change.before?.project ?? after?.project ?? 'the task';
      await send(token, 'PUT', `/projects/${taskId}`, { assigneeId }, `Couldn't claim "${title}"`);
      return { message: `"${title}" is yours now`, problems: [] };
    }

    case 'delete': {
      if (!taskId) {
        throw new VoiceApplyError('This change has no task to delete.', 400);
      }
      const title = change.before?.project ?? 'the task';
      await send(token, 'DELETE', `/projects/${taskId}`, undefined, `Couldn't delete "${title}"`);
      return { message: `Deleted "${title}"`, problems: [] };
    }

    default:
      throw new VoiceApplyError("TimDo doesn't know how to apply that change.", 400);
  }
}
