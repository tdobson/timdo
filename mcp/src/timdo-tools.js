// TimDo MCP tools: definitions (JSON schemas) and the handler that shells out to bin/timdo --json.
//
// TimDo is multi-user. Workspaces contain projects, projects contain epics and tasks.
// A task's "category" is its project's name. Everyone in a workspace sees all of its
// projects, epics, tasks, notes and activity. Roles: owner, admin, member, viewer
// (viewer is read-only). Life goals are private to each person.
// Refs link a task to things outside TimDo (issues, posts, mail, member ids) as a URL or kind:id.

import {
  runTimdoCli,
  buildListTasksArgs,
  buildCountsArgs,
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
  buildAddRefArgs,
  buildRemoveRefArgs,
  buildFindByRefArgs,
  buildFindSimilarArgs,
  REF_ROLES,
  ON_DUPLICATE,
} from './timdo-cli.js';

const MODEL =
  'TimDo structure: workspace -> project -> epic -> task. A task\'s "category" is its project name. ' +
  'Everyone in a workspace sees all its projects, epics, tasks, notes and activity. ' +
  'Roles: owner, admin, member, viewer (viewer is read-only; writes fail with "View only: ..."). ' +
  'Life goals are private to each person.';

const TASK_FIELDS_NOTE =
  'Each task includes orgName (workspace), projectName/projectKey, isShared, myRole, canEdit, ' +
  'assigneeId/assigneeName, reporterName (created by), updatedByName (last updated by), isMine, ' +
  'and refs (links to things outside TimDo, each with id, role, canonical "kind:id", url and label).';

// Written for an agent that has never seen TimDo: what a ref is, the roles, examples, safety, privacy.
const REFS_NOTE =
  'A ref links a task to something outside TimDo: a GitHub issue or PR, a forum post, an email or Gmail thread, ' +
  'an error report, a member of another system, any web page. Give it as a URL, or as kind:id where kind is a ' +
  'lowercase dotted name (invent one for your own system), e.g. github.issue:acme/widgets#12 or acme.member:123456. ' +
  'Roles: link = related material (the default); source = where the task came from (a ref can be the source of only ' +
  'one task per workspace; adding it to an existing task when another holds it fails with "Already tracked: ... is ' +
  'already the source of <short id> <title>" and names the existing task); reported_by = an outside person ' +
  'or account who reported it (many allowed); about = the outside person or thing the task concerns. ' +
  'Adding the same ref with the same role again is safe and changes nothing, so retries are fine. ' +
  'Record people by their id in the other system (e.g. acme.member:123456), never by name or email address.';

// How to avoid duplicates, for an agent about to create a task
const DUPLICATES_NOTE =
  'Avoid duplicates. When the task comes from free text (something a person asked for, an email, a chat), call ' +
  'timdo_find_similar with the title first; if an open task already covers it and canEdit is true, add a note there ' +
  'with timdo_add_note instead of creating. If canEdit is false, the match is read-only: do not try to add a note or ' +
  'merge it, and tell the user they need an editor in that workspace. When it comes from an outside system (a forum post, ' +
  'an issue, an error report, a webhook), pass that item as a source ref and onDuplicate: "report": the first call ' +
  'creates the task, and every later call for the same item adds its new refs and a "Reported again" note to that task ' +
  'instead, so retries and repeats are safe. The result is the task plus created (true for a new task; false when ' +
  'onDuplicate found the existing one, with reported: true after a report) and similar (up to 3 open tasks that look alike, ' +
  'each with canEdit). Similarity is a suggestion, not proof of a duplicate. Review both tasks and get the user\'s explicit confirmation of the exact source and target before calling timdo_merge_tasks. ' +
  'Call it only if canEdit is true on both tasks; the merge acts immediately and archives the source into the target.';

const REF_ITEM = {
  type: 'object',
  properties: {
    ref: {
      type: 'string',
      description:
        'A URL, or kind:id such as github.issue:acme/widgets#12 or forum.post:4411. When kind is given, just the id (e.g. 123456).',
    },
    role: { type: 'string', enum: REF_ROLES, description: 'link (default), source, reported_by or about' },
    label: {
      type: 'string',
      description: 'Optional short display text (max 200), e.g. "Forum thread". Avoid people\'s names and contact details.',
    },
    kind: { type: 'string', description: 'Optional kind for a bare id, e.g. acme.member with ref 123456' },
    url: {
      type: 'string',
      description: 'Optional http(s) link to open for this ref, when TimDo cannot build one (e.g. a member profile page)',
    },
  },
  required: ['ref'],
};

