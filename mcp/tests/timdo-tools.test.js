import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TIMDO_TOOLS, TIMDO_ARG_BUILDERS, handleTimdoTool, toolHints } from '../src/timdo-tools.js';

const ORIGINAL_TOOLS = [
  'timdo_list_tasks',
  'timdo_get_task',
  'timdo_add_task',
  'timdo_update_task',
  'timdo_add_note',
  'timdo_list_notes',
  'timdo_audit',
  'timdo_search_tasks',
  'timdo_delete_task',
  'timdo_list_epics',
  'timdo_add_epic',
  'timdo_update_epic',
  'timdo_delete_epic',
  'timdo_get_epic',
  'timdo_list_goals',
  'timdo_merge_tasks',
  'timdo_list_customers',
  'timdo_link_tasks',
  'timdo_unlink_tasks',
];

const NEW_TOOLS = [
  'timdo_activity',
  'timdo_whoami',
  'timdo_list_workspaces',
  'timdo_get_workspace',
  'timdo_share_workspace',
  'timdo_update_member_role',
  'timdo_remove_member',
  'timdo_move_project',
];

const REF_TOOLS = ['timdo_add_ref', 'timdo_remove_ref', 'timdo_find_by_ref'];

const DEDUP_TOOLS = ['timdo_find_similar'];

const byName = Object.fromEntries(TIMDO_TOOLS.map((t) => [t.name, t]));

test('every original and new TimDo tool is defined, with a builder', () => {
  for (const name of [...ORIGINAL_TOOLS, ...NEW_TOOLS, ...REF_TOOLS, ...DEDUP_TOOLS]) {
    assert.ok(byName[name], `${name} is defined`);
    assert.ok(TIMDO_ARG_BUILDERS[name], `${name} has a builder`);
  }
  assert.equal(TIMDO_TOOLS.length, ORIGINAL_TOOLS.length + NEW_TOOLS.length + REF_TOOLS.length + DEDUP_TOOLS.length);
});

test('original parameters are kept for backward compatibility', () => {
  const props = (n) => Object.keys(byName[n].inputSchema.properties);
  for (const p of ['status', 'category', 'epic', 'goal', 'customer', 'tag', 'relatedTo', 'noEpic', 'noGoal', 'noCategory', 'unlinked']) {
    assert.ok(props('timdo_list_tasks').includes(p), `list_tasks keeps ${p}`);
  }
  for (const p of ['project', 'reason', 'status', 'priority', 'size', 'category', 'epic', 'goal', 'customer', 'tags', 'linkTaskId', 'linkType', 'awaitUntil', 'thread', 'notes']) {
    assert.ok(props('timdo_add_task').includes(p), `add_task keeps ${p}`);
  }
  assert.deepEqual(byName.timdo_add_task.inputSchema.required, ['project']);
  assert.deepEqual(byName.timdo_update_task.inputSchema.required, ['id']);
  assert.deepEqual(byName.timdo_merge_tasks.inputSchema.required, ['sourceId', 'targetId']);
});

test('multi-user parameters and asUser are exposed', () => {
  const props = (n) => byName[n].inputSchema.properties;
  assert.ok(props('timdo_list_tasks').assignee);
  assert.ok(props('timdo_list_tasks').workspace);
  assert.ok(props('timdo_add_task').assignTo);
  assert.ok(props('timdo_update_task').assignTo);
  assert.ok(props('timdo_update_task').claim);
  for (const t of TIMDO_TOOLS) assert.ok(t.inputSchema.properties.asUser, `${t.name} accepts asUser`);
  assert.match(byName.timdo_list_workspaces.description, /viewer/);
  for (const t of TIMDO_TOOLS) assert.ok(!t.description.includes('\u2014'), `${t.name} has no em-dash`);
});

test('handleTimdoTool runs the CLI with --yes for drastic actions and passes asUser', async () => {
  const calls = [];
  const fakeRun = async (args, bin, options) => {
    calls.push({ args, options });
    return { ok: true };
  };
  const res = await handleTimdoTool('timdo_remove_member', { workspace: 'MD', member: 'robin', asUser: 'x@y.z' }, fakeRun);
  assert.deepEqual(calls[0].args, ['workspace', 'remove', 'MD', 'robin', '--yes']);
  assert.deepEqual(calls[0].options, { asUser: 'x@y.z' });
  assert.equal(JSON.parse(res.content[0].text).ok, true);

  await handleTimdoTool('timdo_list_tasks', { assignee: 'me' }, fakeRun);
  assert.deepEqual(calls[1].args, ['list', 'do', '--assignee', 'me']);
  assert.deepEqual(calls[1].options, {});

  assert.equal(await handleTimdoTool('not_a_timdo_tool', {}, fakeRun), null);
});

