// TimDo MCP tools: definitions (JSON schemas) and the handler that shells out to bin/timdo --json.
//
// TimDo is multi-user. Workspaces contain projects, projects contain epics and tasks.
// A task's "category" is its project's name. Everyone in a workspace sees all of its
// projects, epics, tasks, notes and activity. Roles: owner, admin, member, viewer
// (viewer is read-only). Life goals are private to each person.

import {
  runTimdoCli,
  buildListTasksArgs,
  buildAddTaskArgs,
  buildUpdateTaskArgs,
  buildListEpicsArgs,
  buildAddEpicArgs,
  buildUpdateEpicArgs,
  buildDeleteEpicArgs,
  buildGetEpicArgs,
  buildListGoalsArgs,
  buildSearchTasksArgs,
  buildListCustomersArgs,
  buildLinkTasksArgs,
  buildUnlinkTasksArgs,
  buildAuditArgs,
  buildActivityArgs,
  buildWhoamiArgs,
  buildListWorkspacesArgs,
  buildGetWorkspaceArgs,
  buildShareWorkspaceArgs,
  buildUpdateMemberRoleArgs,
  buildRemoveMemberArgs,
  buildMoveProjectArgs,
} from './timdo-cli.js';

const MODEL =
  'TimDo structure: workspace -> project -> epic -> task. A task\'s "category" is its project name. ' +
  'Everyone in a workspace sees all its projects, epics, tasks, notes and activity. ' +
  'Roles: owner, admin, member, viewer (viewer is read-only; writes fail with "View only: ..."). ' +
  'Life goals are private to each person.';

const TASK_FIELDS_NOTE =
  'Each task includes orgName (workspace), projectName/projectKey, isShared, myRole, canEdit, ' +
  'assigneeId/assigneeName, reporterName (created by), updatedByName (last updated by) and isMine.';

const AS_USER = {
  type: 'string',
  description:
    'Optional. Act as another TimDo account by email (sent as X-Timdo-User), e.g. robin@example.com, ' +
    'to preview what that collaborator sees. Only works with the account owner\'s secret: with a personal ' +
    'token (bin/timdo login) you can only name yourself, and any other email is refused with 403. ' +
    'Omit to act as whoever the CLI is signed in as. Only write as someone else when the user asks.',
};

const STATUS_LIST = ['do', 'awaiting', 'delay', 'done', 'delegate', 'all'];
const RELATIONS = ['relates_to', 'blocks', 'blocked_by', 'duplicates'];

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });

function tool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...properties, asUser: AS_USER },
      ...(required.length ? { required } : {}),
    },
  };
}

