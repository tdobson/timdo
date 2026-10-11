import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import projectsApp from '../routes/projects';
import tasksApp from '../routes/tasks';
import {
  getRawTasksForUser,
  getTaskCountsForUser,
  getTaskListForUser,
} from '../services/taskListService';
import { createTestDb } from './helpers/testDb';
import { CASEY_ID, seedBoardScale } from './fixtures/boardScaleFixture';

function createApi(db: any) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', CASEY_ID);
    c.set('db', db);
    await next();
  });
  app.route('/api/v2/projects', projectsApp);
  app.route('/api/v2/tasks', tasksApp);
  return app;
}

function insertProject(raw: any, id: string, name: string) {
  raw
    .prepare('INSERT INTO Projects (id, org_id, key, name) VALUES (?, ?, ?, ?)')
    .run(id, 'org-md', `E${id}`, name);
}

function insertTask(
  raw: any,
  id: string,
  projectId: string,
  customer: string | null = null
) {
  raw.prepare(`
    INSERT INTO Tasks (id, project_id, reporter_id, title, customer, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-10-10T12:00:00.000Z', '2026-10-10T12:00:00.000Z')
  `).run(id, projectId, CASEY_ID, `Edge fixture ${id}`, customer);
}

function caseVariant(value: string, mask: number): string {
  return Array.from(value, (character, index) =>
    mask & (1 << index) ? character.toUpperCase() : character
  ).join('');
}

const INVALID_CURSOR = 'That page link has expired, start again without a cursor';
const INVALID_UNLINKED = 'unlinked must be any, epic, goal or category';

