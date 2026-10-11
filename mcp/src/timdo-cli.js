import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** bin/timdo in this repository, found relative to this file (mcp/src/ -> ../../bin/timdo). */
export const DEFAULT_TIMDO_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/timdo');

/**
 * Locate the timdo executable: $TIMDO_BIN if set, else this repo's bin/timdo, else "timdo" on PATH.
 */
export function getTimdoBinaryPath(env = process.env) {
  if (env.TIMDO_BIN) return env.TIMDO_BIN;
  if (existsSync(DEFAULT_TIMDO_BIN)) return DEFAULT_TIMDO_BIN;
  return 'timdo';
}

/**
 * Execute bin/timdo with arguments and parse JSON stdout.
 * options.asUser: act as another TimDo account by email (sets TIMDO_AS, which the
 * CLI sends as X-Timdo-User). Only the account owner's secret can act as someone
 * else; with a personal token (bin/timdo login) the API refuses any other email.
 * Leave it out to act as whoever the CLI is signed in as.
 */
export async function runTimdoCli(subcommandArgs, binPath = getTimdoBinaryPath(), options = {}) {
  // "--" ends bin/timdo's global flags, so a value that looks like one (a ref or title of
  // "--as=someone@example.com") reaches the subcommand as data and cannot switch the user
  const isBotCommand = subcommandArgs[0] === 'bot';
  if (options.ownerSecret === true && !isBotCommand) {
    throw new Error('ownerSecret is available for bot-management commands only.');
  }
  const protectedArgs = [...subcommandArgs];
  if (options.ownerSecret === true) protectedArgs.splice(1, 0, '--owner-secret');
  const fullArgs = ['--json', '--', ...protectedArgs];
  const env = { ...process.env };
  if (options.asUser) env.TIMDO_AS = String(options.asUser);
  try {
    const { stdout } = await execFileAsync(binPath || getTimdoBinaryPath(), fullArgs, {
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { success: true };
    }
    return JSON.parse(trimmed);
  } catch (error) {
    const stderr = error.stderr ? error.stderr.trim() : '';
    const message = stderr || error.message || 'Unknown timdo CLI error';
    throw new Error(`timdo CLI error: ${message}`);
  }
}

/**
 * Refs: links from a task to things outside TimDo, given as a URL or kind:id.
 * Roles are link (default), source, reported_by and about; "reported-by" and "Reported by" are
 * accepted too, as the API does.
 */
export const REF_ROLES = ['link', 'source', 'reported_by', 'about'];
const ROLE_FLAGS = { link: '--ref', source: '--source', reported_by: '--reported-by', about: '--about' };
const ROLE_ERROR = 'Role must be link, source, reported_by or about.';
const REF_NEEDED = 'Each ref needs "ref": a URL or kind:id, e.g. github.issue:acme/widgets#12 or forum.post:4411.';

const NO_DASH = 'Refs never start with "-": give a URL, kind:id or ref id.';

/** A ref, removal or ref id must not look like a CLI flag (they come from outside text). */
function notAFlag(value, message = NO_DASH) {
  if (String(value).trim().startsWith('-')) throw new Error(message);
  return value;
}

export function normaliseRefRole(role) {
  if (role === undefined || role === null || String(role).trim() === '') return 'link';
  const r = String(role).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!REF_ROLES.includes(r)) throw new Error(ROLE_ERROR);
  return r;
}

/**
 * Accept refs the way an agent is likely to send them: an array of { ref, role?, label?, kind?, url? },
 * an array of plain strings, one string, or a JSON string of either.
 */
