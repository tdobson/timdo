/**
 * Task refs end to end against real SQL: the HTTP routes, the services behind them and the
 * 0008 migration, with Casey, Jordan (a member of the shared workspace), a viewer and a stranger.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { PARSE_ERROR } from '../lib/refs';
import { onApiError } from '../middleware/apiErrors';
import projectsApp from '../routes/projects';
import refsApp from '../routes/refs';
import tasksApp from '../routes/tasks';
import { getActivity } from '../services/activityService';
import * as orgService from '../services/organisationService';
import * as projectService from '../services/projectService';
import * as refService from '../services/refService';
import * as searchService from '../services/searchService';
import {
  applyMigration,
  createTestDb,
  PENDING_MIGRATIONS,
  ROBIN,
  seedCollaboration,
  STRANGER,
  TIM,
} from './helpers/testDb';

const VIEWER = 'user-viewer';
// Distinct first 8 characters, so short ids in messages can be told apart
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const short = (n: number) => id(n).slice(0, 8);

describe('task refs', () => {
  let db: any;
  let raw: any;
  let stats: { queries: number };
  let actor: string;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedCollaboration(raw);
    raw.exec(`
      INSERT INTO Users (id, email, name) VALUES ('${VIEWER}', 'sam@example.com', 'Sam Viewer');
      INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('m5', 'org-md', '${VIEWER}', 'viewer');
    `);
    actor = TIM;
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('userId', actor);
      c.set('db', db);
      await next();
    });
    app.route('/api/v2/projects', projectsApp);
    app.route('/api/v2/tasks', tasksApp);
    app.route('/api/v2/refs', refsApp);
  });

  async function newTask(userId: string, n: number, category: string, extra: any = {}) {
    return projectService.createProject(db, userId, {
      id: id(n),
      project: `Task ${n}`,
      status: 'do',
      priority: 5,
      size: '***',
      category,
      ...extra,
    });
  }

  async function call(method: string, path: string, body?: unknown, as = TIM) {
    actor = as;
    const res = await app.request(`/api/v2${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const addRef = (n: number, body: unknown, as = TIM) =>
    call('POST', `/tasks/${id(n)}/refs`, body, as);
  const refRows = (n: number) =>
    raw
      .prepare('SELECT role, kind, ref, org_id FROM TaskRefs WHERE task_id = ? ORDER BY rowid')
      .all(id(n));

  describe('adding', () => {
    it('adds a ref, returns its view and logs it without the label', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Fix inverter' });
      const res = await addRef(1, { ref: 'github.issue:acme/widgets#12' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        taskId: id(1),
        role: 'link',
        kind: 'github.issue',
        ref: 'acme/widgets#12',
        canonical: 'github.issue:acme/widgets#12',
        url: 'https://github.com/acme/widgets/issues/12',
        label: null,
        displayLabel: 'GitHub issue acme/widgets#12',
        createdById: TIM,
        createdByName: 'Casey Example',
        canDelete: true,
        existing: false,
      });
      expect(typeof res.body.id).toBe('string');
      expect(typeof res.body.createdAt).toBe('string');

      const activity = await getActivity(db, TIM, { taskId: id(1) });
      expect(activity[0]).toMatchObject({
        action: 'ref_added',
        summary: 'Linked "Fix inverter" to github.issue:acme/widgets#12',
      });
    });

    it('is idempotent for the same role and ref', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'https://github.com/acme/widgets/issues/12' });
      const again = await addRef(1, { ref: 'github.issue:acme/widgets#12' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        existing: true,
        canonical: 'github.issue:acme/widgets#12',
      });
      expect(refRows(1)).toHaveLength(1);
      const added = (await getActivity(db, TIM, { taskId: id(1) })).filter(
        (a) => a.action === 'ref_added'
      );
      expect(added).toHaveLength(1);
    });

    it('allows the same ref in another role on the same task', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'github.issue:acme/widgets#12' });
      const about = await addRef(1, { ref: 'github.issue:acme/widgets#12', role: 'about' });
      expect(about.status).toBe(201);
      expect(refRows(1).map((r: any) => r.role)).toEqual(['link', 'about']);
    });

    it('keeps one source per ref in a workspace, naming the task that has it', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page' });
      await newTask(TIM, 2, 'Northstar Workshop');
      await newTask(TIM, 3, 'Personal');
      expect((await addRef(1, { ref: 'forum.post:4411', role: 'source' })).status).toBe(201);

      const clash = await addRef(2, { ref: 'forum.post:4411', role: 'source' });
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({
        error: `forum.post:4411 is already the source of ${short(1)} "Broken offer page"`,
        taskId: id(1),
        task: { id: id(1), project: 'Broken offer page' },
      });
      // A plain link to it is fine, and so is a source in another workspace
      expect((await addRef(2, { ref: 'forum.post:4411' })).status).toBe(201);
      expect((await addRef(3, { ref: 'forum.post:4411', role: 'source' })).status).toBe(201);
    });

    it('retries a source claim when the unique-index winner was deleted before recovery', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      const client = db.session.client;
      let raced = false;
      db.session.client = async (query: string, params: unknown[], method: string) => {
        if (!raced && /insert into ["`]?TaskRefs/i.test(query)) {
          raced = true;
          raw.exec(`
            INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref)
              VALUES ('raced-source', '${id(1)}', 'org-md', 'source', 'forum.post', '4411');
            UPDATE Tasks SET is_deleted = 1 WHERE id = '${id(1)}';
          `);
        }
        return client(query, params, method);
      };

      const res = await addRef(2, { ref: 'forum.post:4411', role: 'source' });

      expect(raced).toBe(true);
      expect(res.status).toBe(201);
      expect(refRows(1).map((row: any) => row.role)).toEqual(['link']);
      expect(refRows(2).map((row: any) => row.role)).toEqual(['source']);
    });

    it('does not release a source after its deleted holder was restored before the claim batch', async () => {
      await newTask(TIM, 1, 'Acme Solar', { refs: [{ ref: 'forum.post:4411', role: 'source' }] });
      await projectService.deleteProject(db, TIM, id(1));
      await newTask(TIM, 2, 'Acme Solar');
      const batch = db.batch.bind(db);
      let restored = false;
      db.batch = async (statements: any) => {
        db.batch = batch;
        raw.prepare('UPDATE Tasks SET is_deleted = 0 WHERE id = ?').run(id(1));
        restored = true;
        return batch(statements);
      };

      const res = await addRef(2, { ref: 'forum.post:4411', role: 'source' });

      expect(restored).toBe(true);
      expect(res.status).toBe(409);
      expect(res.body.taskId).toBe(id(1));
      expect(refRows(1).map((row: any) => row.role)).toEqual(['source']);
      expect(refRows(2)).toEqual([]);
    });

    it('allows only one source on a task even when the refs differ', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      expect((await addRef(1, { ref: 'forum.post:1', role: 'source' })).status).toBe(201);

      const second = await addRef(1, { ref: 'forum.post:2', role: 'source' });

      expect(second.status).toBe(409);
      expect(second.body.error).toBe('A task can only have one source');
      expect(raw.prepare("SELECT kind, ref FROM TaskRefs WHERE task_id = ? AND role = 'source'").all(id(1))).toEqual([
        { kind: 'forum.post', ref: '1' },
      ]);
    });

    it('serializes concurrent attempts to add different sources to one task', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const client = db.session.client;
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      db.session.client = async (query: string, params: unknown[], method: string) => {
        if (
          /insert into ["`]?TaskRefs/i.test(query) &&
          (params.includes('source') || params.includes('forum.post'))
        ) {
          arrivals++;
          if (arrivals === 2) {
            release();
          }
          await gate;
        }
        return client(query, params, method);
      };

      const [first, second] = await Promise.all([
        addRef(1, { ref: 'forum.post:1', role: 'source' }),
        addRef(1, { ref: 'forum.post:2', role: 'source' }),
      ]);

      expect(arrivals).toBe(2);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM TaskRefs WHERE task_id = ? AND role = 'source'").get(id(1)).n).toBe(1);
    });

    it('accepts an explicit kind, a label, a url and the role spelt with a hyphen', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const res = await addRef(1, {
        ref: '123456',
        kind: 'acme.member',
        role: 'reported-by',
        label: 'Member on the forum',
        url: 'https://forum.example.org/u/123456',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        role: 'reported_by',
        canonical: 'acme.member:123456',
        label: 'Member on the forum',
        displayLabel: 'Member on the forum',
        url: 'https://forum.example.org/u/123456',
      });
      const activity = await getActivity(db, TIM, { taskId: id(1) });
      expect(activity[0].summary).toBe('Added reporter acme.member:123456 to "Task 1"');
    });

    it('answers bad input with a sentence', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const bad = await addRef(1, { ref: 'just some words' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/^Can't tell what that is/);
      expect((await addRef(1, { ref: '' })).status).toBe(400);
      const badUrl = await addRef(1, { ref: 'acme.member:1', url: 'ftp://example.org/file' });
      expect(badUrl.status).toBe(400);
      expect(badUrl.body.error).toMatch(/http/);
      const badRole = await addRef(1, { ref: 'acme.member:1', role: 'owner' });
      expect(badRole.status).toBe(400);
      expect(badRole.body.error).toMatch(/link, source, reported_by or about/);
    });

    it('refuses control characters and URL schemes as kinds, saving nothing', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const escaped = await addRef(1, { ref: 'forum.post:44\n11\u001b[2J' });
      expect(escaped.status).toBe(400);
      expect(escaped.body.error).toBe(
        "Links can't contain line breaks, tabs or control characters"
      );
      const label = await addRef(1, { ref: 'forum.post:4411', label: 'Jordan\u001b[31m' });
      expect(label.status).toBe(400);
      expect(label.body.error).toBe("Labels can't contain line breaks, tabs or control characters");
      const tabbed = await addRef(1, { ref: 'forum.post:4411', label: 'Jordan\tFairweather' });
      expect(tabbed.status).toBe(400);
      const url = await addRef(1, { ref: 'forum.post:4411', url: 'https://example.org/\u0007' });
      expect(url.status).toBe(400);
      const scheme = await addRef(1, { ref: '//evil.example', kind: 'http' });
      expect(scheme.status).toBe(400);
      expect(scheme.body.error).toMatch(/not kinds/);
      expect(refRows(1)).toEqual([]);
      // The same checks guard the service, for callers that skip the route validator
      expect(() =>
        refService.resolveRefInput({ ref: 'forum.post:4411', label: 'Jordan\u001b[31m' })
      ).toThrow(/Labels can't contain/);
    });
  });

  describe('permissions', () => {
    it('lets viewers read refs but not change them, and hides tasks from strangers', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:4411' });

      const viewerAdd = await addRef(1, { ref: 'forum.post:1' }, VIEWER);
      expect(viewerAdd.status).toBe(403);
      expect(viewerAdd.body.error).toMatch(/view-only/);
      const viewerList = await call('GET', `/tasks/${id(1)}/refs`, undefined, VIEWER);
      expect(viewerList.status).toBe(200);
      expect(viewerList.body[0]).toMatchObject({ canonical: 'forum.post:4411', canDelete: false });
      const viewerRemove = await call(
        'DELETE',
        `/tasks/${id(1)}/refs?ref=${encodeURIComponent('forum.post:4411')}`,
        undefined,
        VIEWER
      );
      expect(viewerRemove.status).toBe(403);

      expect((await call('GET', `/tasks/${id(1)}/refs`, undefined, STRANGER)).status).toBe(404);
      expect((await addRef(1, { ref: 'forum.post:1' }, STRANGER)).status).toBe(404);
    });
  });

  describe('removing', () => {
    it('removes by id, by canonical form and by URL', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Fix inverter' });
      const a = await addRef(1, { ref: 'forum.post:1' });
      await addRef(1, { ref: 'github.issue:acme/widgets#12' });
      await addRef(1, { ref: 'github.issue:acme/widgets#13' });

      expect((await call('DELETE', `/tasks/${id(1)}/refs/${a.body.id}`)).status).toBe(204);
      const byCanonical = await call(
        'DELETE',
        `/tasks/${id(1)}/refs?ref=${encodeURIComponent('github.issue:acme/widgets#12')}`
      );
      expect(byCanonical.status).toBe(204);
      const byUrl = await call(
        'DELETE',
        `/tasks/${id(1)}/refs?ref=${encodeURIComponent('https://github.com/acme/widgets/issues/13')}&role=link`
      );
      expect(byUrl.status).toBe(204);
      expect(refRows(1)).toEqual([]);

      const missing = await call(
        'DELETE',
        `/tasks/${id(1)}/refs?ref=${encodeURIComponent('forum.post:1')}`
      );
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("That link isn't on this task");
      expect((await call('DELETE', `/tasks/${id(1)}/refs/not-an-id`)).status).toBe(404);

      const activity = await getActivity(db, TIM, { taskId: id(1) });
      expect(activity[0]).toMatchObject({
        action: 'ref_removed',
        summary: 'Removed link github.issue:acme/widgets#13 from "Fix inverter"',
      });
    });

    it('only removes the role asked for', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:1' });
      await addRef(1, { ref: 'forum.post:1', role: 'source' });
      await call('DELETE', `/tasks/${id(1)}/refs?ref=forum.post:1&role=source`);
      expect(refRows(1).map((r: any) => r.role)).toEqual(['link']);
    });
  });

  describe('task views', () => {
    it('carries refs on every view, for collaborators too', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:4411', role: 'source' });

      const tims = await projectService.getProjectsForUser(db, TIM);
      expect(tims.find((t) => t.id === id(1))?.refs.map((r) => r.canonical)).toEqual([
        'forum.post:4411',
      ]);
      expect(tims.find((t) => t.id === id(2))?.refs).toEqual([]);

      const robins = await projectService.getProjectsForUser(db, ROBIN);
      expect(robins.find((t) => t.id === id(1))?.refs[0]).toMatchObject({
        role: 'source',
        createdByName: 'Casey Example',
        canDelete: true,
      });

      const one = await call('GET', `/projects/${id(1)}`);
      expect(one.body.refs).toHaveLength(1);
    });

    it('loads refs for a list without one query per task', async () => {
      for (let n = 1; n <= 3; n++) {
        await newTask(TIM, n, 'Acme Solar');
        await addRef(n, { ref: `forum.post:${n}` });
      }
      stats.queries = 0;
      await projectService.getProjectsForUser(db, TIM);
      const few = stats.queries;

      for (let n = 4; n <= 15; n++) {
        await newTask(TIM, n, n % 2 ? 'Acme Solar' : 'Personal');
        await addRef(n, { ref: `forum.post:${n}` });
      }
      stats.queries = 0;
      const views = await projectService.getProjectsForUser(db, TIM);
      expect(views.every((v) => v.refs.length === 1)).toBe(true);
      expect(stats.queries).toBe(few);
    });
  });

  describe('finding by ref', () => {
    it('finds tasks by URL or canonical form, done ones included, deleted and invisible ones not', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Personal', { status: 'done' });
      await newTask(TIM, 3, 'Acme Solar');
      await newTask(TIM, 4, 'Acme Solar');
      await newTask(STRANGER, 5, 'Stranger Things');
      for (const n of [1, 2, 3]) {
        await addRef(n, { ref: 'github.issue:acme/widgets#12' });
      }
      await addRef(5, { ref: 'github.issue:acme/widgets#12' }, STRANGER);
      await addRef(4, { ref: 'github.issue:acme/widgets#12', role: 'about' });
      await projectService.deleteProject(db, TIM, id(3));

      const byUrl = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('https://github.com/acme/widgets/issues/12')}`
      );
      expect(byUrl.status).toBe(200);
      expect(byUrl.body.map((t: any) => t.id).sort()).toEqual([id(1), id(2), id(4)]);

      const byCanonical = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('github.issue:acme/widgets#12')}&refRole=about`
      );
      expect(byCanonical.body.map((t: any) => t.id)).toEqual([id(4)]);
      // `role`, as DELETE /tasks/:id/refs calls it, works too
      const byRole = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('github.issue:acme/widgets#12')}&role=about`
      );
      expect(byRole.body.map((t: any) => t.id)).toEqual([id(4)]);
      const badRole = await call('GET', '/projects?ref=forum.post:1&role=owner');
      expect(badRole.status).toBe(400);

      const robins = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('github.issue:acme/widgets#12')}`,
        undefined,
        ROBIN
      );
      expect(robins.body.map((t: any) => t.id).sort()).toEqual([id(1), id(4)]);

      const strangers = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('github.issue:acme/widgets#12')}`,
        undefined,
        STRANGER
      );
      expect(strangers.body.map((t: any) => t.id)).toEqual([id(5)]);

      const bad = await call('GET', '/projects?ref=nonsense');
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/^Can't tell/);
    });

    it('puts exact ref matches first in search, flagged', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Widgets issue twelve' });
      await newTask(TIM, 2, 'Acme Solar', { project: 'Unrelated title' });
      await addRef(2, { ref: 'github.issue:acme/widgets#12' });
      await newTask(STRANGER, 3, 'Stranger Things');
      await addRef(3, { ref: 'github.issue:acme/widgets#12' }, STRANGER);

      const results = await searchService.searchTasksForUser(
        db,
        TIM,
        'https://github.com/acme/widgets/issues/12'
      );
      expect(results[0]).toMatchObject({ id: id(2), matchedRef: true });
      expect(results.filter((r) => r.id === id(2))).toHaveLength(1);
      expect(results.some((r) => r.id === id(3))).toBe(false);

      // Exact ref hits include done tasks, flagged with their status; word matches do not
      await newTask(TIM, 4, 'Acme Solar', { project: 'Widgets shipped', status: 'done' });
      await addRef(4, { ref: 'github.issue:acme/widgets#12' });
      const withDone = await searchService.searchTasksForUser(
        db,
        TIM,
        'github.issue:acme/widgets#12'
      );
      expect(withDone.find((r) => r.id === id(4))).toMatchObject({
        status: 'done',
        matchedRef: true,
      });
      const words = await searchService.searchTasksForUser(db, TIM, 'shipped');
      expect(words).toEqual([]);

      const plain = await searchService.searchTasksForUser(db, TIM, 'widgets');
      expect(plain.map((r) => r.id)).toEqual([id(1)]);
      expect(plain[0].matchedRef).toBeUndefined();
    });
  });

  describe('creating with refs', () => {
    it('adds refs with a new task and lists them in the create entry', async () => {
      const res = await call('POST', '/projects', {
        project: 'Broken offer page',
        category: 'Acme Solar',
        refs: [
          { ref: 'forum.post:4411', role: 'source' },
          { ref: 'acme.member:123456', role: 'reported_by', label: 'Jordan Example' },
          { ref: 'https://github.com/acme/widgets/issues/88' },
        ],
      });
      expect(res.status).toBe(201);
      expect(res.body.refs.map((r: any) => `${r.role} ${r.canonical}`)).toEqual([
        'source forum.post:4411',
        'reported_by acme.member:123456',
        'link github.issue:acme/widgets#88',
      ]);
      const activity = await getActivity(db, TIM, { taskId: res.body.id });
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        action: 'created',
        summary: 'Created "Broken offer page"',
        changes: {
          refs: {
            from: [],
            to: ['forum.post:4411', 'acme.member:123456', 'github.issue:acme/widgets#88'],
          },
        },
      });
    });

    it('fails the whole create on a source clash or a bad ref', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page' });
      await addRef(1, { ref: 'forum.post:4411', role: 'source' });
      const before = raw.prepare('SELECT count(*) AS n FROM Tasks').get().n;

      const clash = await call('POST', '/projects', {
        project: 'Same report again',
        category: 'Acme Solar',
        refs: [{ ref: 'github.issue:acme/widgets#1' }, { ref: 'forum.post:4411', role: 'source' }],
      });
      expect(clash.status).toBe(409);
      expect(clash.body.taskId).toBe(id(1));

      const bad = await call('POST', '/projects', {
        project: 'Bad ref',
        category: 'Acme Solar',
        refs: [{ ref: 'what is this' }],
      });
      expect(bad.status).toBe(400);
      expect(raw.prepare('SELECT count(*) AS n FROM Tasks').get().n).toBe(before);
    });

    it('rolls the task back when a source is taken between the check and the write', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page' });
      await addRef(1, { ref: 'forum.post:4411', role: 'source' });
      const taskInsert = db.insert(schema.tasks).values({
        id: id(2),
        projectId: 'proj-acme-solar',
        reporterId: TIM,
        title: 'Lost the race',
      });
      const row = {
        id: 'race-ref',
        taskId: id(2),
        orgId: 'org-md',
        role: 'source' as const,
        kind: 'forum.post',
        ref: '4411',
      };
      await expect(refService.insertTaskWithRefs(db, taskInsert, [row])).rejects.toMatchObject({
        status: 409,
        taskId: id(1),
      });
      expect(raw.prepare('SELECT count(*) AS n FROM Tasks WHERE id = ?').get(id(2)).n).toBe(0);
    });

    it('accepts refs on POST /tasks too', async () => {
      const res = await call('POST', '/tasks', {
        projectId: 'proj-acme-solar',
        title: 'From a bot',
        refs: [{ ref: 'forum.post:7', role: 'source' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.refs.map((r: any) => r.canonical)).toEqual(['forum.post:7']);
      const clash = await call('POST', '/tasks', {
        projectId: 'proj-acme-solar',
        title: 'From a bot, retried',
        refs: [{ ref: 'forum.post:7', role: 'source' }],
      });
      expect(clash.status).toBe(409);
      expect(clash.body.taskId).toBe(res.body.id);
    });

    it('rejects more than 20 refs', async () => {
      const refs = Array.from({ length: 21 }, (_, i) => ({ ref: `forum.post:${i}` }));
      const res = await call('POST', '/projects', { project: 'Lots', category: 'Acme Solar', refs });
      expect(res.status).toBe(400);
    });
  });

  describe('gmailThreadId mirror', () => {
    it('writes a gmail.thread ref when the field is set and removes it when cleared', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const set = await call('PUT', `/projects/${id(1)}`, { gmailThreadId: '1a11f9b5ec8c2b2f' });
      expect(set.body.refs.map((r: any) => r.canonical)).toEqual(['gmail.thread:1a11f9b5ec8c2b2f']);
      expect(set.body.gmailThreadId).toBe('1a11f9b5ec8c2b2f');

      const cleared = await call('PUT', `/projects/${id(1)}`, { gmailThreadId: null });
      expect(cleared.body.refs).toEqual([]);
      expect(cleared.body.gmailThreadId).toBeNull();
    });

    it('treats a same-thread ref inserted after its lookup as an idempotent race', async () => {
      const threadId = '1a11f9b5ec8c2b2f';
      await newTask(TIM, 1, 'Acme Solar');
      const client = db.session.client;
      let raced = false;
      db.session.client = async (query: string, params: unknown[], method: string) => {
        if (
          !raced &&
          method === 'run' &&
          /insert into ["`]?TaskRefs/i.test(query) &&
          params.includes('gmail.thread')
        ) {
          raced = true;
          raw.prepare(
            'INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref) VALUES (?, ?, ?, ?, ?, ?)'
          ).run('raced-gmail', id(1), 'org-md', 'link', 'gmail.thread', threadId);
        }
        return client(query, params, method);
      };

      const res = await call('PUT', `/projects/${id(1)}`, { gmailThreadId: threadId });

      expect(raced).toBe(true);
      expect(res.status).toBe(200);
      expect(res.body.gmailThreadId).toBe(threadId);
      expect(refRows(1).map((row: any) => `${row.role} ${row.ref}`)).toEqual([`link ${threadId}`]);
    });

    it('checks gmailThreadId before writing anything, so a bad one changes nothing', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const row = () =>
        raw.prepare('SELECT priority, gmail_thread_id AS g FROM Tasks WHERE id = ?').get(id(1));
      for (const path of [`/projects/${id(1)}`, `/tasks/${id(1)}`]) {
        const res = await call('PUT', path, { priority: 9, gmailThreadId: 'x'.repeat(600) });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/500 characters/);
      }
      expect(row()).toEqual({ priority: 5, g: null });
      expect(refRows(1)).toEqual([]);
      const created = await call('POST', '/projects', {
        project: 'Too long a thread',
        category: 'Acme Solar',
        gmailThreadId: 'x'.repeat(600),
      });
      expect(created.status).toBe(400);
      expect(
        raw.prepare('SELECT COUNT(*) AS n FROM Tasks WHERE title = ?').get('Too long a thread').n
      ).toBe(0);
    });

    it('keeps the column on the newest gmail.thread ref', async () => {
      await newTask(TIM, 1, 'Acme Solar', { gmailThreadId: '1a11f9b5ec8c2b2f' });
      expect(refRows(1)).toHaveLength(1);
      await addRef(1, { ref: 'https://mail.google.com/mail/u/0/#inbox/2b22f9b5ec8c2b2f' });
      const column = () =>
        raw.prepare('SELECT gmail_thread_id AS g FROM Tasks WHERE id = ?').get(id(1)).g;
      expect(column()).toBe('2b22f9b5ec8c2b2f');
      await call('DELETE', `/tasks/${id(1)}/refs?ref=gmail.thread:2b22f9b5ec8c2b2f`);
      expect(column()).toBe('1a11f9b5ec8c2b2f');
      await call('DELETE', `/tasks/${id(1)}/refs?ref=gmail.thread:1a11f9b5ec8c2b2f`);
      expect(column()).toBeNull();
    });
  });

  describe('gmailThreadId mirror, from refs and form saves', () => {
    const column = (n: number) =>
      raw.prepare('SELECT gmail_thread_id AS g FROM Tasks WHERE id = ?').get(id(n)).g;

    it('sets the column when a task is created with a gmail.thread ref', async () => {
      const res = await call('POST', '/projects', {
        project: 'From an email',
        category: 'Acme Solar',
        refs: [{ ref: 'https://mail.google.com/mail/u/0/#inbox/1a11f9b5ec8c2b2f' }],
      });
      expect(res.status).toBe(201);
      expect(res.body.gmailThreadId).toBe('1a11f9b5ec8c2b2f');

      await newTask(TIM, 2, 'Acme Solar', { gmailThreadId: ' 1a11f9b5ec8c2b2f ' });
      expect(column(2)).toBe('1a11f9b5ec8c2b2f');
      expect(refRows(2).map((r: any) => r.ref)).toEqual(['1a11f9b5ec8c2b2f']);
    });

    it('treats a form save with the same thread as no change, whatever role holds it', async () => {
      await newTask(TIM, 1, 'Acme Solar', {
        refs: [{ ref: 'gmail.thread:1a11f9b5ec8c2b2f', role: 'source' }],
      });
      expect(column(1)).toBe('1a11f9b5ec8c2b2f');
      const saved = await call('PUT', `/projects/${id(1)}`, {
        priority: 6,
        gmailThreadId: ' 1a11f9b5ec8c2b2f ',
      });
      expect(saved.status).toBe(200);
      expect(refRows(1).map((r: any) => r.role)).toEqual(['source']);
      const activity = await getActivity(db, TIM, { taskId: id(1) });
      expect(JSON.stringify(activity[0].changes)).not.toMatch(/gmailThreadId/);
    });

    it('does not add a link when another role already holds the thread', async () => {
      await newTask(TIM, 1, 'Acme Solar', {
        refs: [{ ref: 'gmail.thread:1a11f9b5ec8c2b2f', role: 'about' }],
      });
      await call('DELETE', `/tasks/${id(1)}/refs?ref=gmail.thread:1a11f9b5ec8c2b2f`);
      await addRef(1, { ref: 'gmail.thread:1a11f9b5ec8c2b2f', role: 'about' });
      await call('PUT', `/projects/${id(1)}`, { gmailThreadId: '2b22f9b5ec8c2b2f' });
      await call('PUT', `/projects/${id(1)}`, { gmailThreadId: '1a11f9b5ec8c2b2f' });
      expect(refRows(1).map((r: any) => `${r.role} ${r.ref}`)).toEqual([
        'about 1a11f9b5ec8c2b2f',
        'link 2b22f9b5ec8c2b2f',
      ]);
      expect(column(1)).toBe('1a11f9b5ec8c2b2f');
    });

    it('clearing the field removes the thread in any role and logs a non-link removal', async () => {
      await newTask(TIM, 1, 'Acme Solar', {
        project: 'Reported by email',
        refs: [{ ref: 'gmail.thread:1a11f9b5ec8c2b2f', role: 'source' }],
      });
      const cleared = await call('PUT', `/projects/${id(1)}`, { gmailThreadId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.refs).toEqual([]);
      expect(column(1)).toBeNull();
      const activity = await getActivity(db, TIM, { taskId: id(1) });
      expect(activity.map((a: any) => a.summary)).toContain(
        'Removed source gmail.thread:1a11f9b5ec8c2b2f from "Reported by email"'
      );
    });
  });

  describe('error sentences', () => {
    it('names the bad link when a create carries several', async () => {
      const bad = await call('POST', '/projects', {
        project: 'Three links',
        category: 'Acme Solar',
        refs: [{ ref: 'forum.post:1', role: 'source' }, { ref: 'acme.member:2' }, { ref: 'hello' }],
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe(`"hello": ${PARSE_ERROR}`);
    });

    it('refuses refs on PUT instead of dropping them', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      for (const path of [`/projects/${id(1)}`, `/tasks/${id(1)}`]) {
        const res = await call('PUT', path, { refs: [{ ref: 'forum.post:1' }] });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/POST \/tasks\/:id\/refs/);
      }
      expect(refRows(1)).toEqual([]);
    });

    it('treats GitHub owner and repo case as the same ref', async () => {
      await newTask(TIM, 1, 'Acme Solar', {
        refs: [{ ref: 'https://github.com/Acme/Widgets/issues/12', role: 'source' }],
      });
      const clash = await call('POST', '/projects', {
        project: 'Same issue',
        category: 'Acme Solar',
        refs: [{ ref: 'https://github.com/acme/widgets/issues/12', role: 'source' }],
      });
      expect(clash.status).toBe(409);
      const found = await call(
        'GET',
        `/projects?ref=${encodeURIComponent('github.issue:ACME/widgets#12')}`
      );
      expect(found.body.map((t: any) => t.id)).toEqual([id(1)]);
    });
  });

  describe('merge and move', () => {
    it('keeps the newest Gmail ref on the merge target', async () => {
      await newTask(TIM, 1, 'Acme Solar', { gmailThreadId: '1a11f9b5ec8c2b2f' });
      await newTask(TIM, 2, 'Acme Solar', { gmailThreadId: '2b22f9b5ec8c2b2f' });
      raw.exec(`
        UPDATE TaskRefs SET created_at = '2026-01-01T00:00:00.000Z'
          WHERE task_id = '${id(1)}' AND kind = 'gmail.thread';
        UPDATE TaskRefs SET created_at = '2026-02-01T00:00:00.000Z'
          WHERE task_id = '${id(2)}' AND kind = 'gmail.thread';
      `);

      const merged = await projectService.mergeProjects(db, TIM, id(1), id(2));

      expect(merged?.gmailThreadId).toBe('2b22f9b5ec8c2b2f');
      expect(merged?.refs.filter((ref: any) => ref.kind === 'gmail.thread').map((ref: any) => ref.ref)).toEqual([
        '1a11f9b5ec8c2b2f',
        '2b22f9b5ec8c2b2f',
      ]);
    });

    it('moves refs to the merge target, drops duplicates and demotes a second source', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:1', role: 'source' });
      await addRef(1, { ref: 'github.issue:acme/widgets#12' });
      await addRef(2, { ref: 'forum.post:2', role: 'source' });
      await addRef(2, { ref: 'github.issue:acme/widgets#12' });
      await addRef(2, { ref: 'acme.member:9', role: 'reported_by' });

      const merged = await projectService.mergeProjects(db, TIM, id(1), id(2));
      expect(merged!.refs.map((r) => `${r.role} ${r.canonical}`).sort()).toEqual([
        'link forum.post:2',
        'link github.issue:acme/widgets#12',
        'reported_by acme.member:9',
        'source forum.post:1',
      ]);
      expect(refRows(2)).toEqual([]);
    });

    it('keeps the source when the target has none', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      await addRef(2, { ref: 'forum.post:2', role: 'source' });
      await projectService.mergeProjects(db, TIM, id(1), id(2));
      expect(refRows(1).map((r: any) => r.role)).toEqual(['source']);
    });

    it('keeps one source when merging a task with multiple legacy source refs', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      raw.exec(`
        INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref) VALUES
          ('legacy-source-1', '${id(2)}', 'org-md', 'source', 'forum.post', '1'),
          ('legacy-source-2', '${id(2)}', 'org-md', 'source', 'forum.post', '2');
      `);

      const merged = await projectService.mergeProjects(db, TIM, id(1), id(2));
      const sources = merged!.refs.filter((ref: any) => ref.role === 'source');

      expect(sources).toHaveLength(1);
      expect(merged!.refs.map((ref: any) => ref.ref).sort()).toEqual(['1', '2']);
    });

    it('moves refs with a project to another workspace', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:1', role: 'source' });
      await orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
        orgId: 'org-tim',
      });
      expect(refRows(1)[0].org_id).toBe('org-tim');
    });

    it('refuses a project move that would give a ref two sources in one workspace', async () => {
      await newTask(TIM, 1, 'Personal', { project: 'Broken offer page' });
      await newTask(TIM, 2, 'Acme Solar');
      await addRef(1, { ref: 'forum.post:4411', role: 'source' });
      await addRef(2, { ref: 'forum.post:4411', role: 'source' });
      await expect(
        orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', { orgId: 'org-tim' })
      ).rejects.toThrow(`forum.post:4411 is already the source of ${short(1)} "Broken offer page"`);
      const project = raw.prepare("SELECT org_id FROM Projects WHERE id = 'proj-acme-solar'").get();
      expect(project.org_id).toBe('org-md');
      expect(refRows(2)[0].org_id).toBe('org-md');
    });

    it("moves a single task's refs when the task changes workspace, and refuses a clash", async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Personal');
      await addRef(1, { ref: 'forum.post:1', role: 'source' });
      await projectService.updateProject(db, TIM, id(1), { projectId: 'proj-personal' });
      expect(refRows(1)[0].org_id).toBe('org-tim');

      await newTask(TIM, 3, 'Acme Solar');
      await addRef(3, { ref: 'forum.post:1', role: 'source' });
      await expect(
        projectService.updateProject(db, TIM, id(3), { projectId: 'proj-personal' })
      ).rejects.toThrow(/already the source of/);
    });
  });

  describe('privacy', () => {
    it('never writes a label to the activity log', async () => {
      await call('POST', '/projects', {
        project: 'Report',
        category: 'Acme Solar',
        refs: [{ ref: 'acme.member:123456', role: 'reported_by', label: 'Jordan Example' }],
      });
      await newTask(TIM, 1, 'Acme Solar');
      await addRef(1, { ref: 'acme.member:5', role: 'about', label: 'Jordan Example' });
      await call('DELETE', `/tasks/${id(1)}/refs?ref=acme.member:5`);
      const rows = raw.prepare('SELECT summary, changes FROM ActivityLog').all();
      expect(rows.length).toBeGreaterThan(3);
      for (const r of rows) {
        expect(`${r.summary} ${r.changes ?? ''}`).not.toContain('Jordan Example');
      }
    });
  });

  describe('parse endpoint', () => {
    it('previews a parse without saving, never as a 400', async () => {
      const good = await call(
        'GET',
        `/refs/parse?input=${encodeURIComponent('https://github.com/acme/widgets/pull/7')}`
      );
      expect(good).toEqual({
        status: 200,
        body: {
          ok: true,
          value: {
            kind: 'github.pr',
            ref: 'acme/widgets#7',
            canonical: 'github.pr:acme/widgets#7',
            url: 'https://github.com/acme/widgets/pull/7',
            label: 'GitHub PR acme/widgets#7',
          },
        },
      });
      const explicit = await call('GET', '/refs/parse?input=123456&kind=acme.member');
      expect(explicit.body.value.canonical).toBe('acme.member:123456');
      const bad = await call('GET', '/refs/parse?input=nope');
      expect(bad.status).toBe(200);
      expect(bad.body).toEqual({ ok: false, error: expect.stringMatching(/^Can't tell/) });
    });
  });

  describe('migration 0008', () => {
    it('backfills a link ref for every task with a Gmail thread', () => {
      const before = createTestDb({
        migrations: PENDING_MIGRATIONS.filter((m) => m !== '0008_task_refs.sql'),
      });
      seedCollaboration(before.raw);
      before.raw.exec(`
        INSERT INTO Tasks (id, project_id, reporter_id, title, gmail_thread_id, created_at) VALUES
          ('t1', 'proj-acme-solar', '${TIM}', 'With thread', ' 1a11f9b5ec8c2b2f ', '2026-01-02 03:04:05'),
          ('t2', 'proj-personal', '${TIM}', 'Blank thread', '  ', NULL),
          ('t3', 'proj-personal', '${TIM}', 'No thread', NULL, NULL);
      `);
      applyMigration(before.raw, '0008_task_refs.sql');
      const rows = before.raw.prepare('SELECT * FROM TaskRefs').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        task_id: 't1',
        org_id: 'org-md',
        role: 'link',
        kind: 'gmail.thread',
        ref: '1a11f9b5ec8c2b2f',
        url: 'https://mail.google.com/mail/u/0/#all/1a11f9b5ec8c2b2f',
        created_by: TIM,
        created_at: '2026-01-02 03:04:05',
      });
      // Running it twice changes nothing
      applyMigration(before.raw, '0008_task_refs.sql');
      expect(before.raw.prepare('SELECT count(*) AS n FROM TaskRefs').get().n).toBe(1);
    });
  });
});
