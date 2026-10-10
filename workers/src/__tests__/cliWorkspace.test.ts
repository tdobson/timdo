// Multi-user behaviour of bin/timdo against an in-process mock of the v2 API.
// Checks the requests the CLI sends (filters, X-Timdo-User, bodies) and what it prints.
import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BIN = path.resolve(__dirname, '../../../bin/timdo');

const TIM = 'user-tim';
const ED = 'user-ed';

type Req = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: any };
let requests: Req[] = [];
let viewerMode = false;
let baseUrl = '';
let server: http.Server;

const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  userId: TIM,
  project: title,
  reason: 'Because',
  status: 'do',
  priority: 7,
  size: '**',
  notes: null,
  awaitUntil: null,
  gmailThreadId: null,
  category: 'Acme Solar',
  customer: null,
  tags: null,
  epicId: null,
  goalId: null,
  isDeleted: false,
  createdAt: '2026-10-01 09:00:00',
  updatedAt: '2026-10-08T13:02:00.000Z',
  projectId: 'proj-acme-solar',
  projectKey: 'ACS',
  projectName: 'Acme Solar',
  orgId: 'org-md',
  orgName: 'Northstar Workshop',
  isShared: true,
  myRole: 'owner',
  canEdit: true,
  reporterId: TIM,
  reporterName: 'Casey Example',
  assigneeId: TIM,
  assigneeName: 'Casey Example',
  updatedById: ED,
  updatedByName: 'Jordan Example',
  isMine: true,
  ...extra,
});

const TASKS = [
  task('aaaa1111-0000-0000-0000-000000000001', 'Fix inverter'),
  task('bbbb2222-0000-0000-0000-000000000002', 'Check flashing', {
    assigneeId: ED,
    assigneeName: 'Jordan Example',
    isMine: false,
  }),
  task('cccc3333-0000-0000-0000-000000000003', 'Renew passport', {
    category: 'Personal',
    projectId: 'proj-per',
    projectKey: 'PER',
    projectName: 'Personal',
    orgId: 'org-tim',
    orgName: 'Personal Workspace',
    isShared: false,
  }),
];

const SHARING = [
  {
    id: 'org-tim',
    name: 'Personal Workspace',
    isPersonal: true,
    role: 'owner',
    memberCount: 1,
    projectCount: 1,
    members: [{ userId: TIM, userName: 'Casey Example', userEmail: 'casey@example.test', role: 'owner', isMe: true }],
    projects: [{ id: 'proj-per', key: 'PER', name: 'Personal', openTasks: 1, doneTasks: 0, epicCount: 0 }],
    invites: [],
  },
  {
    id: 'org-md',
    name: 'Northstar Workshop',
    isPersonal: false,
    role: 'owner',
    memberCount: 2,
    projectCount: 1,
    members: [
      { userId: TIM, userName: 'Casey Example', userEmail: 'casey@example.test', role: 'owner', isMe: true },
      { userId: ED, userName: 'Jordan Example', userEmail: 'jordan@example.test', role: 'member', isMe: false },
    ],
    projects: [{ id: 'proj-acme-solar', key: 'ACS', name: 'Acme Solar', openTasks: 2, doneTasks: 5, epicCount: 1 }],
    invites: [{ id: 'inv-9', email: 'pending@example.com', role: 'viewer', token: 'tok-9', expiresAt: '2026-11-07T00:00:00Z' }],
  },
];