export function normaliseRefs(refs) {
  if (refs === undefined || refs === null || refs === '') return [];
  let list = refs;
  if (typeof list === 'string') {
    try {
      const parsed = JSON.parse(list);
      list = parsed !== null && typeof parsed === 'object' ? parsed : list;
    } catch {
      // Not JSON: a single URL or kind:id
    }
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((item) => {
    const r = typeof item === 'string' ? { ref: item } : item;
    if (!r || typeof r !== 'object' || typeof r.ref !== 'string' || !r.ref.trim()) throw new Error(REF_NEEDED);
    notAFlag(r.ref);
    return r;
  });
}

/**
 * CLI flags for refs on add/update. Plain refs use --ref/--source/--reported-by/--about;
 * refs with a label, kind or url go together as one --refs-json array.
 */
export function buildRefFlags(refs) {
  const args = [];
  const rich = [];
  for (const r of normaliseRefs(refs)) {
    const role = normaliseRefRole(r.role);
    if (r.label || r.kind || r.url) {
      rich.push({
        ref: r.ref,
        role,
        ...(r.label ? { label: String(r.label) } : {}),
        ...(r.kind ? { kind: String(r.kind) } : {}),
        ...(r.url ? { url: String(r.url) } : {}),
      });
    } else {
      args.push(ROLE_FLAGS[role], r.ref);
    }
  }
  if (rich.length) args.push('--refs-json', JSON.stringify(rich));
  return args;
}

/** --unref flags for refs to remove (URL, kind:id or ref id). */
export function buildUnrefFlags(removeRefs) {
  if (removeRefs === undefined || removeRefs === null || removeRefs === '') return [];
  const list = Array.isArray(removeRefs) ? removeRefs : [removeRefs];
  return list.flatMap((x) => {
    if (typeof x !== 'string' || !x.trim()) throw new Error('Each entry in removeRefs is a URL, kind:id or ref id.');
    return ['--unref', notAFlag(x)];
  });
}

export function buildAddRefArgs({ id, ref, role, label, kind, url } = {}) {
  if (!id) throw new Error('Task id is required.');
  if (!ref) throw new Error(REF_NEEDED);
  notAFlag(id, 'Task ids never start with "-".');
  notAFlag(ref);
  const args = ['ref', 'add', id, ref];
  if (role !== undefined && role !== null && role !== '') args.push('--role', normaliseRefRole(role));
  if (label) args.push('--label', notAFlag(label, 'Labels cannot start with "-".'));
  if (kind) args.push('--kind', notAFlag(kind, 'Kinds are lowercase letters, digits and dots, e.g. acme.member.'));
  if (url) args.push('--url', notAFlag(url, 'The url must start with http:// or https://.'));
  return args;
}

export function buildRemoveRefArgs({ id, ref, role } = {}) {
  if (!id) throw new Error('Task id is required.');
  if (!ref) throw new Error('Say which ref to remove: its URL, kind:id or id.');
  notAFlag(id, 'Task ids never start with "-".');
  notAFlag(ref);
  const args = ['ref', 'rm', id, ref];
  if (role !== undefined && role !== null && role !== '') args.push('--role', normaliseRefRole(role));
  return args;
}

export function buildFindByRefArgs({ ref, role } = {}) {
  if (!ref) throw new Error(REF_NEEDED);
  const args = ['find', notAFlag(ref)];
  if (role !== undefined && role !== null && role !== '') args.push('--role', normaliseRefRole(role));
  return args;
}

const TASK_GROUPS = ['project', 'epic', 'assignee'];
const TASK_FIELDS = ['summary', 'full'];
const TASK_STATUSES = ['do', 'delay', 'awaiting', 'delegate', 'done'];

function taskStatusArg(value, fallback) {
  const selected = value === undefined || value === null ? fallback : value;
  if (typeof selected !== 'string' || selected.length === 0) {
    throw new Error('status must be all or a comma-separated list of do, delay, awaiting, delegate and done.');
  }
  if (selected === 'all') return 'all';
  const statuses = selected.split(',');
  if (statuses.some((status) => !TASK_STATUSES.includes(status))) {
    throw new Error('status must be all or a comma-separated list of do, delay, awaiting, delegate and done.');
  }
  return statuses.join(',');
}

function pageLimitArg(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error('limit must be a whole number from 1 to 200.');
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be a whole number from 1 to 200.');
  }
  return String(limit);
}

function cursorArg(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('cursor must be a URL-safe page cursor of at most 4096 characters.');
  }
  return value;
}

/** Build CLI arguments for membership filters shared by lists and counts. */
function taskListFilterArgs({
  status,
  category,
  epic,
  goal,
  customer,
  tag,
  relatedTo,
  noEpic,
  noGoal,
  noCategory,
  unlinked,
  assignee,
  workspace,
  projectId,
  mine,
  unassigned,
  shared,
  ref,
} = {}) {
  const selectedStatus = taskStatusArg(status, ref ? 'all' : 'do');
  const args = [];
  if (selectedStatus.includes(',')) args.push('--status', selectedStatus);
  else args.push(selectedStatus);
  if (category) args.push('-p', category);
  if (epic) args.push('-e', epic);
  if (goal) args.push('-g', goal);
  if (customer) args.push('--customer', customer);
  if (tag) args.push('--tag', tag);
  if (relatedTo) args.push('--related-to', relatedTo);
  if (noEpic) args.push('--no-epic');
  if (noGoal) args.push('--no-goal');
  if (noCategory) args.push('--no-category');
  if (unlinked) args.push('--unlinked', unlinked);
  if (workspace) args.push('--workspace', workspace);
  if (projectId) args.push('--project-id', projectId);
  if (assignee) args.push('--assignee', assignee);
  else if (mine) args.push('--mine');
  else if (unassigned) args.push('--unassigned');
  if (shared) args.push('--shared');
  if (ref) args.push('--ref', notAFlag(ref));
  return args;
}