test('handleTimdoTool links a new task when linkTaskId is given', async () => {
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    return args[0] === 'add' ? { id: 'new-id' } : { ok: true };
  };
  await handleTimdoTool('timdo_add_task', { project: 'T', category: 'Acme Solar', linkTaskId: 'ab12', linkType: 'blocks' }, fakeRun);
  assert.deepEqual(calls[1], ['link', 'new-id', 'ab12', '--type', 'blocks']);
});

test('handleTimdoTool surfaces CLI errors such as view-only access', async () => {
  const fakeRun = async () => {
    throw new Error('timdo CLI error: View only: you have view-only access to "Acme Solar"');
  };
  await assert.rejects(() => handleTimdoTool('timdo_update_task', { id: 'ab12', status: 'done' }, fakeRun), /View only/);
});

test('asUser explains that personal tokens can only name yourself', () => {
  const desc = TIMDO_TOOLS[0].inputSchema.properties.asUser.description;
  assert.match(desc, /owner/);
  assert.match(desc, /personal token/);
});

test('tool text has no personal paths and speaks to any user, not one named person', () => {
  const text = JSON.stringify(TIMDO_TOOLS);
  assert.ok(!text.includes('/home/'), 'no home directory paths');
  assert.ok(!/\bTim\b/.test(text), 'no references to one named account owner');
  for (const m of text.match(/[\w.+-]+@[\w.-]+/g) || []) assert.match(m, /@example\.com$/, `example email ${m}`);
});

// ---------------------------------------------------------------------------
// Refs: links from a task to things outside TimDo
// ---------------------------------------------------------------------------

test('ref tools and params are exposed with the schema an agent needs', () => {
  const props = (n) => byName[n].inputSchema.properties;
  assert.deepEqual(byName.timdo_add_ref.inputSchema.required, ['id', 'ref']);
  assert.deepEqual(byName.timdo_remove_ref.inputSchema.required, ['id', 'ref']);
  assert.deepEqual(byName.timdo_find_by_ref.inputSchema.required, ['ref']);
  for (const n of ['timdo_add_ref', 'timdo_remove_ref', 'timdo_find_by_ref']) {
    assert.deepEqual(props(n).role.enum, ['link', 'source', 'reported_by', 'about'], `${n} role enum`);
  }
  assert.equal(props('timdo_add_task').refs.type, 'array');
  assert.deepEqual(props('timdo_add_task').refs.items.required, ['ref']);
  // Every ref field the CLI passes through is in the schema, url included
  for (const n of ['timdo_add_task', 'timdo_update_task']) {
    assert.deepEqual(Object.keys(props(n).refs.items.properties), ['ref', 'role', 'label', 'kind', 'url'], `${n} ref fields`);
  }
  assert.deepEqual(props('timdo_add_ref').url, props('timdo_add_task').refs.items.properties.url);
  assert.match(byName.timdo_get_task.description, /sorted by role/);
  assert.doesNotMatch(byName.timdo_get_task.description, /grouped by role/);
  assert.match(byName.timdo_search_tasks.description, /done ones included/);
  assert.equal(props('timdo_add_task').refs.maxItems, 20);
  assert.equal(props('timdo_update_task').refs.type, 'array');
  assert.equal(props('timdo_update_task').removeRefs.items.type, 'string');
  assert.ok(props('timdo_list_tasks').ref);
});