export const TIMDO_TOOLS = [
  tool(
    'timdo_list_tasks',
    `List TimDo tasks you can see across all your workspaces, filtered by status, project, workspace, assignee, epic, goal and more. ${MODEL} ${TASK_FIELDS_NOTE}`,
    {
      status: str('Task status filter: do, awaiting, delay, done, delegate, all (default: do)', { enum: STATUS_LIST }),
      category: str('Project (category) name, e.g. Acme Solar, Personal'),
      projectId: str('One exact project by id, key (e.g. ACME) or "Workspace/Project"'),
      workspace: str('Only tasks in this workspace, e.g. "Acme" or "personal"'),
      assignee: str(
        'Who the task is assigned to: "me" (assigned to me, or unassigned and created by me), "unassigned", "mine_or_unassigned", or a workspace member\'s name or email'
      ),
      mine: bool('Shortcut for assignee "me"'),
      unassigned: bool('Shortcut for assignee "unassigned"'),
      shared: bool('Only tasks in shared workspaces (more than one member)'),
      epic: str('Filter by epic title or ID prefix'),
      goal: str('Filter by one of your life goals (title or ID prefix)'),
      customer: str('Filter for a customer or company (e.g. Acme Solar)'),
      tag: str('Filter by tag (e.g. inverter, warranty)'),
      relatedTo: str('Tasks linked to a given task ID (prefix or UUID)'),
      noEpic: bool('Only tasks not linked to any epic'),
      noGoal: bool('Only tasks not linked to any of your life goals'),
      noCategory: bool('Only tasks with no project'),
      unlinked: str('Only tasks missing a hierarchy link', { enum: ['epic', 'goal', 'category', 'any'] }),
    }
  ),
  tool(
    'timdo_get_task',
    'Get one TimDo task: workspace, project, epic, assignee, created by, last updated by, linked tasks, notes (with author names) and recent activity.',
    { id: str('Task ID (prefix or full UUID)') },
    ['id']
  ),
  tool(
    'timdo_add_task',
    'Create a TimDo task. "category" picks the project by name: a project already in a shared workspace puts the task there (so collaborators see it); a new name creates the project in your personal workspace. New tasks are assigned to the creator unless assignTo says otherwise. Viewers cannot create tasks.',
    {
      project: str('Task title / name'),
      reason: str('Why this task matters'),
      status: str('Initial status: do, delay, delegate, awaiting (default: do)', {
        enum: ['do', 'delay', 'delegate', 'awaiting', 'done'],
      }),
      priority: { type: 'number', description: 'Priority 1-10 (default: 5)' },
      size: str('Estimated size/effort: * to ***** (default: ***)'),
      category: str('Project (category) name, e.g. Acme Solar, Personal. Required unless projectId is given.'),
      projectId: str('Exact project by id, key (e.g. ACME) or "Workspace/Project"'),
      assignTo: str('"me" (default), "none" for unassigned, or a member of the project\'s workspace by name or email'),
      epic: str('Parent epic title or ID'),
      goal: str('Your life goal title or ID (private to you)'),
      customer: str('Customer or client name (e.g. Acme Solar)'),
      tags: str('Tags (comma-separated)'),
      linkTaskId: str('Task ID or prefix to link with after creation'),
      linkType: str('Relationship when linkTaskId is given (default: relates_to)', { enum: RELATIONS }),
      awaitUntil: str('Return date YYYY-MM-DD (needed when status is awaiting)'),
      thread: str('Associated Gmail thread ID'),
      notes: str('Initial notes or next action'),
    },
    ['project']
  ),
  tool(
    'timdo_update_task',
    'Update a TimDo task: status, details, project, epic, or who it is assigned to. Assignees must be members of the task\'s workspace. Viewers cannot edit (error "View only: ...").',
    {
      id: str('Task ID (prefix or full UUID) to update'),
      project: str('New title for the task'),
      reason: str('Updated reason why this task matters'),
      status: str('New status: do, delay, delegate, done, awaiting', {
        enum: ['do', 'delay', 'delegate', 'done', 'awaiting'],
      }),
      priority: { type: 'number', description: 'Priority 1-10' },
      category: str('Move to another project by name'),
      projectId: str('Move to an exact project by id, key (e.g. ACME) or "Workspace/Project"'),
      assignTo: str('"me", "none" (unassign), or a workspace member\'s name or email'),
      claim: bool('Assign the task to yourself'),
      unassign: bool('Leave the task unassigned'),
      epic: str('Parent epic title or ID'),
      goal: str('Your life goal title or ID'),
      customer: str('Customer or client name'),
      tags: str('Tags (comma-separated)'),
      linkTaskId: str('Task ID or prefix to link with'),
      linkType: str('Relationship when linkTaskId is given (default: relates_to)', { enum: RELATIONS }),
      size: str('Size/effort (* to *****)'),
      awaitUntil: str('Return date YYYY-MM-DD (when status is awaiting)'),
      thread: str('Associated Gmail thread ID'),
      notes: str('Updated task notes'),
    },
    ['id']
  ),
  tool(
    'timdo_add_note',
    'Append a dated progress note to a TimDo task. The note is signed with the caller\'s name and visible to everyone in the task\'s workspace.',
    {
      id: str('Task ID (prefix or full UUID)'),
      note: str('Progress update text'),
      thread: str('Optional Gmail thread ID linked to this note'),
    },
    ['id', 'note']
  ),
  tool(
    'timdo_list_notes',
    'Dated notes on a TimDo task, oldest first, each with authorName.',
    { id: str('Task ID (prefix or full UUID)') },
    ['id']
  ),
  tool(
    'timdo_audit',
    'Hygiene audit of active tasks (missing epic, life goal, project or reason) and active epics with no tasks. By default only your own editable tasks (assigned to you, or unassigned and created by you) and epics you created; all=true covers everything you can edit.',
    { all: bool('Include every task and epic you can edit, not just your own') }
  ),
  tool(
    'timdo_search_tasks',
    'Full-text search (SQLite FTS5, BM25) across tasks in every workspace you can see. Results include match snippets, linked tasks, and orgName/projectName/assigneeName.',
    {
      query: str('Free-text query (title, reason, notes, customer, tags)'),
      includeDone: { type: 'boolean', default: false, description: 'Include done tasks (default: false)' },
      customer: str('Restrict to one customer or company'),
    },
    ['query']
  ),
  tool('timdo_delete_task', 'Soft-delete a TimDo task (needs edit rights).', { id: str('Task ID (prefix or full UUID)') }, [
    'id',
  ]),
  tool(
    'timdo_list_epics',
    'List TimDo epics with progress (done/total, %). Each epic includes orgName, projectKey, isShared, canEdit and createdByName.',
    {
      category: str('Project (category) name, e.g. Acme Solar'),
      workspace: str('Only epics in this workspace'),
    }
  ),
  tool(
    'timdo_add_epic',
    'Create a TimDo epic in a project. Everyone in that project\'s workspace sees it. The life goal link is private to you.',
    {
      title: str('Epic title'),
      category: str('Project (category) name, e.g. Acme Solar, Personal'),
      projectId: str('Exact project by id, key (e.g. ACME) or "Workspace/Project"'),
      goal: str('Your life goal title or ID prefix'),
      description: str('Description of the epic outcome'),
      status: str('Status (default: active)', { enum: ['active', 'completed', 'on_hold'] }),
    },
    ['title']
  ),
  tool(
    'timdo_update_epic',
    'Update a TimDo epic (title, project, goal, description, status). Viewers cannot edit.',
    {
      id: str('Epic ID (prefix or UUID) or title'),
      title: str('New title'),
      category: str('New project (category) name'),
      projectId: str('Exact project by id, key or "Workspace/Project"'),
      goal: str('Your life goal title or ID prefix'),
      description: str('Description of the epic outcome'),
      status: str('Status', { enum: ['active', 'completed', 'on_hold'] }),
    },
    ['id']
  ),
  tool('timdo_delete_epic', 'Delete a TimDo epic by ID or title.', { id: str('Epic ID (prefix or UUID) or title') }, [
    'id',
  ]),
  tool(
    'timdo_get_epic',
    'Get a TimDo epic: workspace, project, created/updated by, progress, all its tasks (with assignees) and recent activity.',
    { id: str('Epic ID (prefix or UUID) or title') },
    ['id']
  ),
  tool('timdo_list_goals', 'List your private TimDo life goals by type.', {
    type: str('Goal type', { enum: ['aims', 'focuses', 'values', 'housekeeping'] }),
  }),
  tool(
    'timdo_merge_tasks',
    'Merge two TimDo tasks: notes and history move to the target, the source is archived. Needs edit rights on both. Acts immediately.',
    {
      sourceId: str('Task ID (prefix or UUID) to absorb and archive'),
      targetId: str('Task ID (prefix or UUID) that survives'),
    },
    ['sourceId', 'targetId']
  ),
  tool(
    'timdo_list_customers',
    'Distinct customers with open task counts, plus the workspaces each customer appears in.'
  ),
  tool(
    'timdo_link_tasks',
    'Create a semantic link between two TimDo tasks (relates_to, blocks, blocked_by, duplicates).',
    {
      taskId: str('Source task ID or prefix'),
      targetTaskId: str('Target task ID or prefix'),
      relation: { type: 'string', enum: RELATIONS, default: 'relates_to', description: 'Relationship (default: relates_to)' },
      reason: str('Why the tasks are linked'),
    },
    ['taskId', 'targetTaskId']
  ),
  tool(
    'timdo_unlink_tasks',
    'Remove a link between two TimDo tasks.',
    { taskId: str('First task ID or prefix'), targetTaskId: str('Second task ID or prefix') },
    ['taskId', 'targetTaskId']
  ),

  // Collaboration
  tool(
    'timdo_activity',
    'Who did what in TimDo, newest first: task changes, notes, assignments, moves, epics, members. Each entry has actorName ("TimDo" for automatic actions), summary (e.g. Moved "Fix inverter" from Do to Done), projectName and createdAt.',
    {
      taskId: str('Only this task (ID or prefix)'),
      epic: str('Only this epic (ID or title)'),
      project: str('Only this project (name, key such as ACME, or "Workspace/Project")'),
      workspace: str('Only this workspace'),
      limit: { type: 'number', description: 'How many entries (default 20)' },
    }
  ),
  tool(
    'timdo_whoami',
    `Which TimDo account the tools act as (id, email, name) and the API in use. ${MODEL}`
  ),
  tool(
    'timdo_list_workspaces',
    `List your TimDo workspaces: name, your role, member count, project count, isPersonal. ${MODEL}`
  ),
  tool(
    'timdo_get_workspace',
    'One TimDo workspace in full: members with roles (isMe marks you), projects with key and open/done/epic counts, and pending invites with tokens (each carries an inviteUrl to send to the person).',
    { workspace: str('Workspace name, "personal", or id') },
    ['workspace']
  ),
  tool(
    'timdo_share_workspace',
    'Share a TimDo workspace with someone by email. Result status: "added" (they had an account and are in now), "already_member", or "invited" (they join when they first sign in with that email; inviteUrl is included). Needs owner or admin. Acts immediately: confirm with the user first.',
    {
      workspace: str('Workspace name or id'),
      email: str('Email address to share with'),
      role: str('Role to give (default: member). viewer is read-only.', { enum: ['admin', 'member', 'viewer'] }),
    },
    ['workspace', 'email']
  ),
  tool(
    'timdo_update_member_role',
    'Change a member\'s role in a TimDo workspace. owner can change anyone; admin can manage members and viewers. A workspace always keeps one owner. Acts immediately.',
    {
      workspace: str('Workspace name or id'),
      member: str('Member email or name'),
      role: str('New role', { enum: ['owner', 'admin', 'member', 'viewer'] }),
    },
    ['workspace', 'member', 'role']
  ),
  tool(
    'timdo_remove_member',
    'Remove someone from a TimDo workspace. They lose access to all its projects. Acts immediately without asking: confirm with the user first.',
    { workspace: str('Workspace name or id'), member: str('Member email or name') },
    ['workspace', 'member']
  ),
  tool(
    'timdo_move_project',
    'Move a project (with its epics, tasks and history) to another workspace, changing who can see it. Needs owner/admin on the source and edit rights on the destination. Acts immediately: confirm with the user first.',
    {
      project: str('Project name, key (e.g. ACME) or "Workspace/Project"'),
      workspace: str('Destination workspace name or id'),
    },
    ['project', 'workspace']
  ),
];

