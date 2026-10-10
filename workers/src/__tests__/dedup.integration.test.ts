/**
 * No duplicates on create, against real SQL: idempotent create by `source` ref (onDuplicate
 * error | return | report), races on the source index, deleted holders releasing their source,
 * and similar-task suggestions from the FTS index. Casey owns the shared workspace, Jordan is a
 * member, Sam is a viewer and the stranger sees none of it.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import projectsApp from '../routes/projects';
import tasksApp from '../routes/tasks';
import { getActivity } from '../services/activityService';
import * as projectService from '../services/projectService';
import * as refService from '../services/refService';
import * as similarService from '../services/similarService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

const VIEWER = 'user-viewer';
const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const short = (n: number) => id(n).slice(0, 8);

describe('dedup on create', () => {
  let db: any;
  let raw: any;
  let stats: { queries: number; maxBindings: number };
  let actor: string;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedCollaboration(raw);
    raw.exec(`
      UPDATE Users SET email = 'casey@example.test', name = 'Casey Example' WHERE id = '${TIM}';
      UPDATE Users SET email = 'jordan@example.test', name = 'Jordan Example' WHERE id = '${ROBIN}';
      UPDATE Users SET email = 'taylor@example.test', name = 'Taylor Example' WHERE id = '${STRANGER}';
      UPDATE Organisations SET name = 'Casey Example', slug = 'casey-example' WHERE id = 'org-tim';
      UPDATE Organisations SET name = 'Northstar Workshop', slug = 'northstar-workshop' WHERE id = 'org-md';
      UPDATE Organisations SET name = 'Taylor Example', slug = 'taylor-example' WHERE id = 'org-stranger';
      UPDATE Projects SET name = 'Personal' WHERE id = 'proj-personal';
      UPDATE Projects SET name = 'Acme Solar' WHERE id = 'proj-acme-solar';
      UPDATE Projects SET name = 'Northstar Workshop' WHERE id = 'proj-md';
      UPDATE Projects SET name = 'Other Workshop' WHERE id = 'proj-stranger';
      INSERT INTO Users (id, email, name) VALUES ('${VIEWER}', 'morgan@example.test', 'Morgan Vale');
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

  const count = (table: string, where = '1 = 1', ...args: unknown[]) =>
    raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args).n as number;
  const totals = () => ({
    tasks: count('Tasks'),
    refs: count('TaskRefs'),
    notes: count('TaskUpdates'),
    activity: count('ActivityLog'),
  });
  const refRows = (n: number | string) =>
    raw
      .prepare('SELECT role, kind, ref FROM TaskRefs WHERE task_id = ? ORDER BY rowid')
      .all(typeof n === 'number' ? id(n) : n);
  const notesOn = (n: number) =>
    raw
      .prepare('SELECT note, author_id FROM TaskUpdates WHERE task_id = ? ORDER BY rowid')
      .all(id(n));

  /** A task in Acme Solar whose source is forum.post:4411, as a watcher would have made it. */
  async function watcherTask(n = 1, extra: any = {}) {
    return newTask(TIM, n, 'Acme Solar', {
      project: 'Broken offer page',
      refs: [{ ref: 'forum.post:4411', role: 'source' }],
      ...extra,
    });
  }

  const report = (extra: any = {}) => ({
    project: 'Broken offer page',
    category: 'Acme Solar',
    refs: [
      { ref: 'forum.post:4411', role: 'source' },
      { ref: 'acme.member:123456', role: 'reported_by' },
    ],
    ...extra,
  });

  describe('a normal create', () => {
    it('answers 201 with created: true and a similar list', async () => {
      const res = await call('POST', '/projects', {
        project: 'Order flashing kits',
        category: 'Acme Solar',
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.similar).toEqual([]);
      expect(res.body.reported).toBeUndefined();
    });

    it('lists likely duplicates on the 201, never the new task itself', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page on the website' });
      const res = await call('POST', '/projects', {
        project: 'Fix offer page',
        category: 'Acme Solar',
      });
      expect(res.status).toBe(201);
      expect(res.body.similar).toHaveLength(1);
      expect(res.body.similar[0]).toMatchObject({
        id: id(1),
        shortId: short(1),
        title: 'Broken offer page on the website',
        status: 'do',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
        assigneeName: 'Casey Example',
        matchedRef: false,
      });
      expect(res.body.similar[0].score).toBeGreaterThan(0);
      expect(res.body.similar.map((s: any) => s.id)).not.toContain(res.body.id);
    });

    it('works the same on POST /tasks', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page' });
      const res = await call('POST', '/tasks', {
        projectId: 'proj-acme-solar',
        title: 'Offer page broken',
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.title).toBe('Offer page broken');
      expect(res.body.similar.map((s: any) => s.id)).toEqual([id(1)]);
    });
  });

  it('keeps a committed create successful when its optional suggestions lookup fails', async () => {
    vi.spyOn(similarService, 'findSimilarTasks').mockRejectedValueOnce(new Error('FTS unavailable'));
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await call('POST', '/projects', {
        project: 'A title with enough words',
        category: 'Acme Solar',
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.similar).toEqual([]);
      expect(count('Tasks')).toBe(1);
      expect(diagnostic).toHaveBeenCalledWith(
        '[Similar tasks] Could not load post-create suggestions',
        expect.any(Error)
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('does not create an unknown category when an existing personal source is returned or rejected', async () => {
    const holder = await newTask(TIM, 1, 'Personal', {
      project: 'Tracked outside report',
      refs: [{ ref: 'forum.post:4411', role: 'source' }],
    });
    const before = totals();
    const projectsBefore = count('Projects');
    const body = {
      project: 'A different task title',
      category: 'Fresh Workshop',
      refs: [{ ref: 'forum.post:4411', role: 'source' }],
    };

    const returned = await call('POST', '/projects', { ...body, onDuplicate: 'return' });
    expect(returned.status).toBe(200);
    expect(returned.body.id).toBe(holder.id);
    expect(count('Projects')).toBe(projectsBefore);
    expect(totals()).toEqual(before);

    const rejected = await call('POST', '/projects', body);
    expect(rejected.status).toBe(409);
    expect(rejected.body.taskId).toBe(holder.id);
    expect(count('Projects')).toBe(projectsBefore);
    expect(totals()).toEqual(before);
  });

  it('validates a creation goal before creating its project, task or releasing a source', async () => {
    await newTask(TIM, 1, 'Personal', {
      project: 'Deleted source holder',
      refs: [{ ref: 'forum.post:4411', role: 'source' }],
    });
    await projectService.deleteProject(db, TIM, id(1));
    const before = totals();
    const projectsBefore = count('Projects');
    const goalsBefore = count('TaskUserGoals');

    const res = await call('POST', '/projects', {
      project: 'Creation with an invalid goal',
      category: 'Fresh Workshop',
      goalId: 'goal-does-not-exist',
      refs: [{ ref: 'forum.post:4411', role: 'source' }],
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Life goal not found' });
    expect(totals()).toEqual(before);
    expect(count('Projects')).toBe(projectsBefore);
    expect(count('TaskUserGoals')).toBe(goalsBefore);
    expect(refRows(1)).toEqual([{ role: 'source', kind: 'forum.post', ref: '4411' }]);
  });

  describe('onDuplicate', () => {
    it('defaults to error: 409 with the task, and writes nothing', async () => {
      await watcherTask();
      const before = totals();
      const res = await call('POST', '/projects', report());
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        `forum.post:4411 is already the source of ${short(1)} "Broken offer page"`
      );
      expect(res.body.taskId).toBe(id(1));
      expect(res.body.task).toMatchObject({
        id: id(1),
        project: 'Broken offer page',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
      });
      expect(res.body.task.refs.map((r: any) => r.canonical)).toEqual(['forum.post:4411']);
      expect(totals()).toEqual(before);

      const explicit = await call('POST', '/projects', report({ onDuplicate: 'error' }));
      expect(explicit.status).toBe(409);
      expect(totals()).toEqual(before);
    });

    it('return: 200 with the existing task and created: false, writing nothing', async () => {
      await watcherTask();
      const before = totals();
      const res = await call(
        'POST',
        '/projects',
        report({ onDuplicate: 'return', notes: 'Again' })
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: id(1), project: 'Broken offer page', created: false });
      expect(res.body.reported).toBeUndefined();
      expect(res.body.similar).toBeUndefined();
      expect(totals()).toEqual(before);
    });

    it('report: adds the new refs and one note, all attributed', async () => {
      await watcherTask();
      const res = await call(
        'POST',
        '/projects',
        report({
          project: 'Offer page still broken',
          notes: 'Seen on the checkout too',
          onDuplicate: 'report',
          refs: [
            { ref: 'forum.post:4411', role: 'source' },
            { ref: 'acme.member:123456', role: 'reported_by' },
            { ref: 'github.issue:acme/widgets#12', role: 'about' },
          ],
        }),
        ROBIN
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: id(1), created: false, reported: true });
      expect(res.body.refs.map((r: any) => `${r.role} ${r.canonical}`)).toEqual([
        'source forum.post:4411',
        'about github.issue:acme/widgets#12',
        'reported_by acme.member:123456',
      ]);
      expect(notesOn(1)).toEqual([
        {
          note: 'Reported again: "Offer page still broken"\nSeen on the checkout too',
          author_id: ROBIN,
        },
      ]);
      const activity = await getActivity(db, TIM, { taskId: id(1) });
      const robins = activity.filter((a) => a.actorId === ROBIN).map((a) => a.action);
      expect(robins.sort()).toEqual(['note_added', 'ref_added', 'ref_added']);
      expect(count('Tasks')).toBe(1);
    });

    it('uses prepared statements in the guarded report-note batch', async () => {
      await watcherTask();
      const originalBatch = db.batch.bind(db);
      db.batch = (statements: any[]) => {
        for (const statement of statements) {
          const prepared = statement._prepare();
          if (prepared === statement) {
            throw new Error('A raw SQLite query cannot be batched by the D1 driver');
          }
        }
        return originalBatch(statements);
      };

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(res.status).toBe(200);
      expect(notesOn(1)).toHaveLength(1);
    });

    it('report: a pure retry adds nothing, and a retry with notes adds the note once', async () => {
      await watcherTask();
      const before = totals();
      // Same title, no notes, no new refs: nothing to say
      const pure = await call(
        'POST',
        '/projects',
        report({ refs: [{ ref: 'forum.post:4411', role: 'source' }], onDuplicate: 'report' })
      );
      expect(pure.status).toBe(200);
      expect(pure.body.reported).toBe(true);
      expect(totals()).toEqual(before);

      const first = await call('POST', '/projects', report({ onDuplicate: 'report' }));
      expect(first.status).toBe(200);
      expect(notesOn(1).map((n: any) => n.note)).toEqual(['Reported again: "Broken offer page"']);
      const afterFirst = totals();
      const again = await call('POST', '/projects', report({ onDuplicate: 'report' }));
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(id(1));
      expect(totals()).toEqual(afterFirst);

      const withNotes = report({ onDuplicate: 'report', notes: 'Customer chased' });
      await call('POST', '/projects', withNotes);
      await call('POST', '/projects', withNotes);
      expect(notesOn(1).map((n: any) => n.note)).toEqual([
        'Reported again: "Broken offer page"',
        'Reported again: "Broken offer page"\nCustomer chased',
      ]);
    });

    it('inserts one report note when identical reports race, including a non-pure retry', async () => {
      await watcherTask();
      const body = report({
        project: 'Offer page is still broken',
        notes: 'Seen again on the checkout',
        onDuplicate: 'report',
        refs: [{ ref: 'forum.post:4411', role: 'source' }],
      });

      const [first, second] = await Promise.all([
        call('POST', '/projects', body),
        call('POST', '/projects', body),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.id).toBe(id(1));
      expect(second.body.id).toBe(id(1));
      expect(notesOn(1).map((n: any) => n.note)).toEqual([
        'Reported again: "Offer page is still broken"\nSeen again on the checkout',
      ]);
      expect(count('ActivityLog', "action = 'note_added'")).toBe(1);

      await call('POST', '/projects', body);
      expect(notesOn(1)).toHaveLength(1);
      expect(count('ActivityLog', "action = 'note_added'")).toBe(1);
    });

    it('does not duplicate an identical note written before the report retry', async () => {
      await watcherTask();
      const note = 'Reported again: "Offer page was reported again"\nSaw it in the browser';
      await projectService.addProjectUpdate(db, {
        projectId: id(1),
        userId: TIM,
        note,
      });

      await call(
        'POST',
        '/projects',
        report({
          project: 'Offer page was reported again',
          notes: 'Saw it in the browser',
          refs: [{ ref: 'forum.post:4411', role: 'source' }],
          onDuplicate: 'report',
        })
      );

      expect(notesOn(1).map((entry: any) => entry.note)).toEqual([note]);
      expect(count('ActivityLog', "action = 'note_added'")).toBe(1);
    });

    it('keeps a report retry idempotent after the source task is merged into its holder', async () => {
      await watcherTask();
      await watcherTask(2, {
        project: 'Broken offer page duplicate',
        refs: [{ ref: 'forum.post:4412', role: 'source' }],
      });
      const targetReport = report({
        project: 'Checkout report',
        notes: 'Still broken in checkout',
        refs: [{ ref: 'forum.post:4411', role: 'source' }],
        onDuplicate: 'report',
      });
      const sourceReport = {
        ...targetReport,
        refs: [{ ref: 'forum.post:4412', role: 'source' }],
      };
      await call('POST', '/projects', targetReport, TIM);
      await call('POST', '/projects', sourceReport, ROBIN);

      await projectService.mergeProjects(db, TIM, id(1), id(2));
      const originalReports = notesOn(1).filter(
        (row: any) => row.note === 'Reported again: "Checkout report"\nStill broken in checkout'
      );
      expect(originalReports).toHaveLength(2);
      const before = totals();

      const retry = await call('POST', '/projects', targetReport, TIM);

      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id: id(1), created: false, reported: true });
      expect(totals()).toEqual(before);
      expect(
        notesOn(1).filter(
          (row: any) => row.note === 'Reported again: "Checkout report"\nStill broken in checkout'
        )
      ).toHaveLength(2);
    });

    it('reports to and returns done tasks without reopening them', async () => {
      await watcherTask(1, { status: 'done' });
      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('done');
      expect(raw.prepare('SELECT status FROM Tasks WHERE id = ?').get(id(1)).status).toBe('done');
    });

    it('ignores onDuplicate when there is no source ref', async () => {
      await watcherTask();
      const res = await call('POST', '/projects', {
        project: 'Broken offer page',
        category: 'Acme Solar',
        refs: [{ ref: 'forum.post:4411' }],
        onDuplicate: 'return',
      });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.id).not.toBe(id(1));
    });

    it('works on POST /tasks, answering in the /tasks shape', async () => {
      await watcherTask();
      const body = {
        projectId: 'proj-acme-solar',
        title: 'Broken offer page',
        refs: [{ ref: 'forum.post:4411', role: 'source' }],
      };
      const clash = await call('POST', '/tasks', body);
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({ taskId: id(1), task: { id: id(1) } });

      const returned = await call('POST', '/tasks', { ...body, onDuplicate: 'return' });
      expect(returned.status).toBe(200);
      expect(returned.body).toMatchObject({
        id: id(1),
        title: 'Broken offer page',
        created: false,
      });

      const reported = await call('POST', '/tasks', {
        ...body,
        title: 'Offer page down again',
        onDuplicate: 'report',
      });
      expect(reported.status).toBe(200);
      expect(reported.body).toMatchObject({ id: id(1), created: false, reported: true });
      expect(notesOn(1).map((n: any) => n.note)).toEqual([
        'Reported again: "Offer page down again"',
      ]);
    });

    it('includes the conflicting task in a ref-add 409 when the source is already taken', async () => {
      await watcherTask();
      await newTask(TIM, 2, 'Acme Solar');
      const res = await call('POST', `/tasks/${id(2)}/refs`, {
        ref: 'forum.post:4411',
        role: 'source',
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        taskId: id(1),
        task: { id: id(1), project: 'Broken offer page', projectName: 'Acme Solar' },
      });
    });

    it('refuses an unknown onDuplicate value', async () => {
      const res = await call('POST', '/projects', report({ onDuplicate: 'merge' }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('onDuplicate must be error, return or report');
    });

    it('refuses two sources in one request, writing nothing', async () => {
      const res = await call('POST', '/projects', {
        project: 'Two homes',
        category: 'Acme Solar',
        refs: [
          { ref: 'forum.post:1', role: 'source' },
          { ref: 'forum.post:2', role: 'source' },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'A task can only have one source' });
      expect(count('Tasks')).toBe(0);
      // The same source twice is one source
      const same = await call('POST', '/projects', {
        project: 'One home',
        category: 'Acme Solar',
        refs: [
          { ref: 'forum.post:1', role: 'source' },
          { ref: 'forum.post:1', role: 'source' },
        ],
      });
      expect(same.status).toBe(201);
    });

    it('a viewer gets 403 in every mode and adds nothing', async () => {
      await watcherTask();
      const before = totals();
      for (const onDuplicate of ['error', 'return', 'report']) {
        const res = await call('POST', '/projects', report({ onDuplicate }), VIEWER);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/view-only/);
      }
      expect(totals()).toEqual(before);
    });

    it('report needs edit rights on the task that holds the source', async () => {
      await watcherTask();
      const before = totals();
      // Jordan could edit Acme Solar once; now he is a viewer of the workspace
      raw.exec(`UPDATE OrganisationMembers SET role = 'viewer' WHERE id = 'm3'`);
      await expect(
        projectService.createProject(db, ROBIN, {
          ...report({ onDuplicate: 'report' }),
          id: id(9),
          status: 'do',
          priority: 5,
          size: '***',
        })
      ).rejects.toMatchObject({ status: 403 });
      expect(totals()).toEqual(before);
    });

    it('scopes the source to the workspace, so another workspace never sees the holder', async () => {
      await watcherTask();
      const res = await call(
        'POST',
        '/projects',
        report({ category: 'Other Workshop', onDuplicate: 'return' }),
        STRANGER
      );
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.id).not.toBe(id(1));
    });
  });

  describe('races', () => {
    /** Run `before` just ahead of the next batch, as if another worker had won the race. */
    function raceNextBatch(before: () => void) {
      const batch = db.batch.bind(db);
      db.batch = async (statements: any) => {
        db.batch = batch;
        before();
        return batch(statements);
      };
    }
    function mutateAfterSourceLookup(mutate: () => void | Promise<void>) {
      const findHolder = refService.findSourceHolder;
      vi.spyOn(refService, 'findSourceHolder').mockImplementationOnce(async (...args) => {
        const holder = await findHolder(...args);
        await mutate();
        return holder;
      });
    }
    const sneakIn = () =>
      raw.exec(`
        INSERT INTO Tasks (id, project_id, reporter_id, title, status, priority, size, is_deleted)
          VALUES ('${id(7)}', 'proj-acme-solar', '${ROBIN}', 'Broken offer page', 'do', 5, '***', 0);
        INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref)
          VALUES ('raced', '${id(7)}', 'org-md', 'source', 'forum.post', '4411');
      `);

    it('the loser of a race gets the mode it asked for, and one task survives', async () => {
      raceNextBatch(sneakIn);
      const res = await call('POST', '/projects', report({ onDuplicate: 'return' }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: id(7), created: false });
      expect(count('Tasks')).toBe(1);
      expect(count('ActivityLog', "action = 'created'")).toBe(0);
    });

    it('a lost race under the default is a 409 with the winner', async () => {
      raceNextBatch(sneakIn);
      const res = await call('POST', '/projects', report());
      expect(res.status).toBe(409);
      expect(res.body.taskId).toBe(id(7));
      expect(count('Tasks')).toBe(1);
    });

    it('a lost race under report reports to the winner', async () => {
      raceNextBatch(sneakIn);
      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: id(7), reported: true });
      expect(refRows(7)).toEqual([
        { role: 'source', kind: 'forum.post', ref: '4411' },
        { role: 'reported_by', kind: 'acme.member', ref: '123456' },
      ]);
      expect(count('Tasks')).toBe(1);
    });

    it('retries report when the source holder moves workspaces after lookup', async () => {
      const holder = await watcherTask();
      mutateAfterSourceLookup(() => {
        raw.exec(`
          UPDATE Tasks SET project_id = 'proj-personal' WHERE id = '${holder.id}';
          UPDATE TaskRefs SET org_id = 'org-tim' WHERE task_id = '${holder.id}';
        `);
      });

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ created: true, orgId: 'org-md' });
      expect(res.body.id).not.toBe(holder.id);
      expect(notesOn(1)).toEqual([]);
      expect(refRows(1)).toEqual([{ role: 'source', kind: 'forum.post', ref: '4411' }]);
      expect(refRows(res.body.id)).toContainEqual({
        role: 'reported_by',
        kind: 'acme.member',
        ref: '123456',
      });
    });

    it('does not add report refs if the holder moves before the conditional ref write', async () => {
      const holder = await watcherTask();
      const client = db.session.client;
      let moved = false;
      db.session.client = async (query: string, params: unknown[], method: string) => {
        if (
          !moved &&
          /insert into ["`]?TaskRefs/i.test(query) &&
          params.includes('acme.member')
        ) {
          moved = true;
          raw.exec(`
            UPDATE Tasks SET project_id = 'proj-personal' WHERE id = '${holder.id}';
            UPDATE TaskRefs SET org_id = 'org-tim' WHERE task_id = '${holder.id}';
          `);
        }
        return client(query, params, method);
      };

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(moved).toBe(true);
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.id).not.toBe(holder.id);
      expect(notesOn(1)).toEqual([]);
      expect(refRows(1)).toEqual([{ role: 'source', kind: 'forum.post', ref: '4411' }]);
    });

    it('does not add a report note if the holder moves before the conditional note batch', async () => {
      const holder = await watcherTask();
      const client = db.session.client;
      const batchClient = db.session.batchCLient;
      let moved = false;
      const moveHolder = () => {
        moved = true;
        raw.exec(`
          UPDATE Tasks SET project_id = 'proj-personal' WHERE id = '${holder.id}';
          UPDATE TaskRefs SET org_id = 'org-tim' WHERE task_id = '${holder.id}';
        `);
      };
      db.session.client = async (query: string, params: unknown[], method: string) => {
        if (!moved && /insert into ["`]?TaskUpdates/i.test(query)) {
          moveHolder();
        }
        return client(query, params, method);
      };
      db.session.batchCLient = async (queries: { sql: string }[]) => {
        if (!moved && queries.some((query) => /insert into ["`]?TaskUpdates/i.test(query.sql))) {
          moveHolder();
        }
        return batchClient(queries);
      };

      const res = await call(
        'POST',
        '/projects',
        report({
          project: 'Offer page outage again',
          notes: 'Checkout is still affected',
          refs: [{ ref: 'forum.post:4411', role: 'source' }],
          onDuplicate: 'report',
        })
      );

      expect(moved).toBe(true);
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.id).not.toBe(holder.id);
      expect(notesOn(1)).toEqual([]);
      expect(refRows(1)).toEqual([{ role: 'source', kind: 'forum.post', ref: '4411' }]);
    });

    it('does not return an invisible moved holder from the default conflict path', async () => {
      const holder = await watcherTask();
      mutateAfterSourceLookup(() => {
        raw.exec(`
          UPDATE Tasks SET project_id = 'proj-stranger' WHERE id = '${holder.id}';
          UPDATE TaskRefs SET org_id = 'org-stranger' WHERE task_id = '${holder.id}';
        `);
      });

      const res = await call('POST', '/projects', report());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ created: true, orgId: 'org-md' });
      expect(res.body.id).not.toBe(holder.id);
      expect(JSON.stringify(res.body)).not.toContain(holder.id);
    });

    it('retries report when the source holder is deleted after lookup', async () => {
      const holder = await watcherTask();
      mutateAfterSourceLookup(async () => {
        await projectService.deleteProject(db, TIM, holder.id);
      });

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(holder.id);
      expect(notesOn(1)).toEqual([]);
      expect(refRows(1)).toEqual([{ role: 'link', kind: 'forum.post', ref: '4411' }]);
    });

    it('retries report when the source is removed after lookup', async () => {
      const holder = await watcherTask();
      mutateAfterSourceLookup(() => {
        raw.prepare("DELETE FROM TaskRefs WHERE task_id = ? AND role = 'source'").run(holder.id);
      });

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(holder.id);
      expect(notesOn(1)).toEqual([]);
      expect(refRows(1)).toEqual([]);
    });

    it('reports to the new holder when the source is reassigned after lookup', async () => {
      const holder = await watcherTask();
      const nextHolder = await newTask(TIM, 2, 'Acme Solar');
      mutateAfterSourceLookup(() => {
        raw.prepare('UPDATE TaskRefs SET task_id = ? WHERE task_id = ? AND role = ?').run(
          nextHolder.id,
          holder.id,
          'source'
        );
      });

      const res = await call('POST', '/projects', report({ onDuplicate: 'report' }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: nextHolder.id, created: false, reported: true });
      expect(notesOn(1)).toEqual([]);
      expect(notesOn(2).map((row: any) => row.note)).toEqual([
        'Reported again: "Broken offer page"',
      ]);
      expect(refRows(1)).toEqual([]);
      expect(refRows(2)).toContainEqual({ role: 'reported_by', kind: 'acme.member', ref: '123456' });
    });

    it('a retried create under return gets the same task back', async () => {
      const first = await call('POST', '/projects', report({ onDuplicate: 'return' }));
      const second = await call('POST', '/projects', report({ onDuplicate: 'return' }));
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
    });
  });

  describe('deleted holders', () => {
    it('release their source as a link, and the create goes ahead', async () => {
      await watcherTask();
      await projectService.deleteProject(db, TIM, id(1));
      const res = await call('POST', '/projects', report({ onDuplicate: 'return' }));
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.refs.map((r: any) => `${r.role} ${r.canonical}`)).toEqual([
        'source forum.post:4411',
        'reported_by acme.member:123456',
      ]);
      expect(refRows(1)).toEqual([{ role: 'link', kind: 'forum.post', ref: '4411' }]);

      // Restoring the old task does not take the source back
      await projectService.updateProject(db, TIM, id(1), { isDeleted: false });
      expect(refRows(1)).toEqual([{ role: 'link', kind: 'forum.post', ref: '4411' }]);
      const again = await call('POST', '/projects', report({ onDuplicate: 'return' }));
      expect(again.body.id).toBe(res.body.id);
    });

    it('drop the source when the deleted task already links to the same thing', async () => {
      await watcherTask(1, {
        refs: [
          { ref: 'forum.post:4411', role: 'source' },
          { ref: 'forum.post:4411', role: 'link' },
        ],
      });
      await projectService.deleteProject(db, TIM, id(1));
      const res = await call('POST', '/projects', report());
      expect(res.status).toBe(201);
      expect(refRows(1)).toEqual([{ role: 'link', kind: 'forum.post', ref: '4411' }]);
    });

    it('also release their source to a ref added later, and to a task moved in', async () => {
      await watcherTask();
      await projectService.deleteProject(db, TIM, id(1));
      await newTask(TIM, 2, 'Acme Solar');
      const added = await refService.addRef(db, TIM, id(2), {
        ref: 'forum.post:4411',
        role: 'source',
      });
      expect(added.existing).toBe(false);
      expect(refRows(1)).toEqual([{ role: 'link', kind: 'forum.post', ref: '4411' }]);

      // A deleted holder in the destination does not block a move either
      await newTask(TIM, 3, 'Personal', { refs: [{ ref: 'forum.post:77', role: 'source' }] });
      await newTask(TIM, 4, 'Acme Solar', { refs: [{ ref: 'forum.post:77', role: 'source' }] });
      await projectService.deleteProject(db, TIM, id(4));
      const moved = await projectService.updateProject(db, TIM, id(3), {
        projectId: 'proj-acme-solar',
      });
      expect(moved?.orgId).toBe('org-md');
      expect(refRows(4)).toEqual([{ role: 'link', kind: 'forum.post', ref: '77' }]);
      expect(refRows(3)).toEqual([{ role: 'source', kind: 'forum.post', ref: '77' }]);
    });
  });

  it('leaves deleted sources and existing goal links untouched when a move has an invalid goal', async () => {
    await newTask(TIM, 3, 'Personal', {
      project: 'Tracked locally',
      refs: [{ ref: 'forum.post:77', role: 'source' }],
    });
    await newTask(TIM, 4, 'Acme Solar', {
      project: 'Deleted source holder',
      refs: [{ ref: 'forum.post:77', role: 'source' }],
    });
    await projectService.deleteProject(db, TIM, id(4));
    raw.exec(`
      INSERT INTO Goals (id, user_id, type, title) VALUES ('goal-existing', '${TIM}', 'aim', 'Keep this goal');
      INSERT INTO TaskUserGoals (task_id, user_id, goal_id) VALUES ('${id(3)}', '${TIM}', 'goal-existing');
    `);
    expect(raw.prepare('SELECT project_id FROM Tasks WHERE id = ?').get(id(3)).project_id).toBe(
      'proj-personal'
    );
    expect(raw.prepare('SELECT project_id FROM Tasks WHERE id = ?').get(id(4)).project_id).toBe(
      'proj-acme-solar'
    );
    expect(refRows(4)).toEqual([{ role: 'source', kind: 'forum.post', ref: '77' }]);
    expect(
      raw.prepare('SELECT goal_id FROM TaskUserGoals WHERE task_id = ?').all(id(3))
    ).toEqual([{ goal_id: 'goal-existing' }]);

    await expect(
      projectService.updateProject(db, TIM, id(3), {
        projectId: 'proj-acme-solar',
        goalId: 'goal-does-not-exist',
      })
    ).rejects.toMatchObject({ status: 404 });

    expect(refRows(4)).toEqual([{ role: 'source', kind: 'forum.post', ref: '77' }]);
    expect(raw.prepare('SELECT project_id FROM Tasks WHERE id = ?').get(id(3)).project_id).toBe(
      'proj-personal'
    );
    expect(
      raw.prepare('SELECT goal_id FROM TaskUserGoals WHERE task_id = ?').all(id(3))
    ).toEqual([{ goal_id: 'goal-existing' }]);
  });

  describe('similar tasks', () => {
    const similar = (query: string, as = TIM) =>
      call('GET', `/tasks/similar?${query}`, undefined, as);
    const titles = (res: { body: any[] }) => res.body.map((s) => s.title);
    const generatedTerms = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `z${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(
            97 + (index % 26)
          )}`
      );

    beforeEach(async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Broken offer page' });
      await newTask(TIM, 2, 'Acme Solar', { project: 'Call Jordan about the roof survey' });
      await newTask(TIM, 3, 'Acme Solar', { project: 'Call the scaffolders' });
      await newTask(TIM, 4, 'Personal', { project: 'Offer page copy for the blog' });
      await newTask(ROBIN, 5, 'Northstar Workshop', { project: 'Offer page translations' });
      await newTask(STRANGER, 6, 'Other Workshop', { project: 'Broken offer page' });
    });

    it('uses the editable same-name project for suggestions and create', async () => {
      raw.exec(`
        INSERT INTO Organisations (id, name, slug, created_by, is_personal)
          VALUES ('org-viewer-copy', 'Viewing Workshop', 'viewing-workshop', '${ROBIN}', 0);
        INSERT INTO OrganisationMembers (id, org_id, user_id, role)
          VALUES ('m-viewer-copy', 'org-viewer-copy', '${ROBIN}', 'viewer');
        INSERT INTO Projects (id, org_id, key, name)
          VALUES ('proj-viewer-copy', 'org-viewer-copy', 'VIEW', 'Shared Workshop');
        INSERT INTO Projects (id, org_id, key, name)
          VALUES ('proj-member-copy', 'org-md', 'MEM', 'shared workshop');
      `);
      raw.prepare(
        "INSERT INTO Tasks (id, project_id, reporter_id, title, status, priority, size, is_deleted) VALUES (?, ?, ?, ?, 'do', 5, '***', 0)"
      ).run(id(7), 'proj-viewer-copy', ROBIN, 'Fix invoice layout in viewer space');
      await newTask(ROBIN, 8, 'shared workshop', {
        project: 'Fix invoice layout in member space',
      });

      const suggestions = await similar('title=fix+invoice+layout&category=Shared+Workshop', ROBIN);
      expect(suggestions.body.map((task: any) => task.id)).toEqual([id(8)]);

      const created = await newTask(ROBIN, 9, 'SHARED WORKSHOP', {
        project: 'Fix invoice layout on the next order',
      });
      expect(created.projectId).toBe('proj-member-copy');
      expect(created.similar?.map((task: any) => task.id)).toEqual([id(8)]);
    });

    it('uses the personal workspace as the unknown-category destination', async () => {
      raw.exec(`
        INSERT INTO Organisations (id, name, slug, created_by, is_personal)
          VALUES ('org-jordan-home', 'Jordan Example', 'jordan-home', '${ROBIN}', 1);
        INSERT INTO OrganisationMembers (id, org_id, user_id, role)
          VALUES ('m-jordan-home', 'org-jordan-home', '${ROBIN}', 'owner');
        INSERT INTO Projects (id, org_id, key, name)
          VALUES ('proj-jordan-home', 'org-jordan-home', 'HOME', 'Personal');
      `);
      await newTask(ROBIN, 7, 'Personal', { project: 'Fix invoice layout at home' });

      const suggestions = await similar(
        'title=fix+invoice+layout&category=New+Workshop',
        ROBIN
      );
      expect(suggestions.body.map((task: any) => task.id)).toEqual([id(7)]);

      const created = await newTask(ROBIN, 8, 'New Workshop', {
        project: 'Fix invoice layout in the new workshop',
      });
      expect(created.orgId).toBe('org-jordan-home');
      expect(created.similar?.map((task: any) => task.id)).toEqual([id(7)]);
    });

    it('finds tasks sharing most of the significant words, best first', async () => {
      const res = await similar('title=Fix+the+broken+offer+page');
      expect(res.status).toBe(200);
      // Three of four words, then two of four (the shorter title first)
      expect(titles(res)).toEqual([
        'Broken offer page',
        'Offer page translations',
        'Offer page copy for the blog',
      ]);
      expect(res.body[0]).toMatchObject({
        id: id(1),
        shortId: short(1),
        status: 'do',
        projectName: 'Acme Solar',
        orgName: 'Northstar Workshop',
        assigneeName: 'Casey Example',
        matchedRef: false,
      });
      // Better matches score higher
      expect(res.body[0].score).toBeGreaterThan(res.body[1].score);
    });

    it('drops stop words and short words, and needs two significant words', async () => {
      expect((await similar('title=Offer')).body).toEqual([]);
      expect((await similar('title=the+offer+to+a+me')).body).toEqual([]);
      expect((await similar('title=')).status).toBe(400);
      expect(similarService.significantWords("Fix the Offer page, it's broken!!")).toEqual([
        'fix',
        'offer',
        'page',
        'broken',
      ]);
    });

    it('needs at least two words and half of them to match', async () => {
      // "call" alone is not enough to suggest every call
      expect(titles(await similar('title=Call+Jordan'))).toEqual([
        'Call Jordan about the roof survey',
      ]);
      expect((await similar('title=Call+plumber')).body).toEqual([]);
      // Two of five words is fewer than half
      expect((await similar('title=Offer+page+renewal+pricing+strategy')).body).toEqual([]);
    });

    it('scopes to a project workspace, a workspace, or everything visible', async () => {
      const inProject = await similar('title=offer+page+fix&projectId=proj-acme-solar');
      expect(titles(inProject).sort()).toEqual(['Broken offer page', 'Offer page translations']);
      const inOrg = await similar('title=offer+page+fix&orgId=org-tim');
      expect(titles(inOrg)).toEqual(['Offer page copy for the blog']);
      const byName = await similar('title=offer+page+fix&category=Personal');
      expect(titles(byName)).toEqual(['Offer page copy for the blog']);
      // The stranger only sees their own
      const theirs = await similar('title=offer+page+fix', STRANGER);
      expect(theirs.body.map((s: any) => s.id)).toEqual([id(6)]);
      // Somebody else's project or workspace is not found
      expect((await similar('title=offer+page&projectId=proj-stranger')).status).toBe(404);
      expect((await similar('title=offer+page&orgId=org-stranger')).status).toBe(404);
    });

    it('honours excludeId and limit', async () => {
      const res = await similar(`title=offer+page+fix&excludeId=${id(1)}&limit=1`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).not.toBe(id(1));
      const many = await similar('title=offer+page+fix&limit=50');
      expect(many.status).toBe(200);
      expect(many.body.length).toBeLessThanOrEqual(10);
      expect((await similar('title=offer+page&limit=none')).status).toBe(400);
    });

    it('never suggests done, deleted or invisible tasks', async () => {
      await projectService.updateProject(db, TIM, id(1), { status: 'done' });
      await projectService.deleteProject(db, TIM, id(4));
      const res = await similar('title=offer+page+fix');
      expect(titles(res)).toEqual(['Offer page translations']);
    });

    it('weighs the title above the reason and notes', async () => {
      await newTask(TIM, 8, 'Acme Solar', {
        project: 'Website fixes',
        reason: 'The offer page is broken',
      });
      const res = await similar('title=broken+offer+page&projectId=proj-acme-solar');
      expect(titles(res)[0]).toBe('Broken offer page');
      expect(titles(res)).toContain('Website fixes');
    });

    it('scores every significant word in a long title, not only the bounded FTS sample', async () => {
      const words = [
        'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'igloo',
        'juliet', 'karma', 'lemon', 'mango', 'nickel', 'orange', 'pepper', 'queen',
      ];
      await newTask(TIM, 9, 'Acme Solar', { project: words.slice(0, 8).join(' ') });
      const res = await similar(`title=${encodeURIComponent(words.join(' '))}`);
      expect(res.status).toBe(200);
      expect(res.body.map((task: any) => task.id)).not.toContain(id(9));
    });

    it('keeps qualifying matches behind crowded one-word FTS results', async () => {
      const terms = ['hazel', 'marigold', 'almanac'];
      for (let index = 0; index < 50; index++) {
        const term = terms[index % terms.length];
        await newTask(TIM, 20 + index, 'Acme Solar', {
          project: `${term} onehit ${index}`,
        });
      }
      await newTask(TIM, 70, 'Acme Solar', {
        project: 'Independent note',
        notes: `${terms.join(' ')} ${'detail '.repeat(100)}`,
      });

      const res = await similar(`title=${terms.join('+')}`);

      expect(res.body.map((task: any) => task.id)).toContain(id(70));
    });

    it('uses unrounded coverage at the half-score boundary', async () => {
      const words = generatedTerms(101);
      expect(words.join(' ').length).toBeLessThanOrEqual(similarService.MAX_TITLE_LENGTH);
      await newTask(TIM, 72, 'Acme Solar', { project: words.slice(0, 50).join(' ') });
      await newTask(TIM, 73, 'Acme Solar', { project: words.slice(0, 51).join(' ') });

      const res = await similar(`title=${encodeURIComponent(words.join(' '))}`);

      expect(res.status).toBe(200);
      expect(res.body.map((task: any) => task.id)).toEqual([id(73)]);
      expect(res.body[0].score).toBe(0.5);
    });

    it('scores every significant word at the maximum title length', async () => {
      const words = Array.from(
        { length: 125 },
        (_, index) => `z${String.fromCharCode(97 + Math.floor(index / 10))}${index % 10}`
      );
      const title = words.join(' ');
      expect(title.length).toBe(499);
      expect(similarService.significantWords(title)).toEqual(words);
      await newTask(TIM, 74, 'Acme Solar', { project: words.slice(0, 62).join(' ') });
      await newTask(TIM, 75, 'Acme Solar', { project: words.slice(0, 63).join(' ') });

      const sqlStatements: string[] = [];
      const originalValues = db.values.bind(db);
      db.values = (query: any) => {
        sqlStatements.push(db.dialect.sqlToQuery(query.getSQL()).sql);
        return originalValues(query);
      };
      const responses: { status: number; body: any[] }[] = [];
      try {
        for (const queryTitle of [title, `${title}.`]) {
          responses.push(
            await similar(`title=${encodeURIComponent(queryTitle)}`)
          );
        }
      } finally {
        db.values = originalValues;
      }

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.map((task: any) => task.id)).toEqual([id(75)]);
        expect(res.body[0].score).toBe(0.5);
      }
      expect(sqlStatements).toHaveLength(2);
      for (const statement of sqlStatements) {
        expect(statement).toContain('json_each');
        expect(statement.match(/Tasks_FTS"?\s*\(/gi)).toHaveLength(2);
        expect(statement.match(/\(\s*SELECT\s+rowid\s+FROM\s+Tasks_FTS/gi)).toBeNull();
      }
      expect(stats.maxBindings).toBeLessThanOrEqual(100);
    });

    it('rejects titles over the shared input limit with a clear 400', async () => {
      const title = `offer page ${'x'.repeat(similarService.MAX_TITLE_LENGTH)}`;
      const res = await similar(`title=${encodeURIComponent(title)}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        `title must be ${similarService.MAX_TITLE_LENGTH} characters or fewer`
      );
    });

    it('marks view-only category suggestions so callers do not offer unavailable note actions', async () => {
      const res = await similar(
        'title=broken+offer+page&category=Northstar+Workshop',
        VIEWER
      );
      expect(res.body[0]).toMatchObject({ id: id(1), canEdit: false });
    });

    it('keeps suggestion searches under D1 binding limits with many memberships', async () => {
      for (let n = 0; n < 110; n++) {
        const orgId = `org-many-${n}`;
        raw.prepare(
          'INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES (?, ?, ?, ?, 0)'
        ).run(orgId, `Workshop ${n}`, `workshop-${n}`, TIM);
        raw.prepare(
          "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')"
        ).run(`m-many-${n}`, orgId, TIM);
        raw.prepare('INSERT INTO Projects (id, org_id, key, name) VALUES (?, ?, ?, ?)').run(
          `proj-many-${n}`,
          orgId,
          `W${n}`,
          `Project ${n}`
        );
      }

      const res = await similar('title=broken+offer+page');
      expect(res.status).toBe(200);
      expect(titles(res)).toContain('Broken offer page');
      expect(stats.maxBindings).toBeLessThanOrEqual(100);
    });

    it('survives punctuation and FTS syntax in the title', async () => {
      for (const title of [
        '"offer" page* OR NOT',
        'offer-page (NEAR/2) ^broken',
        "offer's page: {x}",
      ]) {
        const res = await similar(`title=${encodeURIComponent(title)}`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
      }
    });
  });
});