/**
 * Build CLI arguments for task listing. Pagination is opt-in so existing CLI callers
 * keep the unlimited full-body response unless they request otherwise.
 */
export function buildListTasksArgs({ limit, cursor, groupBy, fields, ...filters } = {}) {
  const args = ['list', ...taskListFilterArgs(filters)];
  if (limit !== undefined && limit !== null) args.push('--limit', pageLimitArg(limit));
  if (cursor !== undefined && cursor !== null) {
    if (limit === undefined || limit === null) throw new Error('cursor requires limit.');
    args.push('--cursor', cursorArg(cursor));
  }
  if (groupBy !== undefined && groupBy !== null) {
    if (!TASK_GROUPS.includes(groupBy)) throw new Error('groupBy must be project, epic or assignee.');
    args.push('--group-by', groupBy);
  }
  if (fields !== undefined && fields !== null) {
    if (!TASK_FIELDS.includes(fields)) throw new Error('fields must be summary or full.');
    args.push('--fields', fields);
  }
  return args;
}

/** Build CLI arguments for aggregate counts with the task-list membership filters. */
export function buildCountsArgs(filters = {}) {
  const status = filters.status === undefined || filters.status === null ? 'all' : filters.status;
  const args = taskListFilterArgs({ ...filters, status });
  return ['counts', ...args];
}

/**
 * Build CLI arguments for alignment & hygiene audit.
 */
export function buildAuditArgs({ all } = {}) {
  return all ? ['audit', '--all'] : ['audit'];
}

/**
 * Build CLI arguments for task creation.
 */
export function buildAddTaskArgs({
  project,
  reason,
  status,
  priority,
  size,
  category,
  epic,
  goal,
  customer,
  tags,
  linkTaskId,
  linkType,
  awaitUntil,
  thread,
  notes,
  projectId,
  assignTo,
  refs,
  onDuplicate,
} = {}) {
  if (!project) throw new Error('Task title (project) is required.');
  const args = ['add', '--title', project];
  if (reason) args.push('-r', reason);
  if (status) args.push('-s', status);
  if (priority !== undefined) args.push('--priority', String(priority));
  if (size) args.push('--size', size);
  if (category) args.push('-p', category);
  if (epic) args.push('-e', epic);
  if (goal) args.push('-g', goal);
  if (customer) args.push('--customer', customer);
  if (tags) args.push('--tags', Array.isArray(tags) ? tags.join(',') : tags);
  if (awaitUntil) args.push('--await-until', awaitUntil);
  if (thread) args.push('--thread', thread);
  if (notes) args.push('-n', notes);
  if (projectId) args.push('--project-id', projectId);
  if (assignTo) args.push('--assign', assignTo);
  args.push(...buildRefFlags(refs));
  if (onDuplicate !== undefined && onDuplicate !== null && onDuplicate !== '') {
    args.push('--on-duplicate', normaliseOnDuplicate(onDuplicate));
  }
  return args;
}

/**
 * What a create does when its source ref is already the source of a task in that workspace:
 * error (the default: fail and name it), return (hand back that task) or report (add this
 * report to that task). Same values as the API's onDuplicate.
 */
export const ON_DUPLICATE = ['error', 'return', 'report'];

export function normaliseOnDuplicate(mode) {
  const m = String(mode).trim().toLowerCase();
  if (!ON_DUPLICATE.includes(m)) throw new Error('onDuplicate must be error, return or report.');
  return m;
}

/**
 * Similar open tasks for a title, before creating one. The title goes after --title so one
 * starting with a dash is still a title.
 */