const ACTIVITY = [
  {
    id: 'act-1',
    actorId: ED,
    actorName: 'Jordan Example',
    orgId: 'org-md',
    projectId: 'proj-acme-solar',
    projectName: 'Acme Solar',
    entityType: 'task',
    entityId: TASKS[0].id,
    taskId: TASKS[0].id,
    epicId: null,
    action: 'status_changed',
    summary: 'Moved "Fix inverter" from Do to Done',
    changes: null,
    createdAt: '2026-10-08T13:02:00.000Z',
  },
];

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: Req, res: http.ServerResponse) {
  const p = req.path.replace(/^\/api\/v2/, '');
  if (req.method === 'GET') {
    if (p === '/users/me') {
      return send(res, 200, req.headers['x-timdo-user']
        ? { id: ED, email: 'jordan@example.test', name: 'Jordan Example' }
        : { id: TIM, email: 'casey@example.test', name: 'Casey Example' });
    }
    if (p === '/projects') {
      let rows = TASKS;
      const a = req.query.get('assignee');
      if (a === 'me') rows = rows.filter((t) => t.isMine);
      else if (a === 'unassigned') rows = rows.filter((t) => t.assigneeId === null);
      else if (a) rows = rows.filter((t) => t.assigneeId === a);
      const org = req.query.get('orgId');
      if (org) rows = rows.filter((t) => t.orgId === org);
      return send(res, 200, rows);
    }
    if (p.startsWith('/projects/') && p.endsWith('/updates')) {
      return send(res, 200, [
        { id: 'n1', projectId: TASKS[0].id, userId: ED, authorName: 'Jordan Example', note: 'Firmware is 2.1.4', gmailThreadId: null, createdAt: '2026-10-08T12:00:00.000Z', canDelete: false },
      ]);
    }
    if (p.startsWith('/tasks/')) return send(res, 200, { linkedTasks: [] });
    if (p === '/activity') return send(res, 200, ACTIVITY);
    if (p === '/organisations') return send(res, 200, SHARING.map(({ members, projects, invites, ...o }) => o));
    if (p === '/organisations/sharing') return send(res, 200, SHARING);
    if (p === '/epics' || p === '/goals') return send(res, 200, []);
  }
  if (req.method === 'PUT' && p.startsWith('/projects/')) {
    if (viewerMode) return send(res, 403, { error: 'You have view-only access to "Acme Solar"' });
    const id = p.split('/')[2];
    const before = TASKS.find((t) => t.id === id)!;
    const assignee = req.body.assigneeId === undefined ? {} : {
      assigneeId: req.body.assigneeId,
      assigneeName: req.body.assigneeId === ED ? 'Jordan Example' : req.body.assigneeId === TIM ? 'Casey Example' : null,
    };
    return send(res, 200, { ...before, ...req.body, ...assignee });
  }
  if (req.method === 'POST' && p === '/projects') {
    if (viewerMode) return send(res, 403, { error: 'You have view-only access to "Acme Solar"' });
    return send(res, 201, { ...TASKS[0], ...req.body, id: 'dddd4444-0000-0000-0000-000000000004' });
  }
  if (req.method === 'POST' && p === '/organisations/org-md/invites') {
    const email = req.body.email;
    if (email === 'jordan@example.test') return send(res, 200, { status: 'already_member', userId: ED, name: 'Jordan Example', email, role: 'member' });
    if (email === 'known@example.com') return send(res, 201, { status: 'added', userId: 'u-k', name: 'Known Person', email, role: req.body.role });
    return send(res, 201, { status: 'invited', id: 'inv-1', email, role: req.body.role, token: 'tok-abc', expiresAt: '2026-11-07T00:00:00Z' });
  }
  if (req.method === 'PUT' && p.startsWith('/organisations/')) return send(res, 200, { success: true, ...req.body });
  send(res, 404, { error: `No mock for ${req.method} ${p}` });
}

function run(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'bash',
      [BIN, ...args],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TZ: 'Europe/London',
          TIMDO_API: `${baseUrl}/api/v2`,
          TIMDO_SECRET: 'test-secret',
          TIMDO_CONFIG: '/dev/null',
          ...env,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr })
    );
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const r: Req = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      requests.push(r);
      handle(r, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  viewerMode = false;
});

const lastGet = (p: string) => requests.filter((r) => r.method === 'GET' && r.path === `/api/v2${p}`).at(-1);

