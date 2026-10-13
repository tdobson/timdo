import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildActivityArgs,
  buildAddEpicArgs,
  buildAddRefArgs,
  buildAddTaskArgs,
  buildAuditArgs,
  buildDeleteEpicArgs,
  buildEventsArgs,
  buildFindByRefArgs,
  buildFindSimilarArgs,
  buildGetEpicArgs,
  buildGetWorkspaceArgs,
  buildListEpicsArgs,
  buildListGoalsArgs,
  buildListTasksArgs,
  buildListWorkspacesArgs,
  buildMoveProjectArgs,
  buildRefFlags,
  buildRemoveMemberArgs,
  buildRemoveRefArgs,
  buildShareWorkspaceArgs,
  buildUnrefFlags,
  buildUpdateEpicArgs,
  buildUpdateMemberRoleArgs,
  buildUpdateTaskArgs,
  buildWhoamiArgs,
  DEFAULT_TIMDO_BIN,
  getTimdoBinaryPath,
  normaliseOnDuplicate,
  normaliseRefRole,
  normaliseRefs,
  ON_DUPLICATE,
  runTimdoCli,
} from '../src/timdo-cli.js';

test("DEFAULT_TIMDO_BIN is this repo's bin/timdo, found relative to the module", () => {
  const repoBin = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/timdo');
  assert.equal(DEFAULT_TIMDO_BIN, repoBin);
  assert.ok(existsSync(DEFAULT_TIMDO_BIN), 'bin/timdo exists');
});

test('getTimdoBinaryPath prefers TIMDO_BIN, then the repo binary', () => {
  assert.equal(getTimdoBinaryPath({ TIMDO_BIN: '/opt/custom/timdo' }), '/opt/custom/timdo');
  assert.equal(getTimdoBinaryPath({}), DEFAULT_TIMDO_BIN);
  const p = getTimdoBinaryPath();
  assert.ok(typeof p === 'string' && p.length > 0);
});

