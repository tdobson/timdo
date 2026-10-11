import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cli from '../src/timdo-cli.js';
import { TIMDO_TOOLS, TIMDO_ARG_BUILDERS, handleTimdoTool } from '../src/timdo-tools.js';

const execFileAsync = promisify(execFile);
const toolByName = Object.fromEntries(TIMDO_TOOLS.map((tool) => [tool.name, tool]));

function pageItem(id, project, overrides = {}) {
  return {
    id,
    project,
    status: 'delay',
    priority: 5,
    projectId: `project-${project}`,
    projectName: project,
    category: project,
    orgId: 'workspace-fictional',
    orgName: 'Fictional Workshop',
    isShared: true,
    epicId: null,
    assigneeId: null,
    assigneeName: null,
    ...overrides,
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v2`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function cliEnv(api) {
  return {
    ...process.env,
    TIMDO_API: api,
    TIMDO_SECRET: 'fictional-test-secret',
    TIMDO_TOKEN: '',
    TIMDO_AS: '',
    TIMDO_CONFIG: '/dev/null',
    NO_COLOR: '1',
  };
}

async function runCli(api, args) {
  return execFileAsync(cli.DEFAULT_TIMDO_BIN, ['--json', '--', ...args], {
    env: cliEnv(api),
    maxBuffer: 2 * 1024 * 1024,
  });
}

function queryObject(url) {
  return Object.fromEntries(new URL(url, 'http://fixture').searchParams.entries());
}

test('CLI list forwards filters and returns final response headers across pages', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (url.pathname !== '/api/v2/projects') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (!url.searchParams.has('cursor')) {
      res.writeEarlyHints({ 'X-Total-Count': '999', 'X-Next-Cursor': 'interim_cursor' });
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-total-count': '4',
        'X-NEXT-CURSOR': 'cursor_page_2',
      });
      res.end(JSON.stringify([pageItem('task-1', 'Northstar'), pageItem('task-2', 'Acme')]));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Total-Count': '4' });
    res.end(JSON.stringify([pageItem('task-3', 'Northstar')]));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}/api/v2`;
  try {
    const first = await runCli(api, [
      'list',
      'delay',
      '--limit',
      '2',
      '--fields',
      'summary',
      '--group-by',
      'project',
      '-p',
      'Fictional Project',
      '--customer',
      'Example Co',
      '--tag',
      'demo',
      '--related-to',
      'task-prefix',
      '--assignee',
      'unassigned',
      '--shared',
      '--no-epic',
      '--no-goal',
      '--no-category',
      '--unlinked',
      'any',
      '--ref',
      'fixture.issue:sample#12',
      '--ref-role',
      'about',
    ]);
    const firstResult = JSON.parse(first.stdout);
    assert.deepEqual(firstResult, {
      items: [pageItem('task-1', 'Northstar'), pageItem('task-2', 'Acme')],
      nextCursor: 'cursor_page_2',
      total: 4,
    });
    assert.equal(first.stderr, '');

    const firstQuery = queryObject(requests[0].url);
    assert.deepEqual(firstQuery, {
      status: 'delay',
      category: 'Fictional Project',
      customer: 'Example Co',
      tag: 'demo',
      relatedTo: 'task-prefix',
      assignee: 'unassigned',
      ref: 'fixture.issue:sample#12',
      role: 'about',
      shared: 'true',
      noEpic: 'true',
      noGoal: 'true',
      noCategory: 'true',
      unlinked: 'any',
      limit: '2',
      fields: 'summary',
    });
    assert.equal(firstQuery.cursor, undefined);

    const second = await runCli(api, [
      'list',
      'delay',
      '--limit',
      '2',
      '--fields',
      'summary',
      '--cursor',
      firstResult.nextCursor,
    ]);
    assert.deepEqual(JSON.parse(second.stdout), {
      items: [pageItem('task-3', 'Northstar')],
      nextCursor: null,
      total: 4,
    });
    assert.equal(queryObject(requests[1].url).cursor, 'cursor_page_2');
    assert.equal(requests.length, 2, 'each page is a fresh HTTP request, not a body-only cache hit');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('MCP list returns large full pages with complete notes and cursor metadata', async () => {
  const items = Array.from({ length: 200 }, (_, index) =>
    pageItem(`task-large-${index + 1}`, 'Fictional Project', { notes: 'x'.repeat(1024) })
  );
  const pageBody = JSON.stringify(items);
  assert.ok(Buffer.byteLength(pageBody) > 128 * 1024);

  await withServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Total-Count': '250',
      'X-Next-Cursor': 'cursor_page_201',
    });
    res.end(pageBody);
  }, async (api) => {
    const result = await handleTimdoTool(
      'timdo_list_tasks',
      { status: 'all', limit: 200, fields: 'full' },
      async (args) => JSON.parse((await runCli(api, args)).stdout)
    );
    const output = JSON.parse(result.content[0].text);

    assert.deepEqual(output.items, items);
    assert.equal(output.total, 250);
    assert.equal(output.nextCursor, 'cursor_page_201');
  });
});