test('ref descriptions explain refs to an agent that has never seen TimDo', () => {
  for (const n of ['timdo_add_ref', 'timdo_add_task', 'timdo_update_task']) {
    const d = byName[n].description;
    assert.match(d, /kind:id/, `${n} explains kind:id`);
    assert.match(d, /github\.issue:acme\/widgets#12/, `${n} has a canonical example`);
    assert.match(d, /acme\.member:123456/, `${n} has a member example`);
    for (const role of ['link', 'source', 'reported_by', 'about']) assert.match(d, new RegExp(role), `${n} names ${role}`);
    assert.match(d, /safe/, `${n} says re-adding is safe`);
    assert.match(d, /Already tracked/, `${n} describes the source clash`);
    assert.match(d, /by their id in the other system/, `${n} has the privacy line`);
  }
  assert.match(byName.timdo_find_by_ref.description, /done/);
  assert.match(byName.timdo_search_tasks.description, /matchedRef/);
  assert.match(byName.timdo_get_task.description, /refs/);
});

test('ref tools map to the right CLI arguments', () => {
  const b = TIMDO_ARG_BUILDERS;
  assert.deepEqual(b.timdo_add_ref({ id: 'aaaa1111', ref: 'https://github.com/acme/widgets/issues/12' }), [
    'ref', 'add', 'aaaa1111', 'https://github.com/acme/widgets/issues/12',
  ]);
  assert.deepEqual(
    b.timdo_add_ref({ id: 'aaaa1111', ref: '123456', kind: 'acme.member', role: 'reported-by', label: 'Forum account', url: 'https://forum.example.org/u/123456' }),
    ['ref', 'add', 'aaaa1111', '123456', '--role', 'reported_by', '--label', 'Forum account', '--kind', 'acme.member', '--url', 'https://forum.example.org/u/123456']
  );
  assert.deepEqual(b.timdo_remove_ref({ id: 'aaaa1111', ref: 'forum.post:4411', role: 'source' }), [
    'ref', 'rm', 'aaaa1111', 'forum.post:4411', '--role', 'source',
  ]);
  assert.deepEqual(b.timdo_find_by_ref({ ref: 'forum.post:4411', role: 'source' }), ['find', 'forum.post:4411', '--role', 'source']);
  assert.deepEqual(b.timdo_find_by_ref({ ref: 'acme.member:123456' }), ['find', 'acme.member:123456']);
  assert.deepEqual(b.timdo_list_tasks({ ref: 'github.issue:acme/widgets#12' }), ['list', 'all', '--ref', 'github.issue:acme/widgets#12']);
  assert.deepEqual(b.timdo_list_tasks({ ref: 'forum.post:1', status: 'do' }), ['list', 'do', '--ref', 'forum.post:1']);
  assert.throws(() => b.timdo_add_ref({ id: 'aaaa1111' }), /URL or kind:id/);
  assert.throws(() => b.timdo_add_ref({ ref: 'forum.post:1' }), /Task id is required/);
  assert.throws(() => b.timdo_add_ref({ id: 'a', ref: 'forum.post:1', role: 'owner' }), /Role must be link, source, reported_by or about/);
  assert.throws(() => b.timdo_find_by_ref({}), /URL or kind:id/);
});

test('add_task and update_task turn refs into flags, and rich refs into one --refs-json', () => {
  const b = TIMDO_ARG_BUILDERS;
  assert.deepEqual(
    b.timdo_add_task({
      project: 'Broken offer page',
      category: 'Acme Solar',
      refs: [
        { ref: 'forum.post:4411', role: 'source' },
        { ref: 'acme.member:123456', role: 'reported_by' },
        { ref: 'https://github.com/acme/widgets/issues/88' },
        { ref: 'acme.thing:1', role: 'about' },
        { ref: '555', kind: 'acme.member', role: 'reported_by', label: 'Forum account' },
      ],
    }),
    [
      'add', '--title', 'Broken offer page', '-p', 'Acme Solar',
      '--source', 'forum.post:4411',
      '--reported-by', 'acme.member:123456',
      '--ref', 'https://github.com/acme/widgets/issues/88',
      '--about', 'acme.thing:1',
      '--refs-json', '[{"ref":"555","role":"reported_by","label":"Forum account","kind":"acme.member"}]',
    ]
  );
  // Strings, a single string and a JSON string are all accepted
  assert.deepEqual(b.timdo_add_task({ project: 'T', category: 'C', refs: ['forum.post:1'] }), ['add', '--title', 'T', '-p', 'C', '--ref', 'forum.post:1']);
  assert.deepEqual(b.timdo_add_task({ project: 'T', category: 'C', refs: 'forum.post:1' }), ['add', '--title', 'T', '-p', 'C', '--ref', 'forum.post:1']);
  assert.deepEqual(b.timdo_add_task({ project: 'T', category: 'C', refs: '[{"ref":"forum.post:1","role":"source"}]' }), [
    'add', '--title', 'T', '-p', 'C', '--source', 'forum.post:1',
  ]);
  assert.throws(() => b.timdo_add_task({ project: 'T', category: 'C', refs: [{ role: 'source' }] }), /Each ref needs "ref"/);

  assert.deepEqual(
    b.timdo_update_task({
      id: 'aaaa1111',
      refs: [{ ref: 'https://github.com/acme/widgets/pull/7' }],
      removeRefs: ['github.issue:acme/widgets#12', 'e0000003'],
    }),
    ['update', 'aaaa1111', '--ref', 'https://github.com/acme/widgets/pull/7', '--unref', 'github.issue:acme/widgets#12', '--unref', 'e0000003']
  );
  assert.deepEqual(b.timdo_update_task({ id: 'aaaa1111', removeRefs: 'forum.post:4411' }), ['update', 'aaaa1111', '--unref', 'forum.post:4411']);
  assert.deepEqual(b.timdo_update_task({ id: 'aaaa1111', status: 'done' }), ['update', 'aaaa1111', '--done']);
});

test('CLI hints in errors point an agent at the matching tool', async () => {
  assert.equal(
    toolHints('Already tracked: forum.post:4411 is already the source of aaaa1111 "Broken offer page". Open it with: timdo get aaaa1111'),
    'Already tracked: forum.post:4411 is already the source of aaaa1111 "Broken offer page". Open it with: timdo_get_task with id "aaaa1111"'
  );
  assert.match(toolHints("Not found: that link isn't on this task. See the task's links with: timdo ref list aaaa1111"), /timdo_get_task with id "aaaa1111" \(its refs\)/);
  const fakeRun = async () => {
    throw new Error('timdo CLI error: Already tracked: forum.post:4411 is already the source of aaaa1111 "T". Open it with: timdo get aaaa1111-full');
  };
  await assert.rejects(
    () => handleTimdoTool('timdo_add_task', { project: 'T', category: 'C', refs: [{ ref: 'forum.post:4411', role: 'source' }] }, fakeRun),
    /Already tracked: .*timdo_get_task with id "aaaa1111-full"/
  );
});

test('end to end: tool calls run the real bin/timdo and send the right requests', async () => {
  const T1 = 'aaaa1111-0000-4000-8000-000000000001';
  const seen = [];
  const refs = [{ id: 'e0000001-0000-4000-8000-000000000001', taskId: T1, role: 'link', kind: 'github.issue', ref: 'acme/widgets#12', canonical: 'github.issue:acme/widgets#12' }];
  const taskView = { id: T1, project: 'Broken offer page', status: 'do', priority: 7, size: '**', category: 'Acme Solar', canEdit: true, refs };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : null });
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      if (req.method === 'POST' && url.pathname === '/api/v2/projects') return send(201, { ...taskView, id: 'new-task-id', refs: [] });
      if (req.method === 'GET' && url.pathname === '/api/v2/projects') return send(200, [taskView]);
      if (req.method === 'GET' && url.pathname === `/api/v2/tasks/${T1}/refs`) {
        const n = seen.filter((s) => s.method === 'GET' && s.path === url.pathname).length;
        return send(200, n === 1 ? refs : []);
      }
      if (req.method === 'DELETE') return send(204);
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    TIMDO_API: `http://127.0.0.1:${server.address().port}/api/v2`,
    TIMDO_SECRET: 'test-secret',
    TIMDO_CONFIG: '/dev/null',
    NO_COLOR: '1',
  });
  delete process.env.TIMDO_TOKEN;
  delete process.env.TIMDO_AS;
  try {
    await handleTimdoTool('timdo_add_task', {
      project: 'Broken offer page',
      category: 'Acme Solar',
      refs: [{ ref: 'forum.post:4411', role: 'source' }, { ref: '555', kind: 'acme.member', role: 'reported_by', label: 'Forum account' }],
    });
    const create = seen.find((s) => s.method === 'POST');
    assert.deepEqual(create.body.refs, [
      { ref: 'forum.post:4411', role: 'source' },
      { ref: '555', role: 'reported_by', label: 'Forum account', kind: 'acme.member' },
    ]);

    const found = await handleTimdoTool('timdo_find_by_ref', { ref: 'github.issue:acme/widgets#12', role: 'link' });
    assert.ok(seen.some((s) => s.query === '?ref=github.issue%3Aacme%2Fwidgets%2312&role=link'), 'find sends ref and role');
    assert.equal(JSON.parse(found.content[0].text)[0].id, T1);

    const removed = await handleTimdoTool('timdo_remove_ref', { id: 'aaaa1111', ref: 'github.issue:acme/widgets#12' });
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.query === '?ref=github.issue%3Aacme%2Fwidgets%2312'), 'remove sends ?ref=');
    assert.deepEqual(JSON.parse(removed.content[0].text), { taskId: T1, removed: refs });
  } finally {
    process.env = saved;
    server.close();
  }
});