export function buildFindSimilarArgs({ title, project, projectId, workspace, limit, excludeId } = {}) {
  if (!title || !String(title).trim()) throw new Error('Say what the task is called: title is required.');
  const args = ['similar', '--title', String(title)];
  if (project) args.push('-p', project);
  if (projectId) args.push('--project-id', projectId);
  if (workspace) args.push('--workspace', workspace);
  if (limit !== undefined && limit !== null && limit !== '') {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new Error('limit must be a whole number from 1 to 10.');
    args.push('--limit', String(Math.min(n, 10)));
  }
  if (excludeId) args.push('--exclude', notAFlag(excludeId, 'Task ids never start with "-".'));
  return args;
}

/**
 * Build CLI arguments for task update.
 */
export function buildUpdateTaskArgs({
  id,
  project,
  reason,
  status,
  priority,
  category,
  epic,
  goal,
  customer,
  tags,
  linkTaskId,
  linkType,
  size,
  awaitUntil,
  thread,
  notes,
  projectId,
  assignTo,
  claim,
  unassign,
  refs,
  removeRefs,
} = {}) {
  if (!id) throw new Error('Task ID is required for update.');
  const args = ['update', id];
  if (project) args.push('--project', project);
  if (reason) args.push('-r', reason);
  if (status) {
    if (['done', 'do', 'delay', 'delegate', 'awaiting'].includes(status)) {
      args.push(`--${status}`);
    } else {
      args.push('-s', status);
    }
  }
  if (priority !== undefined) args.push('--priority', String(priority));
  if (size) args.push('--size', size);
  if (category) args.push('-p', category);
  if (epic) args.push('-e', epic);
  if (goal) args.push('-g', goal);
  if (customer) args.push('--customer', customer);
  if (tags) args.push('--tags', Array.isArray(tags) ? tags.join(',') : tags);
  if (awaitUntil) args.push('--await-until', awaitUntil);
  if (thread) args.push('--thread', thread);
  if (notes) args.push('-n', notes);
  if (projectId) args.push('--project-id', projectId);
  if (assignTo) args.push('--assign', assignTo);
  else if (claim) args.push('--claim');
  else if (unassign) args.push('--unassign');
  args.push(...buildRefFlags(refs), ...buildUnrefFlags(removeRefs));
  return args;
}

export function buildSearchTasksArgs({ query, includeDone, customer } = {}) {
  if (!query) throw new Error('Search query is required.');
  const args = ['search', query];
  if (includeDone) args.push('--all');
  if (customer) args.push('--customer', customer);
  return args;
}

export function buildListCustomersArgs() {
  return ['customers'];
}

export function buildLinkTasksArgs({ taskId, targetTaskId, relation = 'relates_to', reason } = {}) {
  if (!taskId || !targetTaskId) throw new Error('Both taskId and targetTaskId are required.');
  const args = ['link', taskId, targetTaskId, '--type', relation];
  if (reason) args.push('--reason', reason);
  return args;
}

export function buildUnlinkTasksArgs({ taskId, targetTaskId } = {}) {
  if (!taskId || !targetTaskId) throw new Error('Both taskId and targetTaskId are required.');
  return ['unlink', taskId, targetTaskId];
}

/**
 * Build CLI arguments for epics.
 */
export function buildListEpicsArgs({ category, workspace } = {}) {
  const args = ['epic', 'list'];
  if (category) args.push('-p', category);
  if (workspace) args.push('--workspace', workspace);
  return args;
}

export function buildAddEpicArgs({ title, category, goal, description, status, projectId } = {}) {
  if (!title) throw new Error('Epic title is required.');
  const args = ['epic', 'add', title];
  if (category) args.push('-p', category);
  if (goal) args.push('-g', goal);
  if (description) args.push('-d', description);
  if (status) args.push('--status', status);
  if (projectId) args.push('--project-id', projectId);
  return args;
}

export function buildUpdateEpicArgs({ id, title, category, goal, description, status, projectId } = {}) {
  if (!id) throw new Error('Epic id or title is required for update.');
  const args = ['epic', 'update', id];
  if (title) args.push('--title', title);
  if (category !== undefined) args.push('-p', category);
  if (goal !== undefined) args.push('-g', goal);
  if (description !== undefined) args.push('-d', description);
  if (status) args.push('--status', status);
  if (projectId) args.push('--project-id', projectId);
  return args;
}

export function buildDeleteEpicArgs({ id } = {}) {
  if (!id) throw new Error('Epic id or title is required for delete.');
  return ['epic', 'delete', id];
}

export function buildGetEpicArgs({ id } = {}) {
  if (!id) throw new Error('Epic id or title is required.');
  return ['epic', 'get', id];
}

/**
 * Build CLI arguments for goals.
 */