test('CLI no-limit list keeps the full-array response and counts apply server filters', async () => {
  const requests = [];
  await withServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/projects') {
      res.writeHead(200, { 'X-Total-Count': '1', 'X-Next-Cursor': 'not-for-unlimited' });
      res.end(JSON.stringify([pageItem('task-full', 'Fictional Project', { notes: 'full body' })]));
      return;
    }
    if (url.pathname === '/api/v2/projects/counts') {
      res.writeHead(200);
      res.end(JSON.stringify({ byStatus: { do: 2, delay: 3, awaiting: 0, delegate: 1, done: 4 }, total: 10 }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }, async (api) => {
    const all = await runCli(api, ['list', 'all']);
    assert.ok(Array.isArray(JSON.parse(all.stdout)));
    assert.equal(JSON.parse(all.stdout)[0].notes, 'full body');
    assert.equal(requests[0].url, '/api/v2/projects');

    const counts = await runCli(api, [
      'counts',
      '--customer',
      'Example Co',
      '--shared',
      '--no-epic',
      '--no-goal',
      '--no-category',
      '--unlinked',
      'any',
      '--ref',
      'fixture.issue:sample#12',
      '--ref-role',
      'source',
    ]);
    assert.deepEqual(JSON.parse(counts.stdout), {
      byStatus: { do: 2, delay: 3, awaiting: 0, delegate: 1, done: 4 },
      total: 10,
    });
    assert.equal(new URL(requests[1].url, 'http://fixture').pathname, '/api/v2/projects/counts');
    assert.deepEqual(queryObject(requests[1].url), {
      customer: 'Example Co',
      ref: 'fixture.issue:sample#12',
      role: 'source',
      shared: 'true',
      noEpic: 'true',
      noGoal: 'true',
      noCategory: 'true',
      unlinked: 'any',
    });

    await runCli(api, ['counts', '--status', 'do,delay']);
    assert.deepEqual(queryObject(requests[2].url), { status: 'do,delay' });
  });
});