const required = (value, message) => {
  if (!value) throw new Error(message);
  return value;
};

/** CLI arguments for each tool. Exported for tests. */
export const TIMDO_ARG_BUILDERS = {
  timdo_list_tasks: (a) => buildListTasksArgs(a),
  timdo_get_task: (a) => ['get', required(a.id, 'Task id is required.')],
  timdo_add_task: (a) => buildAddTaskArgs(a),
  timdo_update_task: (a) => buildUpdateTaskArgs(a),
  timdo_add_note: (a) => {
    const args = ['add-note', required(a.id, 'Task id is required.'), required(a.note, 'Note text is required.')];
    if (a.thread) args.push('--thread', a.thread);
    return args;
  },
  timdo_list_notes: (a) => ['notes', required(a.id, 'Task id is required.')],
  timdo_audit: (a) => buildAuditArgs(a),
  timdo_search_tasks: (a) => buildSearchTasksArgs(a),
  timdo_delete_task: (a) => ['delete', required(a.id, 'Task id is required.')],
  timdo_list_epics: (a) => buildListEpicsArgs(a),
  timdo_add_epic: (a) => buildAddEpicArgs(a),
  timdo_update_epic: (a) => buildUpdateEpicArgs(a),
  timdo_delete_epic: (a) => buildDeleteEpicArgs(a),
  timdo_get_epic: (a) => buildGetEpicArgs(a),
  timdo_list_goals: (a) => buildListGoalsArgs(a),
  timdo_merge_tasks: (a) => {
    if (!a.sourceId || !a.targetId) throw new Error('Both sourceId and targetId are required for merge.');
    return ['merge', a.sourceId, a.targetId, '--yes'];
  },
  timdo_list_customers: () => buildListCustomersArgs(),
  timdo_link_tasks: (a) => buildLinkTasksArgs(a),
  timdo_unlink_tasks: (a) => buildUnlinkTasksArgs(a),
  timdo_activity: (a) => buildActivityArgs(a),
  timdo_whoami: () => buildWhoamiArgs(),
  timdo_list_workspaces: () => buildListWorkspacesArgs(),
  timdo_get_workspace: (a) => buildGetWorkspaceArgs(a),
  timdo_share_workspace: (a) => buildShareWorkspaceArgs(a),
  timdo_update_member_role: (a) => buildUpdateMemberRoleArgs(a),
  timdo_remove_member: (a) => buildRemoveMemberArgs(a),
  timdo_move_project: (a) => buildMoveProjectArgs(a),
};

const asText = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });

/**
 * Handle a timdo_* tool call. Returns an MCP result, or null when the name is not a TimDo tool.
 * Errors (including "View only: ..." from the API) are thrown for the caller to report.
 */
export async function handleTimdoTool(name, rawArgs = {}, run = runTimdoCli) {
  const build = TIMDO_ARG_BUILDERS[name];
  if (!build) return null;
  const args = rawArgs || {};
  const options = args.asUser ? { asUser: args.asUser } : {};
  const result = await run(build(args), undefined, options);

  // Optional link straight after creating or updating a task
  if ((name === 'timdo_add_task' || name === 'timdo_update_task') && args.linkTaskId) {
    const taskId = name === 'timdo_add_task' ? result?.id : args.id;
    if (taskId) {
      try {
        await run(
          buildLinkTasksArgs({ taskId, targetTaskId: args.linkTaskId, relation: args.linkType || 'relates_to' }),
          undefined,
          options
        );
      } catch (e) {
        console.error(`Failed to link task after ${name}:`, e);
      }
    }
  }
  return asText(result);
}
