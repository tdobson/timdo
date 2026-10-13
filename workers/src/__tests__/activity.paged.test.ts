import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import activityApp from '../routes/activity';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type ActivityInput = Partial<{
  id: string | null;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  entityType: string;
  entityId: string;
  taskId: string | null;
  epicId: string | null;
  action: string;
  summary: string;
  createdAt: string | null;
}>;

function insertActivity(raw: any, input: ActivityInput = {}) {
  raw
    .prepare(
      `
    INSERT INTO ActivityLog (
      id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id,
      action, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      input.id === undefined ? `paged-${Math.random().toString(36).slice(2)}` : input.id,
      input.actorId === undefined ? TIM : input.actorId,
      input.orgId === undefined ? 'org-md' : input.orgId,
      input.projectId === undefined ? 'proj-acme-solar' : input.projectId,
      input.entityType ?? 'task',
      input.entityId ?? 'task-paged',
      input.taskId === undefined ? 'task-paged' : input.taskId,
      input.epicId ?? null,
      input.action ?? 'created',
      input.summary ?? 'Created paged fixture',
      input.createdAt === undefined ? '2026-10-11T12:00:00.000Z' : input.createdAt
    );
}

function createApi(db: any, userId = TIM) {
  const app = new Hono<any>();
  app.onError(onApiError);
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('userId', userId);
    c.set('userKind', 'human');
    c.set('authMethod', 'internal');
    await next();
  });
  app.route('/api/v2/activity', activityApp);
  return app;
}

async function requestActivity(app: Hono<any>, query = '', key: string | undefined = KEY) {
  return app.request(`/api/v2/activity${query ? `?${query}` : ''}`, { method: 'GET' }, {
    EVENT_CURSOR_KEY: key,
  } as any);
}

describe('paged activity compatibility', () => {
  let db: any;
  let raw: any;
  let stats: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedCollaboration(raw);
    app = createApi(db);
  });

  it('keeps the legacy array and fields available without a cursor key', async () => {
    insertActivity(raw, { id: 'legacy-entry', summary: 'Legacy summary' });
    const response = await requestActivity(app, 'limit=5', '');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=15');
    expect(await response.json()).toMatchObject([
      {
        id: 'legacy-entry',
        actorId: TIM,
        actorName: 'Casey Example',
        actorKind: 'human',
        orgId: 'org-md',
        projectId: 'proj-acme-solar',
        entityType: 'task',
        action: 'created',
        summary: 'Legacy summary',
        via: null,
        viaDetail: null,
      },
    ]);
  });

  it('paginates the unchanged array shape with stable timestamp/id order and a fixed sequence ceiling', async () => {
    insertActivity(raw, { id: 'same-z', createdAt: '2026-10-11T12:00:00.000Z' });
    insertActivity(raw, { id: 'same-y', createdAt: '2026-10-11T12:00:00.000Z' });
    insertActivity(raw, { id: 'older', createdAt: '2026-10-10T12:00:00.000Z' });
    insertActivity(raw, { id: 'null-z', createdAt: null });
    insertActivity(raw, { id: 'null-y', createdAt: null });
    insertActivity(raw, { id: 'unknown-action', action: 'unregistered_action' });
    insertActivity(raw, { id: null });
    insertActivity(raw, { id: '' });

    const first = await requestActivity(app, 'paged=1&limit=2');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const rows = await first.json<any[]>();
    expect(rows.map((row) => row.id)).toEqual(['same-z', 'same-y']);
    const firstCursor = first.headers.get('X-Next-Cursor');
    expect(firstCursor).toBeTruthy();
    expect(rows[0]).toHaveProperty('viaDetail');
    expect(rows.some((row) => Object.hasOwn(row, 'seq'))).toBe(false);

    insertActivity(raw, { id: 'newer-than-ceiling', createdAt: '2026-10-11T13:00:00.000Z' });
    const second = await requestActivity(
      app,
      `paged=1&limit=2&before=${encodeURIComponent(firstCursor!)}`
    );
    expect(second.status).toBe(200);
    expect((await second.json<any[]>()).map((row) => row.id)).toEqual(['older', 'null-z']);
    const secondCursor = second.headers.get('X-Next-Cursor');
    expect(secondCursor).toBeTruthy();

    const third = await requestActivity(
      app,
      `paged=1&limit=2&before=${encodeURIComponent(secondCursor!)}`
    );
    expect((await third.json<any[]>()).map((row) => row.id)).toEqual(['null-y']);
    expect(third.headers.get('X-Next-Cursor')).toBeNull();
  });

  it('requires the key only for paged mode and returns no-store errors with scoped opaque cursors', async () => {
    insertActivity(raw, { id: 'cursor-one' });
    insertActivity(raw, { id: 'cursor-two', createdAt: '2026-10-10T12:00:00.000Z' });
    const first = await requestActivity(app, 'paged=1&limit=1');
    const cursor = first.headers.get('X-Next-Cursor')!;
    expect(first.status).toBe(200);
    expect((await requestActivity(app, 'paged=1', '')).status).toBe(503);
    expect((await requestActivity(app, 'paged=1', '')).headers.get('Cache-Control')).toBe(
      'no-store'
    );
    expect((await requestActivity(app, 'paged=1', 'invalid-key')).status).toBe(503);
    expect(
      (await requestActivity(app, `paged=1&before=${encodeURIComponent(cursor)}&taskId=elsewhere`))
        .status
    ).toBe(409);
    expect(
      (
        await requestActivity(
          app,
          `paged=1&before=${encodeURIComponent(cursor)}`,
          'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'
        )
      ).status
    ).toBe(400);
    expect(
      (await requestActivity(app, `paged=1&before=${encodeURIComponent(cursor.slice(0, -1))}`))
        .status
    ).toBe(400);
    expect((await requestActivity(app, 'paged=1&limit=501')).status).toBe(400);
    expect((await requestActivity(app, 'paged=2')).status).toBe(400);
  });

  it('keeps the paged legacy query within bind limits at 500 rows and over 100 memberships', async () => {
    const insertWorkspace = raw.prepare(
      'INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES (?, ?, ?, ?, 0)'
    );
    const insertMembership = raw.prepare(
      "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')"
    );
    for (let index = 0; index < 105; index++) {
      const orgId = `paged-scale-org-${index}`;
      insertWorkspace.run(orgId, `Paged scale ${index}`, `paged-scale-${index}`, TIM);
      insertMembership.run(`paged-scale-member-${index}`, orgId, TIM);
    }
    for (let index = 0; index < 500; index++) {
      insertActivity(raw, {
        id: `paged-scale-event-${index}`,
        createdAt: `2026-10-11T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      });
    }
    stats.reset();
    const response = await requestActivity(app, 'paged=1&limit=500');
    expect(response.status).toBe(200);
    expect(await response.json<any[]>()).toHaveLength(500);
    expect(response.headers.get('X-Next-Cursor')).toBeNull();
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('uses a separate cursor domain from events and rejects membership changes', async () => {
    insertActivity(raw, { id: 'domain-one' });
    insertActivity(raw, { id: 'domain-two', createdAt: '2026-10-10T12:00:00.000Z' });
    const eventApp = new Hono<any>();
    const route = await import('../routes/events');
    eventApp.use('*', async (c, next) => {
      c.set('db', db);
      c.set('userId', TIM);
      c.set('userKind', 'human');
      await next();
    });
    eventApp.route('/api/v2/events', route.default);
    const eventFirst = await eventApp.request('/api/v2/events?limit=1', {}, {
      EVENT_CURSOR_KEY: KEY,
    } as any);
    const eventCursor = (await eventFirst.json<any>()).next;
    expect(
      (await requestActivity(app, `paged=1&before=${encodeURIComponent(eventCursor)}`)).status
    ).toBe(400);

    const first = await requestActivity(app, 'paged=1&limit=1');
    const cursor = first.headers.get('X-Next-Cursor')!;
    raw
      .prepare(
        `INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('membership-added', 'org-stranger', ?, 'member')`
      )
      .run(TIM);
    const stale = await requestActivity(app, `paged=1&before=${encodeURIComponent(cursor)}`);
    expect(stale.status).toBe(409);
    expect(stale.headers.get('Cache-Control')).toBe('no-store');
  });
});