test('CLI resolves hierarchy and member filters before building a paged server query', async () => {
  const requests = [];
  await withServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    requests.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v2/organisations/sharing') {
      res.writeHead(200);
      res.end(JSON.stringify([{
        id: 'workspace-fictional',
        name: 'Fictional Workshop',
        slug: 'fictional-workshop',
        isPersonal: false,
        role: 'owner',
        projects: [{ id: 'project-fictional', key: 'FIC', name: 'Fictional Project' }],
        members: [{ userId: 'member-fictional', userName: 'Fictional Member', userEmail: 'member@example.com' }],
      }]));
      return;
    }
    if (url.pathname === '/api/v2/epics') {
      res.writeHead(200);
      res.end(JSON.stringify([{ id: 'epic-fictional', title: 'Fictional Epic' }]));
      return;
    }
    if (url.pathname === '/api/v2/goals') {
      res.writeHead(200);
      res.end(JSON.stringify([{ id: 'goal-fictional', title: 'Fictional Goal' }]));
      return;
    }
    if (url.pathname === '/api/v2/projects') {
      res.writeHead(200, { 'X-Total-Count': '8' });
      res.end(JSON.stringify([pageItem('task-resolved', 'Fictional Project')]));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }, async (api) => {
    const result = await runCli(api, [
      'list',
      'all',
      '--limit',
      '1',
      '--fields',
      'summary',
      '--project-id',
      'FIC',
      '--workspace',
      'Fictional Workshop',
      '--epic',
      'Fictional Epic',
      '--goal',
      'Fictional Goal',
      '--assignee',
      'Fictional Member',
    ]);
    assert.deepEqual(JSON.parse(result.stdout), {
      items: [pageItem('task-resolved', 'Fictional Project')],
      nextCursor: null,
      total: 8,
    });
    const pageRequest = requests.find((request) => new URL(request.url, 'http://fixture').pathname === '/api/v2/projects');
    assert.deepEqual(queryObject(pageRequest.url), {
      projectId: 'project-fictional',
      orgId: 'workspace-fictional',
      epicId: 'epic-fictional',
      goalId: 'goal-fictional',
      assignee: 'member-fictional',
      limit: '1',
      fields: 'summary',
    });
  });
});

test('CLI rejects invalid page values and flag-like cursors before making a request', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  }, async (api) => {
    for (const limit of ['0', '201', '1.5', '999999999999999999999']) {
      await assert.rejects(
        () => runCli(api, ['list', '--limit', limit]),
        (error) => {
          assert.match(error.stderr, /--limit.*1.*200/i);
          assert.equal(error.stdout, '');
          return true;
        }
      );
    }
    await assert.rejects(
      () => runCli(api, ['list', '--limit', '1', '--cursor', '--as=victim@example.com']),
      (error) => {
        assert.match(error.stderr, /cursor/i);
        assert.equal(error.stdout, '');
        return true;
      }
    );
    await assert.rejects(
      () => execFileAsync(cli.DEFAULT_TIMDO_BIN, ['--json', 'list', '--limit', '1', '--cursor', '--as=victim@example.com'], {
        env: cliEnv(api),
      }),
      (error) => {
        assert.match(error.stderr, /cursor/i);
        assert.equal(error.stdout, '');
        return true;
      }
    );
    await assert.rejects(() => runCli(api, ['list', '--fields=']), /--fields/);
    await assert.rejects(() => runCli(api, ['list', '--group-by=']), /--group-by/);
    assert.equal(requests, 0);
  });
});

test('paged API errors stay on stderr and never include credentials in JSON stdout', async () => {
  await withServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'That page link has expired' }));
  }, async (api) => {
    await assert.rejects(
      () => runCli(api, ['list', '--limit', '1']),
      (error) => {
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /page link has expired/i);
        assert.doesNotMatch(error.stderr, /fictional-test-secret/);
        return true;
      }
    );
  });
});

test('find forwards list paging and presentation options without changing the ref filter', async () => {
  let requestUrl = '';
  await withServer((req, res) => {
    requestUrl = req.url;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Total-Count': '3',
      'X-Next-Cursor': 'find_cursor_2',
    });
    res.end(JSON.stringify([pageItem('task-find', 'Fictional Project')]));
  }, async (api) => {
    const result = await runCli(api, [
      'find',
      'fixture.issue:sample#12',
      '--status',
      'do,delay',
      '--limit',
      '1',
      '--cursor',
      'find_cursor_1',
      '--group-by',
      'project',
      '--fields',
      'summary',
      '--shared',
    ]);
    assert.equal(JSON.parse(result.stdout).nextCursor, 'find_cursor_2');
    assert.deepEqual(queryObject(requestUrl), {
      status: 'do,delay',
      ref: 'fixture.issue:sample#12',
      shared: 'true',
      limit: '1',
      cursor: 'find_cursor_1',
      fields: 'summary',
    });
  });
});