// ---------------------------------------------------------------------------
// No duplicates on create: onDuplicate and timdo_find_similar
// ---------------------------------------------------------------------------

test('add_task takes onDuplicate, and its description says when to use it and what comes back', () => {
  const add = byName.timdo_add_task;
  assert.deepEqual(add.inputSchema.properties.onDuplicate.enum, ['error', 'return', 'report']);
  const d = add.description;
  assert.match(d, /timdo_find_similar/, 'tells agents to check free-text titles first');
  assert.match(d, /source ref and onDuplicate: "report"/, 'tells agents what to do for outside systems');
  assert.match(d, /created/, 'describes created');
  assert.match(d, /similar/, 'describes similar');
  assert.match(d, /timdo_merge_tasks/, 'names the merge tool for a confirmed duplicate');
  assert.match(d, /similarity is a suggestion, not proof of a duplicate/i);
  assert.match(d, /review both tasks and get the user.s explicit confirmation of the exact source and target before calling timdo_merge_tasks/i);
  assert.match(d, /canEdit/, 'tells agents which suggestions they can edit');
  assert.match(d, /read-only/, 'does not recommend notes on a viewer-only task');
  assert.doesNotMatch(d, /if any ref fails.*source another task/i, 'describes onDuplicate rather than treating every clash as a failed create');
  const od = add.inputSchema.properties.onDuplicate.description;
  for (const word of ['"error" (default)', '"return"', '"report"', 'created: false', 'reported: true', 'Ignored when refs has no source']) {
    assert.ok(od.includes(word), `onDuplicate description mentions ${word}`);
  }
  assert.match(byName.timdo_find_by_ref.description, /onDuplicate "report"/, 'find_by_ref points at the race-safe create');
});