describe('timdo CLI, multi-user', { timeout: 30_000 }, () => {
  it('list --mine and --unassigned use the server-side assignee filter', async () => {
    await run(['list', 'do', '--mine', '--json']);
    expect(lastGet('/projects')?.query.get('assignee')).toBe('me');
    await run(['list', '--unassigned', '--json']);
    expect(lastGet('/projects')?.query.get('assignee')).toBe('unassigned');
  });

  it('list --assignee resolves a name or email to a user id, and --workspace to an org id', async () => {
    const r = await run(['list', '--assignee', 'jordan', '-w', 'Northstar Workshop']);
    expect(r.code).toBe(0);
    const q = lastGet('/projects')!.query;
    expect(q.get('assignee')).toBe(ED);
    expect(q.get('orgId')).toBe('org-md');
    await run(['list', '--assignee', 'jordan@example.test', '--json']);
    expect(lastGet('/projects')?.query.get('assignee')).toBe(ED);
  });

  it('list text shows workspace/project and assignee for shared tasks only', async () => {
    const r = await run(['list', 'do']);
    const lines = r.stdout.split('\n');
    const shared = lines.find((l) => l.includes('Check flashing'))!;
    expect(shared).toContain('Northstar Workshop/Acme Solar');
    expect(shared).toContain('Jordan');
    const personal = lines.find((l) => l.includes('Renew passport'))!;
    expect(personal).toContain('Personal');
    expect(personal).not.toContain('Personal Workspace');
    expect(lines.find((l) => l.includes('Fix inverter'))).toMatch(/\bme\b/);
  });

  it('list --json keeps the raw API objects', async () => {
    const r = await run(['--json', 'list', 'all']);
    const rows = JSON.parse(r.stdout);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveProperty('assigneeName');
    expect(rows[0]).toHaveProperty('orgName');
  });

  it('--as and TIMDO_AS send X-Timdo-User', async () => {
    await run(['--as', 'jordan@example.test', 'whoami']);
    expect(lastGet('/users/me')?.headers['x-timdo-user']).toBe('jordan@example.test');
    await run(['list', '--json'], { TIMDO_AS: 'jordan@example.test' });
    expect(lastGet('/projects')?.headers['x-timdo-user']).toBe('jordan@example.test');
    await run(['list', '--json']);
    expect(lastGet('/projects')?.headers['x-timdo-user']).toBeUndefined();
  });

  it('environment variables win over the config file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'timdo-cfg-'));
    const cfg = path.join(dir, 'config');
    writeFileSync(cfg, 'TIMDO_SECRET="from-config"\nTIMDO_API="http://127.0.0.1:1/api/v2"\n');
    const r = await run(['list', '--json'], { TIMDO_CONFIG: cfg });
    expect(r.code).toBe(0);
    expect(lastGet('/projects')?.headers['x-internal-secret']).toBe('test-secret');
  });

  it('get shows workspace, project, people, note authors and activity', async () => {
    const r = await run(['get', 'aaaa1111', '--text']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Workspace:\s+Northstar Workshop\s+\(shared, your role: owner\)/);
    expect(r.stdout).toMatch(/Project:\s+Acme Solar \(ACS\)/);
    expect(r.stdout).toMatch(/Assignee:\s+Casey Example \(you\)/);
    expect(r.stdout).toMatch(/Created by:\s+Casey Example/);
    expect(r.stdout).toMatch(/Last updated:\s+Jordan Example/);
    expect(r.stdout).toMatch(/Jordan Example\s+Firmware is 2\.1\.4/);
    expect(r.stdout).toContain('Moved "Fix inverter" from Do to Done');
    expect(lastGet('/activity')?.query.get('taskId')).toBe(TASKS[0].id);
  });

  it('get --json adds updates, linked tasks and activity', async () => {
    const r = await run(['--json', 'get', 'aaaa1111']);
    const t = JSON.parse(r.stdout);
    expect(t.updates[0].authorName).toBe('Jordan Example');
    expect(t.activity).toHaveLength(1);
    expect(t.linkedTasks).toEqual([]);
  });

  it('add --assign resolves the member in the target workspace', async () => {
    const r = await run(['add', 'New thing', '-p', 'Acme Solar', '--assign', 'Jordan', '--json']);
    expect(r.code).toBe(0);
    const post = requests.find((x) => x.method === 'POST' && x.path === '/api/v2/projects')!;
    expect(post.body.assigneeId).toBe(ED);
    expect(post.body.category).toBe('Acme Solar');

    await run(['add', 'Nobody yet', '-p', 'Acme Solar', '--assign', 'none', '--json']);
    const post2 = requests.filter((x) => x.method === 'POST' && x.path === '/api/v2/projects').at(-1)!;
    expect(post2.body).toHaveProperty('assigneeId', null);

    await run(['add', 'Default', '-p', 'Acme Solar', '--json']);
    const post3 = requests.filter((x) => x.method === 'POST' && x.path === '/api/v2/projects').at(-1)!;
    expect(post3.body).not.toHaveProperty('assigneeId');
  });

  it('add --project-id accepts a project key', async () => {
    await run(['add', 'Keyed', '--project-id', 'ACS', '--json']);
    const post = requests.find((x) => x.method === 'POST' && x.path === '/api/v2/projects')!;
    expect(post.body.projectId).toBe('proj-acme-solar');
  });

  it('add refuses an assignee who is not in the workspace', async () => {
    const r = await run(['add', 'X', '-p', 'Acme Solar', '--assign', 'stranger@example.com']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('nobody in "Northstar Workshop" matches "stranger@example.com"');
    expect(requests.some((x) => x.method === 'POST')).toBe(false);
  });

  it('update --claim assigns to the caller and prints the change in text mode', async () => {
    const r = await run(['update', 'bbbb2222', '--claim', '--text']);
    expect(r.code).toBe(0);
    const put = requests.find((x) => x.method === 'PUT')!;
    expect(put.body.assigneeId).toBe(TIM);
    expect(r.stdout).toContain('Assignee: Jordan Example -> Casey Example');
  });

  it('view-only errors are readable and exit non-zero', async () => {
    viewerMode = true;
    const r = await run(['update', 'aaaa1111', '--done']);
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('View only: you have view-only access to "Acme Solar"');
  });

  it('missing or unknown task IDs fail with a clear message', async () => {
    const r = await run(['update', '', '--done']);
    expect(r.code).not.toBe(0);
    const r2 = await run(['get', 'zzzz']);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain('Not found');
  });

  it('activity prints newest-first lines with actor and project', async () => {
    const r = await run(['activity', '--workspace', 'Northstar Workshop', '-n', '5']);
    expect(r.stdout.trim()).toBe('08 Oct 14:02  Jordan Example  Moved "Fix inverter" from Do to Done  [Acme Solar]');
    const q = lastGet('/activity')!.query;
    expect(q.get('orgId')).toBe('org-md');
    expect(q.get('limit')).toBe('5');
  });

  it('workspace list and show describe roles, members, projects and invites', async () => {
    const list = await run(['ws', 'list']);
    expect(list.stdout).toMatch(/Northstar Workshop\s+owner\s+2\s+1\s+shared/);
    const show = await run(['workspace', 'show', 'Northstar Workshop']);
    expect(show.stdout).toMatch(/Jordan Example\s+jordan@example\.test\s+member/);
    expect(show.stdout).toMatch(/ACS\s+Acme Solar\s+2 open\s+5 done\s+1 epics/);
    expect(show.stdout).toContain('https://timdo.tdobson.net/invite/tok-9');
  });

  it('workspace share reports added, already a member and invited', async () => {
    const added = await run(['ws', 'share', 'Northstar Workshop', 'known@example.com', '--role', 'viewer']);
    expect(added.stdout).toContain('Added Known Person <known@example.com> to "Northstar Workshop" as viewer');
    const already = await run(['ws', 'share', 'Northstar Workshop', 'jordan@example.test']);
    expect(already.stdout).toContain('already a member');
    const invited = await run(['ws', 'share', 'Northstar Workshop', 'new@example.com']);
    expect(invited.stdout).toContain('Invited new@example.com');
    expect(invited.stdout).toContain('https://timdo.tdobson.net/invite/tok-abc');
    const json = await run(['--json', 'ws', 'share', 'Northstar Workshop', 'new@example.com']);
    expect(JSON.parse(json.stdout).inviteUrl).toBe('https://timdo.tdobson.net/invite/tok-abc');
  });

  it('workspace role and the org alias resolve members by email', async () => {
    const r = await run(['org', 'role', 'Northstar Workshop', 'jordan@example.test', 'viewer']);
    expect(r.code).toBe(0);
    const put = requests.find((x) => x.method === 'PUT')!;
    expect(put.path).toBe(`/api/v2/organisations/org-md/members/${ED}`);
    expect(put.body).toEqual({ role: 'viewer' });
  });

  it('move-project needs --yes off a terminal', async () => {
    const dry = await run(['ws', 'move-project', 'Personal', 'Northstar Workshop']);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain('--yes');
    expect(requests.some((x) => x.method === 'PUT')).toBe(false);
    const ok = await run(['ws', 'move-project', 'PER', 'Northstar Workshop', '--yes']);
    expect(ok.code).toBe(0);
    const put = requests.find((x) => x.method === 'PUT')!;
    expect(put.path).toBe('/api/v2/organisations/org-tim/projects/proj-per');
    expect(put.body).toEqual({ orgId: 'org-md' });
  });

  it('audit counts only your own editable tasks unless --all', async () => {
    const mine = JSON.parse((await run(['--json', 'audit'])).stdout);
    expect(mine.scope).toBe('mine');
    expect(mine.totalActiveTasks).toBe(2);
    const all = JSON.parse((await run(['--json', 'audit', '--all'])).stdout);
    expect(all.totalActiveTasks).toBe(3);
  });

  it('whoami prints the account in use', async () => {
    const r = await run(['whoami']);
    expect(r.stdout).toContain('Casey Example <casey@example.test>');
    expect(r.stdout).toContain('Northstar Workshop (owner, 2 members)');
  });

  it('help works without a secret and the script has no em-dashes', async () => {
    const r = await run(['help'], { TIMDO_SECRET: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('workspace share');
    const ws = await run(['workspace', '--help'], { TIMDO_SECRET: '' });
    expect(ws.stdout).toContain('move-project');
    expect(readFileSync(BIN, 'utf-8')).not.toContain('—');
  });
});