export function buildListGoalsArgs({ type } = {}) {
  const args = ['goal', 'list'];
  if (type) args.push('-t', type);
  return args;
}

/**
 * Activity log: who did what, newest first.
 */
export function buildActivityArgs({ taskId, epic, project, workspace, limit } = {}) {
  const args = ['activity'];
  if (taskId) args.push('--task', taskId);
  if (epic) args.push('--epic', epic);
  if (project) args.push('--project', project);
  if (workspace) args.push('--workspace', workspace);
  if (limit !== undefined && limit !== null && limit !== '') args.push('-n', String(limit));
  return args;
}

const BOT_ROLES = ['member', 'viewer'];
const botRequired = (value, field) => {
  if (value === undefined || value === null || value === '') throw new Error(`${field} is required.`);
  return value;
};
const botPositionals = (subcommand, ...values) => ['bot', subcommand, '--', ...values.map((value) => String(value))];

export function buildListBotsArgs({ workspace } = {}) {
  return botPositionals('list', botRequired(workspace, 'Workspace'));
}

export function buildCreateBotArgs({ workspace, name, role, tokenName } = {}) {
  const args = ['bot', 'create'];
  if (role !== undefined && role !== null && role !== '') {
    if (!BOT_ROLES.includes(role)) throw new Error('role must be member or viewer.');
    args.push('--role', role);
  }
  if (tokenName !== undefined && tokenName !== null && tokenName !== '') args.push('--token-name', String(tokenName));
  args.push('--', String(botRequired(workspace, 'Workspace')), String(botRequired(name, 'Bot name')));
  return args;
}

export function buildRenameBotArgs({ workspace, bot, name } = {}) {
  return botPositionals('rename', botRequired(workspace, 'Workspace'), botRequired(bot, 'Bot'), botRequired(name, 'New bot name'));
}

export function buildSetBotRoleArgs({ workspace, bot, role } = {}) {
  if (!BOT_ROLES.includes(role)) throw new Error('role must be member or viewer.');
  return botPositionals('role', botRequired(workspace, 'Workspace'), botRequired(bot, 'Bot'), role);
}

export function buildIssueBotTokenArgs({ workspace, bot, name } = {}) {
  const args = ['bot', 'token'];
  if (name !== undefined && name !== null && name !== '') args.push('--name', String(name));
  args.push('--', String(botRequired(workspace, 'Workspace')), String(botRequired(bot, 'Bot')));
  return args;
}

export function buildRevokeBotTokenArgs({ workspace, bot, token } = {}) {
  return ['bot', 'revoke-token', '--yes', '--', String(botRequired(workspace, 'Workspace')),
    String(botRequired(bot, 'Bot')), String(botRequired(token, 'Token'))];
}

export function buildDisableBotArgs({ workspace, bot } = {}) {
  return ['bot', 'disable', '--yes', '--', String(botRequired(workspace, 'Workspace')), String(botRequired(bot, 'Bot'))];
}

/**
 * Workspaces and sharing.
 */
export function buildWhoamiArgs() {
  return ['whoami'];
}

export function buildListWorkspacesArgs() {
  return ['workspace', 'list'];
}

export function buildGetWorkspaceArgs({ workspace } = {}) {
  if (!workspace) throw new Error('Workspace name or id is required.');
  return ['workspace', 'show', workspace];
}

const SHARE_ROLES = ['admin', 'member', 'viewer'];
const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'];

export function buildShareWorkspaceArgs({ workspace, email, role = 'member' } = {}) {
  if (!workspace || !email) throw new Error('Both workspace and email are required.');
  if (!SHARE_ROLES.includes(role)) throw new Error('role must be one of admin, member, viewer.');
  return ['workspace', 'share', workspace, email, '--role', role];
}

export function buildUpdateMemberRoleArgs({ workspace, member, role } = {}) {
  if (!workspace || !member || !role) throw new Error('workspace, member and role are required.');
  if (!MEMBER_ROLES.includes(role)) throw new Error('role must be one of owner, admin, member, viewer.');
  return ['workspace', 'role', workspace, member, role];
}

export function buildRemoveMemberArgs({ workspace, member } = {}) {
  if (!workspace || !member) throw new Error('Both workspace and member are required.');
  return ['workspace', 'remove', workspace, member, '--yes'];
}

export function buildMoveProjectArgs({ project, workspace } = {}) {
  if (!project || !workspace) throw new Error('Both project and workspace are required.');
  return ['workspace', 'move-project', project, workspace, '--yes'];
}