test('runTimdoCli passes --json and asUser (as TIMDO_AS) to the binary and parses JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timdo-mcp-test-'));
  const fake = join(dir, 'timdo');
  writeFileSync(
    fake,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), as: process.env.TIMDO_AS || null }));\n'
  );
  chmodSync(fake, 0o755);
  try {
    const out = await runTimdoCli(['whoami'], fake, { asUser: 'robin@example.com' });
    assert.deepEqual(out, { argv: ['--json', '--', 'whoami'], as: 'robin@example.com' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTimdoCli gives oversized events pages recovery guidance without changing other errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timdo-mcp-events-overflow-'));
  const fake = join(dir, 'timdo');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv.includes('events')) {
  const refs = Array.from({ length: 40 }, () => ({ role: 'link', ref: 'fictional.kind:' + 'x'.repeat(485) }));
  process.stdout.write('{"version":1,"events":[');
  for (let i = 0; i < 500; i += 1) {
    if (i) process.stdout.write(',');
    process.stdout.write(JSON.stringify({
      id: 'evt-fictional-' + i,
      type: 'ref.added',
      occurredAt: '2026-10-11T10:00:00.000Z',
      workspaceId: 'ws-fictional-1',
      projectId: 'project-fictional-1',
      taskId: 'task-fictional-1',
      epicId: null,
      actor: { id: 'user-fictional-1', kind: 'human' },
      via: 'web',
      refs,
    }));
  }
  process.stdout.write('],"next":"c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","hasMore":true}');
} else {
  process.stdout.write('x'.repeat(11 * 1024 * 1024));
}
`
  );
  chmodSync(fake, 0o755);
  try {
    await assert.rejects(
      runTimdoCli(['events', '--after', 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'], fake),
      (error) => {
        assert.match(error.message, /10 MiB CLI output limit/);
        assert.match(error.message, /same after cursor and a smaller limit/);
        assert.match(error.message, /omit includeRefs or includeText/);
        assert.match(error.message, /No complete page was returned/);
        assert.doesNotMatch(error.message, /evt-fictional|fictional\\.kind/);
        return true;
      }
    );
    await assert.rejects(runTimdoCli(['whoami'], fake), (error) => {
      assert.match(error.message, /^timdo CLI error: /);
      assert.doesNotMatch(error.message, /same after cursor|10 MiB CLI output limit/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildListTasksArgs formats status and filters correctly', () => {
  assert.deepEqual(buildListTasksArgs(), ['list', 'do']);
  assert.deepEqual(
    buildListTasksArgs({
      status: 'awaiting',
      category: 'Acme Solar',
      epic: 'Battery',
      goal: 'revenue',
    }),
    ['list', 'awaiting', '-p', 'Acme Solar', '-e', 'Battery', '-g', 'revenue']
  );
  assert.deepEqual(buildListTasksArgs({ status: 'all' }), ['list', 'all']);
});

test('buildAddTaskArgs builds comprehensive add arguments', () => {
  const args = buildAddTaskArgs({
    project: 'Audit inverter voltage',
    reason: 'Prevent trip',
    priority: 8,
    status: 'awaiting',
    size: '**',
    awaitUntil: '2026-09-15',
    category: 'Acme Solar',
    epic: 'Battery',
    goal: 'revenue',
    thread: 'thread_xyz',
    notes: 'initial note',
  });
  assert.deepEqual(args, [
    'add',
    '--title',
    'Audit inverter voltage',
    '-r',
    'Prevent trip',
    '-s',
    'awaiting',
    '--priority',
    '8',
    '--size',
    '**',
    '-p',
    'Acme Solar',
    '-e',
    'Battery',
    '-g',
    'revenue',
    '--await-until',
    '2026-09-15',
    '--thread',
    'thread_xyz',
    '-n',
    'initial note',
  ]);
});

test('buildAddTaskArgs sends a dash-prefixed title as a value, never as a CLI flag', () => {
  assert.deepEqual(
    buildAddTaskArgs({ project: '--reason', reason: 'Broken offer page', category: 'Acme Solar' }),
    ['add', '--title', '--reason', '-r', 'Broken offer page', '-p', 'Acme Solar']
  );
});

test('buildAddTaskArgs throws when project title is missing', () => {
  assert.throws(() => buildAddTaskArgs(), /Task title \(project\) is required\./);
  assert.throws(() => buildAddTaskArgs({ project: '' }), /Task title \(project\) is required\./);
});

test('buildUpdateTaskArgs formats shorthand status flags and attributes', () => {
  const args = buildUpdateTaskArgs({
    id: 'ea9f',
    status: 'done',
    priority: 9,
  });
  assert.deepEqual(args, ['update', 'ea9f', '--done', '--priority', '9']);

  const argsCustomStatus = buildUpdateTaskArgs({
    id: 'ea9f',
    status: 'custom_status',
    project: 'Renamed',
    reason: 'Updated reason',
    size: '***',
    category: 'Personal',
    epic: 'Fitness',
    goal: 'health',
    awaitUntil: '2026-10-01',
    thread: 't123',
    notes: 'updated note',
  });
  assert.deepEqual(argsCustomStatus, [
    'update',
    'ea9f',
    '--project',
    'Renamed',
    '-r',
    'Updated reason',
    '-s',
    'custom_status',
    '--size',
    '***',
    '-p',
    'Personal',
    '-e',
    'Fitness',
    '-g',
    'health',
    '--await-until',
    '2026-10-01',
    '--thread',
    't123',
    '-n',
    'updated note',
  ]);

  for (const status of ['done', 'do', 'delay', 'delegate', 'awaiting']) {
    assert.deepEqual(buildUpdateTaskArgs({ id: '123', status }), ['update', '123', `--${status}`]);
  }
});

test('buildUpdateTaskArgs throws when id is missing', () => {
  assert.throws(() => buildUpdateTaskArgs(), /Task ID is required for update\./);
  assert.throws(() => buildUpdateTaskArgs({ id: '' }), /Task ID is required for update\./);
});

test('buildListEpicsArgs formats epic arguments', () => {
  assert.deepEqual(buildListEpicsArgs(), ['epic', 'list']);
  assert.deepEqual(buildListEpicsArgs({ category: 'Acme Solar' }), [
    'epic',
    'list',
    '-p',
    'Acme Solar',
  ]);
});

test('buildAddEpicArgs formats epic arguments and validates title', () => {
  const args = buildAddEpicArgs({
    title: 'Battery Expansion',
    category: 'Acme Solar',
    goal: 'revenue',
    description: 'Expanding storage capacity',
    status: 'active',
  });
  assert.deepEqual(args, [
    'epic',
    'add',
    'Battery Expansion',
    '-p',
    'Acme Solar',
    '-g',
    'revenue',
    '-d',
    'Expanding storage capacity',
    '--status',
    'active',
  ]);

  assert.throws(() => buildAddEpicArgs(), /Epic title is required\./);
  assert.throws(() => buildAddEpicArgs({ title: '' }), /Epic title is required\./);
});

test('buildUpdateEpicArgs formats update flags correctly', () => {
  const args = buildUpdateEpicArgs({
    id: 'epic-123',
    title: 'Updated Title',
    category: 'Acme Solar',
    status: 'completed',
  });
  assert.deepEqual(args, [
    'epic',
    'update',
    'epic-123',
    '--title',
    'Updated Title',
    '-p',
    'Acme Solar',
    '--status',
    'completed',
  ]);
  assert.throws(() => buildUpdateEpicArgs(), /Epic id or title is required for update\./);
});

test('buildDeleteEpicArgs formats delete args', () => {
  assert.deepEqual(buildDeleteEpicArgs({ id: 'epic-123' }), ['epic', 'delete', 'epic-123']);
  assert.throws(() => buildDeleteEpicArgs(), /Epic id or title is required for delete\./);
});

test('buildGetEpicArgs formats get args', () => {
  assert.deepEqual(buildGetEpicArgs({ id: 'epic-123' }), ['epic', 'get', 'epic-123']);
  assert.throws(() => buildGetEpicArgs(), /Epic id or title is required\./);
});

test('buildListGoalsArgs formats goal arguments', () => {
  assert.deepEqual(buildListGoalsArgs(), ['goal', 'list']);
  assert.deepEqual(buildListGoalsArgs({ type: 'annual' }), ['goal', 'list', '-t', 'annual']);
});

test('buildListTasksArgs formats unlinked and hierarchy filters', () => {
  assert.deepEqual(
    buildListTasksArgs({ noEpic: true, noGoal: true, noCategory: true, unlinked: 'any' }),
    ['list', 'do', '--no-epic', '--no-goal', '--no-category', '--unlinked', 'any']
  );
});

test('buildAuditArgs returns audit subcommand', () => {
  assert.deepEqual(buildAuditArgs(), ['audit']);
});

test('runTimdoCli handles missing or invalid binaries gracefully', async () => {
  await assert.rejects(async () => {
    await runTimdoCli(['list'], '/non/existent/bin/path');
  }, /timdo CLI error:/);
});

test('buildListTasksArgs adds multi-user filters after the existing ones', () => {
  assert.deepEqual(
    buildListTasksArgs({
      status: 'do',
      category: 'Acme Solar',
      workspace: 'Acme',
      assignee: 'robin',
    }),
    ['list', 'do', '-p', 'Acme Solar', '--workspace', 'Acme', '--assignee', 'robin']
  );
  assert.deepEqual(buildListTasksArgs({ mine: true }), ['list', 'do', '--mine']);
  assert.deepEqual(buildListTasksArgs({ unassigned: true, shared: true }), [
    'list',
    'do',
    '--unassigned',
    '--shared',
  ]);
  assert.deepEqual(buildListTasksArgs({ projectId: 'SOL', assignee: 'me', mine: true }), [
    'list',
    'do',
    '--project-id',
    'SOL',
    '--assignee',
    'me',
  ]);
});

test('buildAddTaskArgs and buildUpdateTaskArgs pass assignment and exact project', () => {
  assert.deepEqual(
    buildAddTaskArgs({
      project: 'Fix inverter',
      category: 'Acme Solar',
      assignTo: 'robin@example.com',
    }),
    ['add', '--title', 'Fix inverter', '-p', 'Acme Solar', '--assign', 'robin@example.com']
  );
  assert.deepEqual(buildAddTaskArgs({ project: 'Keyed', projectId: 'SOL' }), [
    'add',
    '--title',
    'Keyed',
    '--project-id',
    'SOL',
  ]);
  assert.deepEqual(buildUpdateTaskArgs({ id: 'ab12', claim: true }), ['update', 'ab12', '--claim']);
  assert.deepEqual(buildUpdateTaskArgs({ id: 'ab12', unassign: true }), [
    'update',
    'ab12',
    '--unassign',
  ]);
  assert.deepEqual(buildUpdateTaskArgs({ id: 'ab12', assignTo: 'none', projectId: 'MIG' }), [
    'update',
    'ab12',
    '--project-id',
    'MIG',
    '--assign',
    'none',
  ]);
});

test('epic and audit builders accept workspace, project and scope options', () => {
  assert.deepEqual(buildListEpicsArgs({ workspace: 'Acme' }), [
    'epic',
    'list',
    '--workspace',
    'Acme',
  ]);
  assert.deepEqual(buildAddEpicArgs({ title: 'T', projectId: 'SOL' }), [
    'epic',
    'add',
    'T',
    '--project-id',
    'SOL',
  ]);
  assert.deepEqual(buildUpdateEpicArgs({ id: 'e1', projectId: 'SOL' }), [
    'epic',
    'update',
    'e1',
    '--project-id',
    'SOL',
  ]);
  assert.deepEqual(buildAuditArgs({ all: true }), ['audit', '--all']);
});

test('events builder creates finite feed arguments and rejects invalid values', () => {
  assert.deepEqual(buildEventsArgs(), ['events']);
  assert.deepEqual(buildEventsArgs({ after: '0' }), ['events', '--after', '0']);
  assert.deepEqual(buildEventsArgs({ after: 'latest' }), ['events', '--after', 'latest']);
  assert.deepEqual(
    buildEventsArgs({
      after: 'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      workspace: 'fictional-workspace',
      types: 'task.updated,task.completed',
      includeRefs: true,
      includeText: true,
      limit: 25,
    }),
    [
      'events',
      '--after',
      'c1.AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '--workspace',
      'fictional-workspace',
      '--types',
      'task.updated,task.completed',
      '--include-refs',
      '--include-text',
      '-n',
      '25',
    ]
  );
  assert.throws(() => buildEventsArgs({ limit: 0 }), /limit must be a whole number from 1 to 500/);
  assert.throws(
    () => buildEventsArgs({ limit: 501 }),
    /limit must be a whole number from 1 to 500/
  );
  assert.throws(
    () => buildEventsArgs({ limit: 25.5 }),
    /limit must be a whole number from 1 to 500/
  );
  assert.throws(
    () => buildEventsArgs({ limit: '1e2' }),
    /limit must be a whole number from 1 to 500/
  );
  assert.throws(() => buildEventsArgs({ after: 'c1.short' }), /cursor/);
  assert.throws(() => buildEventsArgs({ after: '--json' }), /cursor/);
});

test('collaboration builders produce workspace and activity commands', () => {
  assert.deepEqual(
    buildActivityArgs({ taskId: 'ab12', project: 'SOL', workspace: 'MD', limit: 5 }),
    ['activity', '--task', 'ab12', '--project', 'SOL', '--workspace', 'MD', '-n', '5']
  );
  assert.deepEqual(buildActivityArgs(), ['activity']);
  assert.deepEqual(buildWhoamiArgs(), ['whoami']);
  assert.deepEqual(buildListWorkspacesArgs(), ['workspace', 'list']);
  assert.deepEqual(buildGetWorkspaceArgs({ workspace: 'MD' }), ['workspace', 'show', 'MD']);
  assert.deepEqual(buildShareWorkspaceArgs({ workspace: 'MD', email: 'e@x.org' }), [
    'workspace',
    'share',
    'MD',
    'e@x.org',
    '--role',
    'member',
  ]);
  assert.throws(
    () => buildShareWorkspaceArgs({ workspace: 'MD', email: 'e@x.org', role: 'owner' }),
    /admin, member, viewer/
  );
  assert.deepEqual(
    buildUpdateMemberRoleArgs({ workspace: 'MD', member: 'robin', role: 'viewer' }),
    ['workspace', 'role', 'MD', 'robin', 'viewer']
  );
  assert.throws(
    () => buildUpdateMemberRoleArgs({ workspace: 'MD', member: 'robin', role: 'boss' }),
    /owner, admin/
  );
  assert.deepEqual(buildRemoveMemberArgs({ workspace: 'MD', member: 'robin' }), [
    'workspace',
    'remove',
    'MD',
    'robin',
    '--yes',
  ]);
  assert.deepEqual(buildMoveProjectArgs({ project: 'Acme Solar', workspace: 'MD' }), [
    'workspace',
    'move-project',
    'Acme Solar',
    'MD',
    '--yes',
  ]);
  assert.throws(() => buildMoveProjectArgs({ project: 'Acme Solar' }), /required/);
});

test('normaliseRefRole accepts the API spellings and refuses anything else', () => {
  assert.equal(normaliseRefRole(), 'link');
  assert.equal(normaliseRefRole(''), 'link');
  assert.equal(normaliseRefRole('Source'), 'source');
  assert.equal(normaliseRefRole('reported-by'), 'reported_by');
  assert.equal(normaliseRefRole('Reported by'), 'reported_by');
  assert.throws(
    () => normaliseRefRole('reporter'),
    /Role must be link, source, reported_by or about/
  );
});

test('normaliseRefs and the ref flag builders', () => {
  assert.deepEqual(normaliseRefs(), []);
  assert.deepEqual(normaliseRefs('forum.post:1'), [{ ref: 'forum.post:1' }]);
  assert.deepEqual(normaliseRefs('123'), [{ ref: '123' }]);
  assert.deepEqual(normaliseRefs(['a.b:1', { ref: 'c.d:2', role: 'about' }]), [
    { ref: 'a.b:1' },
    { ref: 'c.d:2', role: 'about' },
  ]);
  assert.throws(() => normaliseRefs([{ ref: '' }]), /Each ref needs "ref"/);
  assert.deepEqual(
    buildRefFlags([
      { ref: 'x.y:1', role: 'about' },
      { ref: 'x.y:2', url: 'https://example.com/2' },
    ]),
    [
      '--about',
      'x.y:1',
      '--refs-json',
      '[{"ref":"x.y:2","role":"link","url":"https://example.com/2"}]',
    ]
  );
  assert.deepEqual(buildUnrefFlags(['x.y:1']), ['--unref', 'x.y:1']);
  assert.deepEqual(buildUnrefFlags(), []);
  assert.throws(() => buildUnrefFlags([42]), /removeRefs/);
});

test('ref values that look like CLI flags are refused, so they cannot switch the user', () => {
  const smuggled = '--as=victim@example.com';
  assert.throws(() => buildRefFlags([smuggled]), /never start with "-"/);
  assert.throws(() => buildUnrefFlags([smuggled, '--json']), /never start with "-"/);
  assert.throws(
    () => buildUpdateTaskArgs({ id: '3f2a91c0', status: 'done', removeRefs: [smuggled] }),
    /never start with "-"/
  );
  assert.throws(() => buildAddRefArgs({ id: '3f2a91c0', ref: smuggled }), /never start with "-"/);
  assert.throws(() => buildAddRefArgs({ id: '--as=x', ref: 'forum.post:1' }), /Task ids/);
  assert.throws(
    () => buildAddRefArgs({ id: '3f2a91c0', ref: 'forum.post:1', label: '--json' }),
    /Labels/
  );
  assert.throws(
    () => buildRemoveRefArgs({ id: '3f2a91c0', ref: smuggled }),
    /never start with "-"/
  );
  assert.throws(() => buildFindByRefArgs({ ref: smuggled }), /never start with "-"/);
  assert.throws(() => buildListTasksArgs({ ref: smuggled }), /never start with "-"/);
  // Rich refs travel inside --refs-json, so their labels may say anything
  assert.deepEqual(buildRefFlags([{ ref: 'forum.post:1', label: '-5 degrees' }]), [
    '--refs-json',
    '[{"ref":"forum.post:1","role":"link","label":"-5 degrees"}]',
  ]);
});

test('bin/timdo treats everything after "--" as subcommand data, not global flags', async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const actingAs = [];
  const server = createServer((req, res) => {
    actingAs.push(req.headers['x-timdo-user'] || null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const dir = mkdtempSync(join(tmpdir(), 'timdo-mcp-test-'));
  const env = {
    ...process.env,
    TIMDO_API: `http://127.0.0.1:${server.address().port}/api/v2`,
    TIMDO_SECRET: 'x',
    TIMDO_AS: '',
  };
  const run = (args) =>
    new Promise((done) => execFile(DEFAULT_TIMDO_BIN, args, { env, cwd: dir }, () => done()));
  // What buildUpdateTaskArgs made of removeRefs ['--as=victim@example.com', '--json'] before
  const smuggled = [
    'update',
    '3f2a91c0',
    '--done',
    '--unref',
    '--as=victim@example.com',
    '--unref',
    '--json',
  ];
  try {
    // Without the separator the CLI's global parser takes the flag: the hole being closed
    await run(['--json', ...smuggled]);
    assert.ok(actingAs.includes('victim@example.com'));
    actingAs.length = 0;
    await run(['--json', '--', ...smuggled]);
    assert.ok(actingAs.length > 0);
    assert.ok(!actingAs.includes('victim@example.com'));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normaliseOnDuplicate accepts the three modes in any case and refuses anything else', () => {
  assert.deepEqual(ON_DUPLICATE, ['error', 'return', 'report']);
  assert.equal(normaliseOnDuplicate(' Report '), 'report');
  assert.equal(normaliseOnDuplicate('return'), 'return');
  assert.throws(
    () => normaliseOnDuplicate('ignore'),
    /onDuplicate must be error, return or report/
  );
});

test('buildAddTaskArgs puts --on-duplicate after the refs, and buildFindSimilarArgs scopes the check', () => {
  assert.deepEqual(
    buildAddTaskArgs({
      project: 'Broken offer page',
      category: 'Acme Solar',
      refs: ['forum.post:4411'],
      onDuplicate: 'return',
    }),
    [
      'add',
      '--title',
      'Broken offer page',
      '-p',
      'Acme Solar',
      '--ref',
      'forum.post:4411',
      '--on-duplicate',
      'return',
    ]
  );
  assert.deepEqual(buildFindSimilarArgs({ title: 'Offer page broken', workspace: 'Acme' }), [
    'similar',
    '--title',
    'Offer page broken',
    '--workspace',
    'Acme',
  ]);
  assert.throws(() => buildFindSimilarArgs({ title: '  ' }), /title is required/);
  assert.throws(
    () => buildFindSimilarArgs({ title: 'Offer page', excludeId: '--as=x' }),
    /never start with "-"/
  );
});