const AS_USER = {
  type: 'string',
  description:
    'Optional. Act as another TimDo account by email (sent as X-Timdo-User), e.g. robin@example.com, ' +
    'to preview what that collaborator sees. Only works with the account owner\'s secret: with a personal ' +
    'token (bin/timdo login) you can only name yourself, and any other email is refused with 403. ' +
    'Omit to act as whoever the CLI is signed in as. Only write as someone else when the user asks.',
};

const TASK_STATUS_PATTERN = '^(?:all|(?:do|awaiting|delay|done|delegate)(?:,(?:do|awaiting|delay|done|delegate))*)$';
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

const TASK_FILTER_PROPERTIES = {
  status: str(
    'Task status filter: all, or one or more comma-separated values from do, awaiting, delay, done and delegate (default: do for lists, all for counts)',
    { pattern: TASK_STATUS_PATTERN }
  ),
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
  ref: str(
    'Only tasks carrying this ref (a URL or kind:id, e.g. github.issue:acme/widgets#12). With ref and no status, every status is listed (done included).'
  ),
};

export const TIMDO_TOOLS = [
  tool(
    'timdo_list_tasks',
    `List TimDo tasks you can see across all your workspaces. Returns up to 50 summary items by default in a page envelope with nextCursor and the full filtered total. Pass cursor with the same filters to continue; narrow membership with status, project, workspace, assignee, epic, goal, customer, tag, refs or missing links. groupBy adds page-local grouping metadata without changing the continuation. ${MODEL} ${TASK_FIELDS_NOTE}`,
    {
      ...TASK_FILTER_PROPERTIES,
      limit: { type: 'number', default: 50, minimum: 1, maximum: 200, description: 'Page size (default 50, maximum 200)' },
      cursor: str('Opaque continuation cursor from the previous page. Keep all membership filters the same.'),
      groupBy: str('Add page-local presentation groups by project, epic or assignee.', { enum: ['project', 'epic', 'assignee'] }),
      fields: str('Task fields: summary omits the full notes body (default); full includes it.', { enum: ['summary', 'full'], default: 'summary' }),
    }
  ),
  tool(
    'timdo_counts',
    `Get SQL-aggregated task counts for the same visibility and membership filters as timdo_list_tasks. All five statuses are returned, including zeroes. Counts are not estimated from a page. ${MODEL}`,
    TASK_FILTER_PROPERTIES
  ),
  tool(
    'timdo_get_task',
    'Get one TimDo task: workspace, project, epic, assignee, created by, last updated by, refs (links to things outside TimDo, sorted by role: Source, About, Reported by, Link; each with an id you can pass to timdo_remove_ref), linked tasks, notes (with author names) and recent activity.',
    { id: str('Task ID (prefix or full UUID)') },
    ['id']
  ),
  tool(
    'timdo_add_task',
    `Create a TimDo task. "category" picks the project by name: a project already in a shared workspace puts the task there (so collaborators see it); a new name creates the project in your personal workspace. New tasks are assigned to the creator unless assignTo says otherwise. Viewers cannot create tasks. Optional refs are added with the task after validation. If a source ref is already tracked, onDuplicate controls the answer: error (default) returns 409 with the existing task, return gives that task back unchanged with created: false, and report adds the other refs and one report note, then returns created: false, reported: true. ${DUPLICATES_NOTE} ${REFS_NOTE}`,
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
      thread: str('Associated Gmail thread ID (also recorded as a gmail.thread ref)'),
      notes: str('Initial notes or next action'),
      refs: {
        type: 'array',
        maxItems: 20,
        items: REF_ITEM,
        description:
          'Links to things outside TimDo, e.g. [{"ref":"forum.post:4411","role":"source"},{"ref":"acme.member:123456","role":"reported_by"},{"ref":"https://github.com/acme/widgets/issues/88"}]',
      },
      onDuplicate: str(
        'What to do when a source ref in refs is already the source of a live task in that workspace. ' +
          '"error" (default): create nothing and fail with "Already tracked: ..." naming that task. ' +
          '"return": create nothing and return that task with created: false. ' +
          '"report": add this call\'s other refs and a note \'Reported again: "<project>"\' (plus notes) to that task, ' +
          'and return it with created: false, reported: true; repeating the same report adds nothing twice. ' +
          'Use "report" for items from outside systems. Ignored when refs has no source.',
        { enum: ON_DUPLICATE }
      ),
    },
    ['project']
  ),
  tool(
    'timdo_find_similar',
    'Find open TimDo tasks that look like a task you are about to create, best first. Call it before timdo_add_task ' +
      'whenever the title comes from free text, so you do not make a duplicate: if a result is the same thing, add a ' +
      'note to it with timdo_add_note (or update it with timdo_update_task) instead of creating. Matching is by the ' +
      'title\'s words: common words such as "the" and words under 3 letters are ignored, a title needs at least 2 ' +
      'other words, and a task must share at least half of them (in its title, reason or notes). Titles are limited to ' +
      '500 characters. An empty array means nothing looks similar, so go ahead and create. Done and deleted tasks never ' +
      'appear. Scope it like the create: project searches the workspace that project is in; projectId the same by id or ' +
      'key; workspace one workspace; none of them every workspace you can see. Returns [{ id, shortId, title, status, ' +
      'projectId, projectName, orgId, orgName, assigneeId, assigneeName, score, canEdit }], where score (0.5 to 1) is ' +
      'the share of the title\'s words found. Only add a note when canEdit is true; a read-only match cannot be edited.',
    {
      title: str('The title you would create, e.g. "Fix the offer page"'),
      project: str('Project (category) name you would create in, e.g. Acme Solar: searches that project\'s workspace'),
      projectId: str('Exact project by id, key (e.g. ACME) or "Workspace/Project": searches its workspace'),
      workspace: str('Only this workspace, e.g. "Acme" or "personal"'),
      limit: { type: 'number', description: 'How many results, 1 to 10 (default 3)' },
      excludeId: str('Leave this task out (ID or prefix), e.g. the task you are editing'),
    },
    ['title']
  ),
  tool(
    'timdo_update_task',
    `Update a TimDo task: status, details, project, epic, who it is assigned to, and its refs. Assignees must be members of the task's workspace. Viewers cannot edit (error "View only: ..."). refs are added to the ones the task already has (never replacing them); removeRefs takes refs away. Each ref change is tried even if another fails; any failure makes the call fail with the reasons, but the rest are saved. ${REFS_NOTE}`,
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
      thread: str('Associated Gmail thread ID (also recorded as a gmail.thread ref)'),
      notes: str('Updated task notes'),
      refs: { type: 'array', items: REF_ITEM, description: 'Refs to add, e.g. [{"ref":"https://github.com/acme/widgets/pull/7"}]' },
      removeRefs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Refs to remove: each a URL or kind:id (every role it has on this task goes), or a ref id from timdo_get_task, e.g. ["github.issue:acme/widgets#12"]',
      },
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
    'Full-text search (SQLite FTS5, BM25) across tasks in every workspace you can see. Results include match snippets, linked tasks, and orgName/projectName/assigneeName. If the query is a URL or kind:id, tasks carrying exactly that ref come first, marked matchedRef: true, done ones included (check status) whatever includeDone says.',
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
    'Merge two TimDo tasks: notes and history move to the target, and the source is archived. Needs edit rights on both. Acts immediately. Call only after reviewing both tasks and getting explicit user confirmation of the exact source and target.',
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

  // Refs: links to things outside TimDo
  tool(
    'timdo_add_ref',
    `Add one ref to an existing TimDo task. ${REFS_NOTE} Returns the ref (id, role, kind, ref, canonical, url, label, displayLabel) with existing: true if it was already there. Needs edit rights on the task (viewers get "View only: ...").`,
    {
      id: str('Task ID (prefix or full UUID)'),
      ref: REF_ITEM.properties.ref,
      role: REF_ITEM.properties.role,
      label: REF_ITEM.properties.label,
      kind: REF_ITEM.properties.kind,
      url: REF_ITEM.properties.url,
    },
    ['id', 'ref']
  ),
  tool(
    'timdo_remove_ref',
    'Remove a ref (a link to something outside TimDo) from a TimDo task. ref is what was added, as a URL or kind:id (both forms match: https://github.com/acme/widgets/issues/12 is github.issue:acme/widgets#12), or the ref\'s id from timdo_get_task. Without role, every role of that ref on the task is removed. Returns { taskId, removed: [refs] }. Fails with "Not found: that link isn\'t on this task" when nothing matches. Needs edit rights.',
    {
      id: str('Task ID (prefix or full UUID)'),
      ref: str('URL, kind:id (e.g. forum.post:4411) or ref id'),
      role: str('Only remove it in this role', { enum: REF_ROLES }),
    },
    ['id', 'ref']
  ),
  tool(
    'timdo_find_by_ref',
    'Find TimDo tasks that carry a ref (a link to something outside TimDo), in every workspace you can see, any status including done. Use it to look up the task for an outside item, e.g. { "ref": "forum.post:4411", "role": "source" }. To create one only if it does not exist yet, call timdo_add_task with that source ref and onDuplicate "report" (or "return") instead: checking first and then creating can race with another caller, the single create cannot. ref is a URL or kind:id; a URL and its kind:id form find the same tasks. Returns an array of tasks (empty when none), each with its refs.',
    {
      ref: str('URL or kind:id, e.g. https://github.com/acme/widgets/issues/12 or acme.member:123456'),
      role: str('Only tasks carrying it in this role', { enum: REF_ROLES }),
    },
    ['ref']
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
    'One TimDo workspace in full: members with roles (isMe marks you), projects with key and open/done/epic counts, and pending invites with tokens (invite link: https://timdo.tdobson.net/invite/<token>).',
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
  timdo_list_tasks: (a = {}) =>
    buildListTasksArgs({
      ...a,
      limit: a.limit ?? 50,
      fields: a.fields ?? 'summary',
    }),
  timdo_counts: (a) => buildCountsArgs(a),
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
  timdo_add_ref: (a) => buildAddRefArgs(a),
  timdo_remove_ref: (a) => buildRemoveRefArgs(a),
  timdo_find_by_ref: (a) => buildFindByRefArgs(a),
  timdo_find_similar: (a) => buildFindSimilarArgs(a),
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

/** CLI errors suggest CLI commands; point an agent at the matching tool instead. */
export function toolHints(message) {
  return String(message)
    .replace(/timdo get (\S+?)(?=[\s.,]|$)/g, 'timdo_get_task with id "$1"')
    .replace(/timdo ref list (\S+?)(?=[\s.,]|$)/g, 'timdo_get_task with id "$1" (its refs)')
    .replace(/--on-duplicate (error|return|report)\b/g, 'call timdo_add_task again with onDuplicate "$1"');
}

function taskGroup(task, groupBy) {
  if (groupBy === 'project') {
    const projectId = task.projectId || task.projectName || task.category || null;
    const name = task.projectName || task.category || 'No project';
    const label = task.isShared === true && task.orgName && task.orgName.toLowerCase() !== name.toLowerCase()
      ? `${task.orgName}/${name}`
      : name;
    return { key: projectId, label };
  }
  if (groupBy === 'epic') {
    const key = task.epicId || null;
    const title = task.epicTitle || task.epicName;
    return { key, label: key ? title || `Epic ${String(key).slice(0, 8)}` : 'No epic' };
  }
  const key = task.assigneeId || null;
  return { key, label: key ? task.assigneeName || key : 'Unassigned' };
}

/** Group ids from one MCP page without changing its flat items or continuation cursor. */
export function groupTaskItems(items, groupBy) {
  const groups = new Map();
  for (const task of items) {
    const { key, label } = taskGroup(task, groupBy);
    if (!groups.has(key)) groups.set(key, { key, label, taskIds: [] });
    groups.get(key).taskIds.push(task.id);
  }
  return Array.from(groups.values());
}

/**
 * Handle a timdo_* tool call. Returns an MCP result, or null when the name is not a TimDo tool.
 * Errors (including "View only: ..." from the API) are thrown for the caller to report.
 */
export async function handleTimdoTool(name, rawArgs = {}, run = runTimdoCli) {
  const build = TIMDO_ARG_BUILDERS[name];
  if (!build) return null;
  const args = rawArgs || {};
  const options = args.asUser ? { asUser: args.asUser } : {};
  let result;
  try {
    result = await run(build(args), undefined, options);
  } catch (e) {
    throw new Error(toolHints(e.message || String(e)));
  }

  if (name === 'timdo_list_tasks' && args.groupBy && Array.isArray(result?.items)) {
    result = {
      ...result,
      groupBy: args.groupBy,
      groups: groupTaskItems(result.items, args.groupBy),
    };
  }

  // Optional link straight after creating or updating a task. onDuplicate "return" promises no
  // writes, so the task it hands back is not linked.
  const returnedOnly = name === 'timdo_add_task' && result?.created === false && !result?.reported;
  if ((name === 'timdo_add_task' || name === 'timdo_update_task') && args.linkTaskId && !returnedOnly) {
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
