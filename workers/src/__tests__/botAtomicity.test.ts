import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import botsApp from '../routes/bots';
import { createTestDb, seedCollaboration } from './helpers/testDb';

const env = {
  INTERNAL_API_SECRET: 'fixture-owner-secret',
  AUTH0_DOMAIN: 'fixture.invalid',
  AUTH0_AUDIENCE: 'fixture-api',
};

function synchronizeBatches(db: any, parties = 2) {
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch') {
        return async (...args: any[]) => {
          arrivals += 1;
          if (arrivals === parties) {
            releaseBarrier();
          }
          await barrier;
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function interleaveDatabase(
  db: any,
  hooks: {
    beforeFirstBatch?: () => Promise<void>;
    afterFirstBatch?: () => Promise<void>;
    afterSelectGet?: (sql: string, result: any) => Promise<boolean>;
  }
) {
  let batchHandled = false;
  let selectHandled = false;

  const wrapQuery = (builder: any): any =>
    new Proxy(builder, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'get' && typeof value === 'function') {
          return async (...args: any[]) => {
            const sql = target.toSQL().sql;
            const result = await value.apply(target, args);
            if (
              !selectHandled &&
              hooks.afterSelectGet &&
              (await hooks.afterSelectGet(sql, result))
            ) {
              selectHandled = true;
            }
            return result;
          };
        }
        if (typeof value === 'function') {
          return (...args: any[]) => {
            const next = value.apply(target, args);
            return next && typeof next === 'object' ? wrapQuery(next) : next;
          };
        }
        return value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      if (property === 'select') {
        const select = Reflect.get(target, property, target);
        return (...args: any[]) => wrapQuery(select.apply(target, args));
      }
      if (property === 'batch') {
        const batch = Reflect.get(target, property, target);
        return async (...args: any[]) => {
          if (batchHandled) {
            return batch.apply(target, args);
          }
          batchHandled = true;
          await hooks.beforeFirstBatch?.();
          const result = await batch.apply(target, args);
          await hooks.afterFirstBatch?.();
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('bot lifecycle audit atomicity', () => {
  let db: any;
  let raw: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/organisations/*', combinedAuthMiddleware);
    app.route('/organisations', botsApp);
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': env.INTERNAL_API_SECRET,
          'X-Timdo-User': 'casey@example.test',
          ...init.headers,
        },
      },
      env
    );

  it('audits only the disable call that wins a concurrent equal-time transition', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
    db = synchronizeBatches(db);

    try {
      const responses = await Promise.all([
        request(`/organisations/org-md/bots/${bot.id}`, { method: 'DELETE' }),
        request(`/organisations/org-md/bots/${bot.id}`, { method: 'DELETE' }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([204, 204]);
      expect(
        raw
          .prepare(
            "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_disabled'"
          )
          .get(bot.id).count
      ).toBe(1);
      expect(
        raw.prepare('SELECT disabled_at FROM Users WHERE id = ?').get(bot.id).disabled_at
      ).toBe('2026-10-11T12:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a conflicting concurrent rename after both requests have read the old name', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    db = synchronizeBatches(db);

    const responses = await Promise.all([
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Reader' }),
      }),
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Observer' }),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const resultBodies = (await Promise.all(responses.map((response) => response.json()))) as any[];
    const updated = resultBodies.find((body: any) => body.name);
    const conflict = resultBodies.find((body: any) => body.error);
    expect(['Fixture Reader', 'Fixture Observer']).toContain(updated.name);
    expect(conflict).toEqual({ error: 'Bot was changed by another request' });
    const renameEvents = raw
      .prepare("SELECT changes FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'")
      .all(bot.id);
    expect(renameEvents).toHaveLength(1);
    expect(JSON.parse(renameEvents[0].changes)).toEqual({
      name: { from: 'Fixture Monitor', to: updated.name },
    });
  });

  it('does not apply a role from a conflicting combined rename and role change', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    db = synchronizeBatches(db);

    const responses = await Promise.all([
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Reader' }),
      }),
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Observer', role: 'viewer' }),
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as any[];
    const updated = bodies.find((body: any) => body.name);
    const conflict = bodies.find((body: any) => body.error);
    const stored = raw.prepare('SELECT name FROM Users WHERE id = ?').get(bot.id);
    const membership = raw
      .prepare('SELECT role FROM OrganisationMembers WHERE user_id = ? AND org_id = ?')
      .get(bot.id, 'org-md');
    expect(stored.name).toBe(updated.name);
    expect(membership.role).toBe(updated.role);
    expect(conflict).toEqual({ error: 'Bot was changed by another request' });
    const renameEvents = raw
      .prepare("SELECT changes FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'")
      .all(bot.id);
    expect(renameEvents).toHaveLength(1);
    expect(JSON.parse(renameEvents[0].changes)).toEqual({
      name: { from: 'Fixture Monitor', to: updated.name },
    });
    const roleEvents = raw
      .prepare(
        "SELECT changes FROM ActivityLog WHERE entity_id = ? AND action = 'bot_role_changed'"
      )
      .all(bot.id);
    expect(roleEvents).toHaveLength(updated.role === 'viewer' ? 1 : 0);
    if (roleEvents.length) {
      expect(JSON.parse(roleEvents[0].changes)).toEqual({ role: { from: 'member', to: 'viewer' } });
    }
  });

  it('deduplicates identical concurrent rename and role requests', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    db = synchronizeBatches(db);

    const responses = await Promise.all([
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Reader', role: 'viewer' }),
      }),
      request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Reader', role: 'viewer' }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'"
        )
        .get(bot.id).count
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_role_changed'"
        )
        .get(bot.id).count
    ).toBe(1);
    expect(
      JSON.parse(
        raw
          .prepare("SELECT changes FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'")
          .get(bot.id).changes
      )
    ).toEqual({
      name: { from: 'Fixture Monitor', to: 'Fixture Reader' },
    });
    expect(
      JSON.parse(
        raw
          .prepare(
            "SELECT changes FROM ActivityLog WHERE entity_id = ? AND action = 'bot_role_changed'"
          )
          .get(bot.id).changes
      )
    ).toEqual({
      role: { from: 'member', to: 'viewer' },
    });
    expect(raw.prepare('SELECT name FROM Users WHERE id = ?').get(bot.id).name).toBe(
      'Fixture Reader'
    );
    expect(
      raw.prepare('SELECT role FROM OrganisationMembers WHERE user_id = ?').get(bot.id).role
    ).toBe('viewer');
    const changes = raw
      .prepare(
        "SELECT action, changes FROM ActivityLog WHERE entity_id = ? AND action IN ('bot_renamed', 'bot_role_changed') ORDER BY action"
      )
      .all(bot.id);
    expect(
      JSON.parse(changes.find((event: any) => event.action === 'bot_renamed').changes)
    ).toEqual({
      name: { from: 'Fixture Monitor', to: 'Fixture Reader' },
    });
    expect(
      JSON.parse(changes.find((event: any) => event.action === 'bot_role_changed').changes)
    ).toEqual({
      role: { from: 'member', to: 'viewer' },
    });
  });

  it('does not combine a stale bot name and membership role from different reads', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    const baseDb = db;
    const writerStatuses: number[] = [];
    const updateUsingDb = async (database: any, name: string, role: 'member' | 'viewer') => {
      const previousDb = db;
      db = database;
      try {
        const response = await request(`/organisations/org-md/bots/${bot.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, role }),
        });
        writerStatuses.push(response.status);
        return response;
      } finally {
        db = previousDb;
      }
    };

    db = interleaveDatabase(baseDb, {
      beforeFirstBatch: async () => {
        await updateUsingDb(baseDb, 'Fixture Other', 'viewer');
      },
      afterFirstBatch: async () => {
        await updateUsingDb(baseDb, 'Fixture Target', 'member');
      },
      afterSelectGet: async (_sql, result) => {
        if (result?.name !== 'Fixture Target') {
          return false;
        }
        expect(raw.prepare('SELECT name FROM Users WHERE id = ?').get(bot.id).name).toBe(
          'Fixture Target'
        );
        expect(
          raw.prepare('SELECT role FROM OrganisationMembers WHERE user_id = ?').get(bot.id).role
        ).toBe('member');
        await updateUsingDb(baseDb, 'Fixture Other', 'viewer');
        return true;
      },
    });

    const response = await request(`/organisations/org-md/bots/${bot.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Fixture Target', role: 'viewer' }),
    });

    expect(writerStatuses).toEqual([200, 200, 200]);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Bot was changed by another request' });
    expect(raw.prepare('SELECT name FROM Users WHERE id = ?').get(bot.id).name).toBe(
      'Fixture Other'
    );
    expect(
      raw.prepare('SELECT role FROM OrganisationMembers WHERE user_id = ?').get(bot.id).role
    ).toBe('viewer');
  });

  it('returns a committed update view when disable finishes before the response read', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    const baseDb = db;
    let disableStatus: number | undefined;
    db = interleaveDatabase(baseDb, {
      afterFirstBatch: async () => {
        const previousDb = db;
        db = baseDb;
        try {
          const disabled = await request(`/organisations/org-md/bots/${bot.id}`, {
            method: 'DELETE',
          });
          disableStatus = disabled.status;
        } finally {
          db = previousDb;
        }
      },
    });

    const updated = await request(`/organisations/org-md/bots/${bot.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Fixture Reader' }),
    });

    expect(disableStatus).toBe(204);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      name: 'Fixture Reader',
      role: null,
      disabledAt: expect.any(String),
      tokens: [],
    });
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'"
        )
        .get(bot.id).count
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_disabled'"
        )
        .get(bot.id).count
    ).toBe(1);

    const previousDb = db;
    db = baseDb;
    let disabledFirst: Response;
    try {
      disabledFirst = await request(`/organisations/org-md/bots/${bot.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Fixture Observer' }),
      });
    } finally {
      db = previousDb;
    }
    expect(disabledFirst!.status).toBe(403);
    expect(await disabledFirst!.json()).toEqual({ error: 'Disabled bots cannot be changed' });
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_renamed'"
        )
        .get(bot.id).count
    ).toBe(1);
  });

  it('rolls back a combined rename and role change when its lifecycle audit fails', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    raw.exec(
      `CREATE TRIGGER reject_bot_role_audit BEFORE INSERT ON ActivityLog WHEN NEW.action = 'bot_role_changed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`
    );
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(`/organisations/org-md/bots/${bot.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Fixture Reader', role: 'viewer' }),
    });

    logSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(raw.prepare('SELECT name FROM Users WHERE id = ?').get(bot.id).name).toBe(
      'Fixture Monitor'
    );
    expect(
      raw.prepare('SELECT role FROM OrganisationMembers WHERE user_id = ?').get(bot.id).role
    ).toBe('member');
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action IN ('bot_renamed', 'bot_role_changed')"
        )
        .get(bot.id).count
    ).toBe(0);
  });

  it('rolls back disable, token revocation and membership removal when strict audit fails', async () => {
    const created = await request('/organisations/org-md/bots', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fixture Monitor' }),
    });
    const { bot } = (await created.json()) as any;
    raw.exec(
      `CREATE TRIGGER reject_disable_audit BEFORE INSERT ON ActivityLog WHEN NEW.action = 'bot_disabled' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`
    );
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(`/organisations/org-md/bots/${bot.id}`, { method: 'DELETE' });

    logSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(
      raw.prepare('SELECT disabled_at FROM Users WHERE id = ?').get(bot.id).disabled_at
    ).toBeNull();
    expect(
      raw.prepare('SELECT count(*) as count FROM OrganisationMembers WHERE user_id = ?').get(bot.id)
        .count
    ).toBe(1);
    expect(
      raw
        .prepare('SELECT count(*) as count FROM ApiTokens WHERE user_id = ? AND revoked_at IS NULL')
        .get(bot.id).count
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT count(*) as count FROM ActivityLog WHERE entity_id = ? AND action = 'bot_disabled'"
        )
        .get(bot.id).count
    ).toBe(0);
  });
});