test('CLI text grouping only labels the current page and leaves its continuation alone', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Total-Count': '90',
      'X-Next-Cursor': 'cursor_next',
    });
    res.end(JSON.stringify([pageItem('task-1', 'Northstar'), pageItem('task-2', 'Acme')]));
  }, async (api) => {
    const { stdout } = await execFileAsync(cli.DEFAULT_TIMDO_BIN, [
      '--text', '--', 'list', 'delay', '--limit', '2', '--group-by', 'project',
    ], { env: cliEnv(api), maxBuffer: 2 * 1024 * 1024 });
    assert.match(stdout, /Northstar/);
    assert.match(stdout, /Acme/);
    assert.match(stdout, /cursor_next/);
    assert.match(stdout, /90/);
  });
});

test('MCP list defaults to bounded summaries, counts is available, and groupBy is page-local', async () => {
  assert.deepEqual(cli.buildListTasksArgs({ status: 'do,delay' }), ['list', '--status', 'do,delay']);
  assert.deepEqual(cli.buildCountsArgs({ status: 'do,delay', shared: true }), [
    'counts', '--status', 'do,delay', '--shared',
  ]);
  assert.throws(() => cli.buildListTasksArgs({ status: 'do,--as=victim@example.com' }), /status/i);
  assert.throws(() => cli.buildListTasksArgs({ status: '' }), /status/i);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_counts({ status: '' }), /status/i);
  assert.deepEqual(TIMDO_ARG_BUILDERS.timdo_list_tasks({}), [
    'list', 'do', '--limit', '50', '--fields', 'summary',
  ]);
  assert.deepEqual(TIMDO_ARG_BUILDERS.timdo_list_tasks({ status: 'all', limit: 200, cursor: 'cursor_2', groupBy: 'epic', fields: 'full' }), [
    'list', 'all', '--limit', '200', '--cursor', 'cursor_2', '--group-by', 'epic', '--fields', 'full',
  ]);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ limit: 0 }), /1.*200/);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ limit: 201 }), /1.*200/);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ cursor: '--as=victim@example.com' }), /cursor/i);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ groupBy: 'workspace' }), /groupBy/i);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ fields: 'notes' }), /fields/i);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ fields: '' }), /fields/i);
  assert.throws(() => TIMDO_ARG_BUILDERS.timdo_list_tasks({ groupBy: '' }), /groupBy/i);
  assert.ok(toolByName.timdo_counts, 'the aggregate count tool is registered');
  assert.ok(TIMDO_ARG_BUILDERS.timdo_counts, 'the aggregate count tool has a builder');
  assert.equal(toolByName.timdo_list_tasks.inputSchema.properties.limit.default, 50);
  assert.deepEqual(toolByName.timdo_list_tasks.inputSchema.properties.groupBy.enum, ['project', 'epic', 'assignee']);

  const calls = [];
  const page = {
    items: [pageItem('task-1', 'Northstar', { epicId: 'epic-one' }), pageItem('task-2', 'Northstar', { epicId: null })],
    nextCursor: 'cursor_after_page',
    total: 60,
  };
  const result = await handleTimdoTool('timdo_list_tasks', { groupBy: 'epic' }, async (args) => {
    calls.push(args);
    return page;
  });
  const output = JSON.parse(result.content[0].text);
  assert.deepEqual(calls[0], ['list', 'do', '--limit', '50', '--group-by', 'epic', '--fields', 'summary']);
  assert.equal(output.nextCursor, 'cursor_after_page');
  assert.equal(output.total, 60);
  assert.deepEqual(output.items, page.items, 'grouping does not change the flat page rows');
  assert.deepEqual(output.groups, [
    { key: 'epic-one', label: 'Epic epic-one', taskIds: ['task-1'] },
    { key: null, label: 'No epic', taskIds: ['task-2'] },
  ]);

  const counts = JSON.parse((await handleTimdoTool('timdo_counts', { status: 'done' }, async (args) => {
    calls.push(args);
    return { byStatus: { do: 0, delay: 0, awaiting: 0, delegate: 0, done: 2 }, total: 2 };
  })).content[0].text);
  assert.deepEqual(calls[1], ['counts', 'done']);
  assert.equal(counts.total, 2);
});