describe('task list edge cases', () => {
  let db: any;
  let raw: any;
  let stats: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedBoardScale(raw);
    app = createApi(db);
  });

  it('matches Unicode category variants in SQL with bounded binds and equivalent cursors', async () => {
    const category = 'écoleabcde';
    const variants = Array.from({ length: 105 }, (_, index) => caseVariant(category, index));
    expect(new Set(variants).size).toBeGreaterThan(100);

    const insert = raw.prepare('INSERT INTO Projects (id, org_id, key, name) VALUES (?, ?, ?, ?)');
    for (const [index, name] of variants.entries()) {
      insert.run(`unicode-category-project-${index}`, 'org-md', `UC${index}`, name);
    }
    insertTask(raw, 'unicode-category-task-one', 'unicode-category-project-1');
    insertTask(raw, 'unicode-category-task-two', 'unicode-category-project-2');

    const firstQuery = new URLSearchParams({ category, limit: '1' });
    const first = await app.request(`/api/v2/projects?${firstQuery}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Total-Count')).toBe('2');
    const firstItems = (await first.json()) as any[];
    expect(firstItems).toHaveLength(1);
    const cursor = first.headers.get('X-Next-Cursor');
    expect(cursor).toBeTruthy();

    const secondQuery = new URLSearchParams({
      category: 'ÉCOLEABCDE',
      limit: '1',
      cursor: cursor!,
    });
    const second = await app.request(`/api/v2/projects?${secondQuery}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toHaveLength(1);
    expect(second.headers.get('X-Next-Cursor')).toBeNull();

    const countQuery = new URLSearchParams({ category: 'ÉCOLEABCDE' });
    const counts = await app.request(`/api/v2/projects/counts?${countQuery}`);
    expect(counts.status).toBe(200);
    expect(((await counts.json()) as any).total).toBe(2);
    expect(stats.statements.some((statement: any) => /json_each\(\?/i.test(statement.sql))).toBe(true);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('rejects empty unlinked on list, counts and raw task routes', async () => {
    const responses = await Promise.all([
      app.request('/api/v2/projects?unlinked='),
      app.request('/api/v2/projects/counts?unlinked='),
      app.request('/api/v2/tasks?unlinked='),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    for (const response of responses) {
      expect(await response.json()).toEqual({ error: INVALID_UNLINKED });
    }
  });

  it('rejects empty unlinked in exported task-list helpers', async () => {
    const filters = { unlinked: '' } as any;
    const results = await Promise.allSettled([
      getTaskListForUser(db, CASEY_ID, filters),
      getTaskCountsForUser(db, CASEY_ID, filters),
      getRawTasksForUser(db, CASEY_ID, filters),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ message: INVALID_UNLINKED });
      }
    }
  });

  it('keeps SQLite customer matching and fingerprints distinct Unicode case predicates', async () => {
    const projectId = 'unicode-customer-project';
    insertProject(raw, projectId, 'Unicode customer fixture');
    insertTask(raw, 'unicode-customer-upper-one', projectId, 'École');
    insertTask(raw, 'unicode-customer-upper-two', projectId, 'École');
    insertTask(raw, 'unicode-customer-lower', projectId, 'école');

    const upperQuery = new URLSearchParams({ customer: 'École' });
    const upperCounts = await app.request(`/api/v2/projects/counts?${upperQuery}`);
    expect(((await upperCounts.json()) as any).total).toBe(2);
    const lowerQuery = new URLSearchParams({ customer: 'école' });
    const lowerCounts = await app.request(`/api/v2/projects/counts?${lowerQuery}`);
    expect(((await lowerCounts.json()) as any).total).toBe(1);

    const firstQuery = new URLSearchParams({ customer: 'École', limit: '1' });
    const first = await app.request(`/api/v2/projects?${firstQuery}`);
    expect(first.status).toBe(200);
    const cursor = first.headers.get('X-Next-Cursor');
    expect(cursor).toBeTruthy();
    const changedCaseQuery = new URLSearchParams({ customer: 'école', limit: '1', cursor: cursor! });
    const changedCase = await app.request(`/api/v2/projects?${changedCaseQuery}`);
    expect(changedCase.status).toBe(400);
    expect(await changedCase.json()).toEqual({ error: INVALID_CURSOR });

    const asciiFirstQuery = new URLSearchParams({ customer: 'Acme Solar', limit: '1' });
    const asciiFirst = await app.request(`/api/v2/projects?${asciiFirstQuery}`);
    const asciiCursor = asciiFirst.headers.get('X-Next-Cursor');
    expect(asciiCursor).toBeTruthy();
    const asciiChangedCaseQuery = new URLSearchParams({
      customer: 'ACME SOLAR',
      limit: '1',
      cursor: asciiCursor!,
    });
    expect((await app.request(`/api/v2/projects?${asciiChangedCaseQuery}`)).status).toBe(200);
  });

  it('does not reuse an unfiltered cursor for an unresolved related-task predicate', async () => {
    const first = await app.request('/api/v2/projects?limit=1');
    const cursor = first.headers.get('X-Next-Cursor');
    expect(cursor).toBeTruthy();

    const changedFilter = new URLSearchParams({
      limit: '1',
      relatedTo: 'not-a-visible-task',
      cursor: cursor!,
    });
    const response = await app.request(`/api/v2/projects?${changedFilter}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: INVALID_CURSOR });
  });

  it('walks pages through long and non-ASCII task ids', async () => {
    const projectId = 'long-id-cursor-project';
    insertProject(raw, projectId, 'Long id cursor fixture');
    const ids = ['a'.repeat(129), 'middle-id', 'zeta-id', 'éclair-id', '雪-id'];
    for (const id of ids) {
      insertTask(raw, id, projectId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ projectId, limit: '1' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await app.request(`/api/v2/projects?${query}`);
      expect(response.status).toBe(200);
      const items = (await response.json()) as any[];
      expect(items).toHaveLength(1);
      seen.push(items[0].id);
      cursor = response.headers.get('X-Next-Cursor');
      expect(cursor === null || cursor.length <= 4096).toBe(true);
    } while (cursor);

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('fails clearly instead of returning an oversized continuation token', async () => {
    const projectId = 'oversized-cursor-project';
    insertProject(raw, projectId, 'Oversized cursor fixture');
    insertTask(raw, 'a', projectId);
    insertTask(raw, 'x'.repeat(4000), projectId);
    insertTask(raw, '雪', projectId);

    const firstQuery = new URLSearchParams({ projectId, limit: '1' });
    const first = await app.request(`/api/v2/projects?${firstQuery}`);
    expect(first.status).toBe(200);
    const cursor = first.headers.get('X-Next-Cursor');
    expect(cursor).toBeTruthy();
    expect(cursor!.length).toBeLessThanOrEqual(4096);

    const secondQuery = new URLSearchParams({ projectId, limit: '1', cursor: cursor! });
    const second = await app.request(`/api/v2/projects?${secondQuery}`);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({
      error: 'The next page cursor would exceed the 4096-character limit',
    });
  });
});
