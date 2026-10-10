import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema';

const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: any };

describe('D1 Database Schema', () => {
  it('exports all expected multi-user tables', () => {
    expect(schema.organisations).toBeDefined();
    expect(schema.organisationMembers).toBeDefined();
    expect(schema.organisationInvites).toBeDefined();
    expect(schema.projects).toBeDefined();
    expect(schema.tasks).toBeDefined();
    expect(schema.taskUserGoals).toBeDefined();
    expect(schema.taskUpdates).toBeDefined();
  });

  it('retains legacy compatibility exports', () => {
    expect(schema.users).toBeDefined();
    expect(schema.goals).toBeDefined();
    expect(schema.epics).toBeDefined();
    expect(schema.projectUpdates).toBeDefined();
  });

  it('defines organisations columns correctly', () => {
    expect(schema.organisations.id).toBeDefined();
    expect(schema.organisations.name).toBeDefined();
    expect(schema.organisations.slug).toBeDefined();
    expect(schema.organisations.createdBy).toBeDefined();
    expect(schema.organisations.createdAt).toBeDefined();
    expect(schema.organisations.updatedAt).toBeDefined();
  });

  it('defines organisationMembers columns correctly', () => {
    expect(schema.organisationMembers.id).toBeDefined();
    expect(schema.organisationMembers.orgId).toBeDefined();
    expect(schema.organisationMembers.userId).toBeDefined();
    expect(schema.organisationMembers.role).toBeDefined();
  });

  it('defines organisationInvites columns correctly', () => {
    expect(schema.organisationInvites.id).toBeDefined();
    expect(schema.organisationInvites.orgId).toBeDefined();
    expect(schema.organisationInvites.email).toBeDefined();
    expect(schema.organisationInvites.role).toBeDefined();
    expect(schema.organisationInvites.token).toBeDefined();
    expect(schema.organisationInvites.invitedBy).toBeDefined();
    expect(schema.organisationInvites.expiresAt).toBeDefined();
  });

  it('defines projects columns correctly', () => {
    expect(schema.projects.id).toBeDefined();
    expect(schema.projects.orgId).toBeDefined();
    expect(schema.projects.key).toBeDefined();
    expect(schema.projects.name).toBeDefined();
    expect(schema.projects.description).toBeDefined();
    expect(schema.projects.leadUserId).toBeDefined();
    expect(schema.projects.isArchived).toBeDefined();
  });

  it('defines tasks columns correctly', () => {
    expect(schema.tasks.id).toBeDefined();
    expect(schema.tasks.projectId).toBeDefined();
    expect(schema.tasks.epicId).toBeDefined();
    expect(schema.tasks.reporterId).toBeDefined();
    expect(schema.tasks.assigneeId).toBeDefined();
    expect(schema.tasks.title).toBeDefined();
    expect(schema.tasks.reason).toBeDefined();
    expect(schema.tasks.status).toBeDefined();
    expect(schema.tasks.priority).toBeDefined();
    expect(schema.tasks.size).toBeDefined();
    expect(schema.tasks.notes).toBeDefined();
    expect(schema.tasks.statusLastChangedOn).toBeDefined();
    expect(schema.tasks.awaitUntil).toBeDefined();
    expect(schema.tasks.gmailThreadId).toBeDefined();
    expect(schema.tasks.isDeleted).toBeDefined();
  });

  it('defines taskUserGoals columns correctly', () => {
    expect(schema.taskUserGoals.taskId).toBeDefined();
    expect(schema.taskUserGoals.userId).toBeDefined();
    expect(schema.taskUserGoals.goalId).toBeDefined();
  });

  it('enables SQLite for the pinned Node 22 local bootstrap', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'dev-api.sh'), 'utf8');
    expect(bootstrap).toMatch(/^node --experimental-sqlite scripts\/upgrade-local-dedupe\.mjs "\$LOCAL_DB"$/m);
  });

  it('upgrades a persisted local database without replacing existing note history', () => {
    const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'timdo-local-dedupe-'));
    const localPersist = path.join(persist, '.wrangler', 'dev-test');
    fs.mkdirSync(localPersist, { recursive: true });
    const databasePath = path.join(localPersist, 'dev.sqlite');
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      CREATE TABLE TaskUpdates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        note TEXT NOT NULL
      );
      INSERT INTO TaskUpdates (id, task_id, author_id, note)
        VALUES ('note-1', 'task-1', 'author-1', 'Keep this history');
    `);
    oldDatabase.close();

    try {
      const upgradeScript = path.join(__dirname, '..', '..', 'scripts', 'upgrade-local-dedupe.mjs');
      const first = spawnSync(process.execPath, ['--experimental-sqlite', upgradeScript, databasePath], {
        encoding: 'utf8',
      });
      expect(first.status, first.stderr).toBe(0);
      const second = spawnSync(process.execPath, ['--experimental-sqlite', upgradeScript, databasePath], {
        encoding: 'utf8',
      });
      expect(second.status, second.stderr).toBe(0);

      const upgraded = new DatabaseSync(databasePath);
      try {
        expect(upgraded.prepare('SELECT dedupe_key FROM TaskUpdates WHERE id = ?').get('note-1')).toEqual({
          dedupe_key: null,
        });
        expect(
          upgraded
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_updates_dedupe_key'")
            .get()
        ).toEqual({ name: 'idx_task_updates_dedupe_key' });
        expect(
          upgraded.prepare('SELECT task_id, note FROM TaskUpdates WHERE id = ?').get('note-1')
        ).toEqual({ task_id: 'task-1', note: 'Keep this history' });
      } finally {
        upgraded.close();
      }
    } finally {
      fs.rmSync(persist, { recursive: true, force: true });
    }
  });
});