test('timdo_find_similar has the schema and guidance an agent needs first time', () => {
  const t = byName.timdo_find_similar;
  assert.deepEqual(t.inputSchema.required, ['title']);
  for (const p of ['title', 'project', 'projectId', 'workspace', 'limit', 'excludeId', 'asUser']) {
    assert.ok(t.inputSchema.properties[p], `find_similar takes ${p}`);
  }
  assert.match(t.description, /before timdo_add_task/);
  assert.match(t.description, /timdo_add_note/);
  assert.match(t.description, /canEdit/);
  assert.match(t.description, /read-only/);
  assert.match(t.description, /empty array means\s+nothing looks similar/);
  assert.match(t.description, /Done and deleted tasks never appear/);
  assert.ok(!t.description.includes('\u2014'));
});

test('timdo_merge_tasks warns that the immediate merge needs explicit confirmation', () => {
  const merge = byName.timdo_merge_tasks;
  assert.match(merge.description, /acts immediately/i);
  assert.match(merge.description, /explicit user confirmation of the exact source and target/i);
  assert.deepEqual(TIMDO_ARG_BUILDERS.timdo_merge_tasks({ sourceId: 'aaaa1111', targetId: 'bbbb2222' }), [
    'merge', 'aaaa1111', 'bbbb2222', '--yes',
  ]);
});

test('dedup params map to the right CLI arguments', () => {
  const b = TIMDO_ARG_BUILDERS;
  assert.deepEqual(
    b.timdo_add_task({ project: 'Broken offer page', category: 'Acme Solar', refs: [{ ref: 'forum.post:4411', role: 'source' }], onDuplicate: 'Report' }),
    ['add', '--title', 'Broken offer page', '-p', 'Acme Solar', '--source', 'forum.post:4411', '--on-duplicate', 'report']
  );
  assert.deepEqual(b.timdo_add_task({ project: 'T', category: 'C' }), ['add', '--title', 'T', '-p', 'C']);
  assert.throws(() => b.timdo_add_task({ project: 'T', category: 'C', onDuplicate: 'skip' }), /onDuplicate must be error, return or report/);
  assert.deepEqual(b.timdo_find_similar({ title: 'Fix the offer page', project: 'Acme Solar' }), [
    'similar', '--title', 'Fix the offer page', '-p', 'Acme Solar',
  ]);
  assert.deepEqual(
    b.timdo_find_similar({ title: '-5 degrees freezer alarm', projectId: 'ACME', workspace: 'Acme', limit: 25, excludeId: 'aaaa1111' }),
    ['similar', '--title', '-5 degrees freezer alarm', '--project-id', 'ACME', '--workspace', 'Acme', '--limit', '10', '--exclude', 'aaaa1111']
  );
  assert.throws(() => b.timdo_find_similar({}), /title is required/);
  assert.throws(() => b.timdo_find_similar({ title: 'Offer page', limit: 0 }), /limit must be a whole number/);
});

