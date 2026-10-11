import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import projectsApp from '../routes/projects';
import tasksApp from '../routes/tasks';
import { getSelectedTaskRows } from '../services/taskListService';
import { getSelectedTaskSummariesForUser } from '../services/projectService';
import { createTestDb } from './helpers/testDb';
import { boardScaleTaskId, CASEY_ID, JORDAN_ID, seedBoardScale } from './fixtures/boardScaleFixture';

function createApi(db: any, userId = CASEY_ID) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('db', db);
    await next();
  });
  app.route('/api/v2/projects', projectsApp);
  app.route('/api/v2/tasks', tasksApp);
  return app;
}

const statuses = ['do', 'delay', 'awaiting', 'delegate', 'done'];

function timestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function orderedFixtureRows(rows: any[], completed = false) {
  return rows.sort((left, right) => {
    if (!completed && left.status !== right.status) {
      return left.status < right.status ? -1 : 1;
    }
    const leftCompleted = timestamp(left.status_last_changed_on ?? left.created_at);
    const rightCompleted = timestamp(right.status_last_changed_on ?? right.created_at);
    const leftUpdated = timestamp(left.updated_at ?? left.created_at);
    const rightUpdated = timestamp(right.updated_at ?? right.created_at);
    if (completed && leftCompleted !== rightCompleted) {
      return rightCompleted - leftCompleted;
    }
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

describe('board-scale project list API', () => {
  let db: any;
  let raw: any;
  let stats: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedBoardScale(raw);
    app = createApi(db);
  });

  it('keeps the no-parameter project list unlimited and returns full bodies with note metadata', async () => {
    const response = await app.request('/api/v2/projects');
    expect(response.status).toBe(200);
    const items = (await response.json()) as any[];
    expect(items).toHaveLength(1000);
    expect(items.find((item: any) => item.id === boardScaleTaskId(0))).toMatchObject({
      notes: 'Full task body 0',
      noteCount: 2,
      lastNoteAt: '2026-10-09T09:00:00.000Z',
    });
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('returns SQL-projected summaries, total count and a continuation header', async () => {
    stats.reset();
    const response = await app.request('/api/v2/projects?fields=summary&limit=1');
    expect(response.status).toBe(200);
    const items = (await response.json()) as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: boardScaleTaskId(426),
      noteCount: 2,
      lastNoteAt: '2026-10-09T09:00:00.000Z',
    });
    expect(items[0]).not.toHaveProperty('notes');
    expect(response.headers.get('X-Total-Count')).toBe('1000');
    expect(response.headers.get('X-Next-Cursor')).toBeTruthy();
    const taskSelect = stats.statements.find((entry: any) => /FROM ["`]?Tasks/i.test(entry.sql));
    expect(taskSelect).toBeTruthy();
    expect(taskSelect.sql).not.toMatch(/Tasks\.notes|\bnotes\b/i);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
    expect(stats.statements.some((entry: any) => /FROM ["`]?TaskRefs/i.test(entry.sql))).toBe(true);
    expect(stats.statements.some((entry: any) => /FROM ["`]?TaskUpdates/i.test(entry.sql))).toBe(true);
  });

  it('enriches refs, notes and personal goals only for the selected page id', async () => {
    stats.reset();
    const response = await app.request(
      '/api/v2/projects?fields=summary&limit=1&projectId=scale-project-001&ref=forum.post%3Ascale-fixture-1'
    );
    expect(response.status).toBe(200);
    const [item] = (await response.json()) as any[];
    expect(item).toMatchObject({
      id: boardScaleTaskId(1),
      goalId: 'scale-goal-casey',
      noteCount: 1,
      refs: [{ canonical: 'forum.post:scale-fixture-1' }],
    });
    expect(item).not.toHaveProperty('notes');
    expect(response.headers.get('X-Total-Count')).toBe('1');
    const refReads = stats.statements.filter((entry: any) => /FROM ["`]?TaskRefs/i.test(entry.sql));
    const refs = refReads.find((entry: any) => entry.parameterCount === 1);
    const goals = stats.statements.find((entry: any) => /FROM ["`]?TaskUserGoals/i.test(entry.sql));
    const updates = stats.statements.find((entry: any) => /FROM ["`]?TaskUpdates/i.test(entry.sql));
    expect(refs).toBeTruthy();
    expect(goals.parameterCount).toBe(2);
    expect(updates.parameterCount).toBe(1);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('preserves ranked selected ids across chunks while omitting unavailable tasks', async () => {
    const rankedIds = [
      boardScaleTaskId(889),
      boardScaleTaskId(0),
      boardScaleTaskId(999),
      'missing-fixture-task',
      boardScaleTaskId(30),
      ...Array.from({ length: 95 }, (_, index) => boardScaleTaskId(200 - index)),
      boardScaleTaskId(889),
    ];
    raw.prepare('UPDATE Tasks SET is_deleted = 1 WHERE id = ?').run(boardScaleTaskId(30));
    const expectedIds = [
      boardScaleTaskId(889),
      boardScaleTaskId(0),
      ...Array.from({ length: 95 }, (_, index) => boardScaleTaskId(200 - index)),
    ];

    for (const readSelected of [getSelectedTaskRows, getSelectedTaskSummariesForUser]) {
      stats.reset();
      const rows = await readSelected(db, JORDAN_ID, rankedIds);
      expect(rows.map((row) => row.id)).toEqual(expectedIds);
      expect(rows.every((row) => !Object.hasOwn(row, 'notes'))).toBe(true);
      expect(stats.maxBindings).toBeLessThanOrEqual(100);
    }
  });

  it('hydrates selected bodies without changing rank or clipping long notes', async () => {
    const ids = [boardScaleTaskId(889), boardScaleTaskId(20)];
    const rows = await getSelectedTaskRows(db, JORDAN_ID, ids, { fields: 'full' });
    expect(rows.map((row) => row.id)).toEqual(ids);
    const body = raw.prepare('SELECT notes FROM Tasks WHERE id = ?').get(ids[1]).notes;
    expect(body.length).toBeGreaterThan(20000);
    expect(rows[1].notes).toBe(body);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('caps selected reads at 150 distinct ids rather than the number of supplied ids', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => boardScaleTaskId(149 - index));
    for (const readSelected of [getSelectedTaskRows, getSelectedTaskSummariesForUser]) {
      stats.reset();
      const rows = await readSelected(db, CASEY_ID, [...ids, ids[0]]);
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(stats.maxBindings).toBeLessThanOrEqual(100);
      await expect(
        readSelected(db, CASEY_ID, [...ids, boardScaleTaskId(150)])
      ).rejects.toThrow('Selected task reads are limited to 150 ids');
    }
  });

  it('aggregates every status, including zero-valued statuses, before paging', async () => {
    const allResponse = await app.request('/api/v2/projects/counts');
    expect(allResponse.status).toBe(200);
    expect(await allResponse.json()).toEqual({
      byStatus: { do: 213, delay: 213, awaiting: 212, delegate: 212, done: 150 },
      total: 1000,
    });

    const response = await app.request('/api/v2/projects/counts?status=do,delay');
    expect(response.status).toBe(200);
    const counts = (await response.json()) as any;
    expect(counts).toEqual({
      byStatus: { do: 213, delay: 213, awaiting: 0, delegate: 0, done: 0 },
      total: 426,
    });
    expect(Object.keys(counts.byStatus)).toEqual(statuses);

    const ignoredPaging = await app.request(
      '/api/v2/projects/counts?status=do,delay&fields=invalid&limit=0&cursor=stale'
    );
    expect(await ignoredPaging.json()).toEqual(counts);
  });

  it('walks a stable default-order keyset without gaps or repeats', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    const expectedTotal = 1000;
    do {
      const query = new URLSearchParams({ limit: '83' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await app.request(`/api/v2/projects?${query.toString()}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Total-Count')).toBe(String(expectedTotal));
      const items = (await response.json()) as any[];
      ids.push(...items.map((item: any) => item.id));
      cursor = response.headers.get('X-Next-Cursor');
    } while (cursor);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
    const expected = orderedFixtureRows(
      raw.prepare('SELECT id, status, priority, status_last_changed_on, created_at, updated_at FROM Tasks').all()
    ).map((row: any) => row.id);
    expect(ids).toEqual(expected);
  });

  it('continues from the stored cursor key after deleting the cursor row', async () => {
    const first = await app.request('/api/v2/projects?limit=10');
    const firstItems = (await first.json()) as any[];
    const nextCursor = first.headers.get('X-Next-Cursor');
    expect(nextCursor).toBeTruthy();
    const ids = firstItems.map((item: any) => item.id);
    raw.prepare('DELETE FROM Tasks WHERE id = ?').run(firstItems[9].id);

    let cursor: string | null = nextCursor;
    while (cursor) {
      const next = await app.request(
        `/api/v2/projects?limit=10&cursor=${encodeURIComponent(cursor)}`
      );
      expect(next.status).toBe(200);
      const nextItems = (await next.json()) as any[];
      ids.push(...nextItems.map((item: any) => item.id));
      cursor = next.headers.get('X-Next-Cursor');
    }
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
  });

  it('keeps completion paging Done-only and uses created time when completion time is missing', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '31', sort: 'completed', status: 'done' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await app.request(`/api/v2/projects?${query.toString()}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Total-Count')).toBe('150');
      const items = (await response.json()) as any[];
      expect(items.every((item: any) => item.status === 'done')).toBe(true);
      ids.push(...items.map((item: any) => item.id));
      cursor = response.headers.get('X-Next-Cursor');
    } while (cursor);
    expect(ids).toHaveLength(150);
    expect(new Set(ids).size).toBe(150);
    const expected = orderedFixtureRows(
      raw.prepare("SELECT id, status, priority, status_last_changed_on, created_at, updated_at FROM Tasks WHERE status = 'done'").all(),
      true
    ).map((row: any) => row.id);
    expect(ids).toEqual(expected);
    expect(ids.slice(0, 40)).not.toContain(boardScaleTaskId(890));

    const recent = await app.request('/api/v2/projects/counts?status=done&doneSince=2026-09-26');
    const older = await app.request('/api/v2/projects/counts?status=done&doneBefore=2026-09-26');
    expect(((await recent.json()) as any).total).toBe(40);
    expect(((await older.json()) as any).total).toBe(110);
  });

  it('includes the exact UTC Done cutoff only in the recent window', async () => {
    const cutoffId = boardScaleTaskId(889);
    expect(
      raw.prepare('SELECT status_last_changed_on FROM Tasks WHERE id = ?').get(cutoffId)
    ).toMatchObject({ status_last_changed_on: '2026-09-26T00:00:00.000Z' });

    const recent = await app.request(
      '/api/v2/projects?status=done&doneSince=2026-09-26&fields=summary'
    );
    const older = await app.request(
      '/api/v2/projects?status=done&doneBefore=2026-09-26&fields=summary'
    );
    expect(recent.status).toBe(200);
    expect(older.status).toBe(200);
    const recentItems = (await recent.json()) as any[];
    const olderItems = (await older.json()) as any[];
    expect(recentItems).toHaveLength(40);
    expect(olderItems).toHaveLength(110);
    expect(recentItems.some((item: any) => item.id === cutoffId)).toBe(true);
    expect(olderItems.some((item: any) => item.id === cutoffId)).toBe(false);
    expect(new Set([...recentItems, ...olderItems].map((item: any) => item.id)).size).toBe(150);
  });

  it('uses the same semantic filters for list and counts, with caller-specific goal and assignee scope', async () => {
    const cases = [
      'status=do,delay&shared=true&noEpic=true',
      'goalId=scale-goal-casey',
      'customer=Acme%20Solar&tag=scale',
      'relatedTo=scale-task-0002',
      'ref=forum.post%3Ascale-fixture-1&role=link',
      'assignee=me',
      'noGoal=true',
      'noCategory=true',
      'unlinked=any',
      'unlinked=goal',
      'unlinked=category',
    ];
    for (const filter of cases) {
      const listResponse = await app.request(`/api/v2/projects?${filter}`);
      const countResponse = await app.request(`/api/v2/projects/counts?${filter}`);
      expect(listResponse.status).toBe(200);
      expect(countResponse.status).toBe(200);
      const items = (await listResponse.json()) as any[];
      const counts = (await countResponse.json()) as any;
      expect(items).toHaveLength(counts.total);
    }

    const jordanApp = createApi(db, JORDAN_ID);
    const jordanList = await jordanApp.request('/api/v2/projects');
    const jordanItems = (await jordanList.json()) as any[];
    expect(jordanItems).toHaveLength(999);
    expect(jordanItems.some((item: any) => item.id === boardScaleTaskId(999))).toBe(false);
    expect(jordanItems.find((item: any) => item.id === boardScaleTaskId(998))?.myRole).toBe('viewer');
    expect(jordanItems.find((item: any) => item.id === boardScaleTaskId(1))?.goalId).toBe('scale-goal-jordan');
  });

  it.each(['category', 'customer'])(
    'does not reuse an unfiltered cursor for a whitespace-only %s predicate',
    async (filter) => {
      const first = await app.request(`/api/v2/projects?limit=1&${filter}=`);
      expect(first.status).toBe(200);
      expect(first.headers.get('X-Total-Count')).toBe('1000');
      const cursor = first.headers.get('X-Next-Cursor');
      expect(cursor).toBeTruthy();

      const changed = await app.request(
        `/api/v2/projects?limit=1&${filter}=%20&cursor=${encodeURIComponent(cursor!)}`
      );
      expect(changed.status).toBe(400);
      expect(await changed.json()).toEqual({
        error: 'That page link has expired, start again without a cursor',
      });
    }
  );

  it('rejects invalid list values and cursors bound to a different filter', async () => {
    expect((await app.request('/api/v2/projects?status=not-a-status')).status).toBe(400);
    expect((await app.request('/api/v2/projects?cursor=bad')).status).toBe(400);
    expect((await app.request('/api/v2/projects?limit=1&cursor=bad')).status).toBe(400);
    expect((await app.request('/api/v2/projects?limit=0')).status).toBe(400);
    expect((await app.request('/api/v2/projects?doneSince=2026-02-30')).status).toBe(400);
    expect((await app.request('/api/v2/projects?shared=yes')).status).toBe(400);
    expect((await app.request('/api/v2/projects?role=invalid')).status).toBe(400);

    const first = await app.request('/api/v2/projects?limit=1');
    const cursor = first.headers.get('X-Next-Cursor');
    const payload = JSON.parse(
      atob(cursor!.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor!.length % 4)) % 4))
    );
    payload.v = 2;
    const wrongVersion = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const invalidVersion = await app.request(
      `/api/v2/projects?limit=1&cursor=${encodeURIComponent(wrongVersion)}`
    );
    expect(invalidVersion.status).toBe(400);
    expect(await invalidVersion.json()).toEqual({
      error: 'That page link has expired, start again without a cursor',
    });

    const mismatched = await app.request(
      `/api/v2/projects?limit=1&status=do&cursor=${encodeURIComponent(cursor!)}`
    );
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toEqual({
      error: 'That page link has expired, start again without a cursor',
    });
  });

  it('keeps raw task list results unlimited and preserves its legacy mine semantics', async () => {
    const allResponse = await app.request('/api/v2/tasks');
    expect(allResponse.status).toBe(200);
    const allItems = (await allResponse.json()) as any[];
    expect(allItems).toHaveLength(1000);
    expect(allItems.find((item: any) => item.id === boardScaleTaskId(0))).toMatchObject({
      notes: 'Full task body 0',
    });
    expect(stats.maxBindings).toBeLessThanOrEqual(100);

    const mineResponse = await app.request('/api/v2/tasks?mine=true');
    expect(mineResponse.status).toBe(200);
    const mineItems = (await mineResponse.json()) as any[];
    expect(mineItems.every((item: any) => item.assigneeId === CASEY_ID)).toBe(true);
    expect(mineItems.length).toBeGreaterThan(0);
  });

  it('exposes paging response headers to cross-origin browsers', async () => {
    const response = await worker.fetch(
      new Request('https://timdo.tdobson.net/api/v2/projects', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://timdo.tdobson.net',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      { DB: {} } as any,
      {} as any
    );
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Total-Count');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Next-Cursor');
  });
});