test('the clash hint points an agent at onDuplicate, and return does not link', async () => {
  assert.equal(
    toolHints('Already tracked: forum.post:4411 is already the source of aaaa1111 "T". Open it with: timdo get aaaa1111. To add this report to that task instead: --on-duplicate report'),
    'Already tracked: forum.post:4411 is already the source of aaaa1111 "T". Open it with: timdo_get_task with id "aaaa1111". To add this report to that task instead: call timdo_add_task again with onDuplicate "report"'
  );
  const calls = [];
  const fakeRun = (result) => async (args) => {
    calls.push(args);
    return args[0] === 'add' ? result : { ok: true };
  };
  const base = { project: 'T', category: 'Acme Solar', refs: ['forum.post:4411'], linkTaskId: 'bbbb2222' };
  await handleTimdoTool('timdo_add_task', { ...base, onDuplicate: 'return' }, fakeRun({ id: 'old', created: false }));
  assert.equal(calls.length, 1, 'return made no link');
  await handleTimdoTool('timdo_add_task', { ...base, onDuplicate: 'report' }, fakeRun({ id: 'old', created: false, reported: true }));
  assert.deepEqual(calls[2], ['link', 'old', 'bbbb2222', '--type', 'relates_to'], 'report links the task it reported to');
});

test('end to end: onDuplicate and find_similar run the real bin/timdo and return created and similar', async () => {
  const T1 = 'aaaa1111-0000-4000-8000-000000000001';
  const similar = [{ id: T1, shortId: 'aaaa1111', title: 'Broken offer page', status: 'do', projectName: 'Acme Solar', orgName: 'Acme', assigneeName: 'Robin Fairweather', score: 0.67, matchedRef: false, canEdit: true }];
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, path: url.pathname, query: url.search, body });
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && url.pathname === '/api/v2/tasks/similar') return send(200, similar);
      if (req.method === 'POST' && url.pathname === '/api/v2/projects') {
        if (body.onDuplicate === 'report') return send(200, { id: T1, project: 'Broken offer page', refs: [], created: false, reported: true });
        return send(201, { id: 'new-task-id', project: body.project, refs: [], created: true, similar });
      }
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    TIMDO_API: `http://127.0.0.1:${server.address().port}/api/v2`,
    TIMDO_SECRET: 'test-secret',
    TIMDO_CONFIG: '/dev/null',
    NO_COLOR: '1',
    // Even if the environment forces prompts, the MCP path (--json) must never ask
    TIMDO_FORCE_TTY: '1',
  });
  delete process.env.TIMDO_TOKEN;
  delete process.env.TIMDO_AS;
  try {
    const found = await handleTimdoTool('timdo_find_similar', { title: 'Fix the offer page', project: 'Acme Solar', limit: 5 });
    assert.ok(seen.some((s) => s.query === '?title=Fix%20the%20offer%20page&category=Acme%20Solar&limit=5'), 'find_similar query');
    assert.equal(JSON.parse(found.content[0].text)[0].shortId, 'aaaa1111');
    assert.equal(JSON.parse(found.content[0].text)[0].canEdit, true);

    const created = JSON.parse((await handleTimdoTool('timdo_add_task', { project: 'Fix the offer page', category: 'Acme Solar' })).content[0].text);
    assert.equal(created.created, true);
    assert.equal(created.similar[0].id, T1);
    assert.equal(seen.filter((s) => s.path === '/api/v2/tasks/similar').length, 1, 'add never checks first through MCP');

    const reported = JSON.parse(
      (await handleTimdoTool('timdo_add_task', {
        project: 'Offer page down',
        category: 'Acme Solar',
        refs: [{ ref: 'forum.post:4411', role: 'source' }, { ref: 'acme.member:123456', role: 'reported_by' }],
        onDuplicate: 'report',
      })).content[0].text
    );
    assert.deepEqual([reported.id, reported.created, reported.reported], [T1, false, true]);
    assert.equal(seen.at(-1).body.onDuplicate, 'report');
  } finally {
    process.env = saved;
    server.close();
  }
});
