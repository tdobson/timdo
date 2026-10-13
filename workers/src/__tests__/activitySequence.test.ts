import { describe, expect, it } from 'vitest';
import { activityLog } from '../db/schema';
import {
  applyMigration,
  createTestDb,
  PENDING_MIGRATIONS,
  seedCollaboration,
  TIM,
} from './helpers/testDb';

const MAX_SAFE_INTEGER = 9007199254740991;
const SEQUENCE_MIGRATION = '0011_activity_sequence.sql';
const LEGACY_ACTIVITY_COLUMNS =
  'id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id, action, summary, changes, via, via_detail, created_at';
const INSERT_ACTIVITY = `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function createPreSequenceDb() {
  const { raw, db } = createTestDb({
    migrations: PENDING_MIGRATIONS.filter((migration) => migration !== SEQUENCE_MIGRATION),
  });
  seedCollaboration(raw);
  return { raw, db };
}

function createSequencedDb() {
  const { raw, db } = createTestDb();
  seedCollaboration(raw);
  return { raw, db };
}

function insertLegacyEvent(raw: any, id: string | null, createdAt: string | null) {
  raw
    .prepare(INSERT_ACTIVITY)
    .run(
      id,
      TIM,
      'org-md',
      'proj-acme-solar',
      'task',
      `task-${id}`,
      `task-${id}`,
      null,
      'created',
      `Fixture event ${id}`,
      '{"status":{"from":null,"to":"do"}}',
      'web',
      'fixture-detail',
      createdAt
    );
}

function insertRawEvent(
  raw: any,
  id: string,
  seq?: number | null,
  { orgId = 'org-md', projectId = 'proj-acme-solar' } = {}
) {
  const seqColumn = seq === undefined ? '' : ', seq';
  const seqValue = seq === undefined ? '' : ', ?';
  raw
    .prepare(
      `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS}${seqColumn})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${seqValue})`
    )
    .run(
      id,
      TIM,
      orgId,
      projectId,
      'task',
      `task-${id}`,
      `task-${id}`,
      null,
      'created',
      `Fixture event ${id}`,
      null,
      'web',
      null,
      '2026-10-11T12:00:00.000Z',
      ...(seq === undefined ? [] : [seq])
    );
}

describe('activity sequence migration', () => {
  it('backfills positive sequences in null-first timestamp and ID order without changing old columns', () => {
    const { raw } = createPreSequenceDb();
    insertLegacyEvent(raw, 'tie-z', '2026-10-10T10:00:00.000Z');
    insertLegacyEvent(raw, 'later', '2026-10-11T10:00:00.000Z');
    insertLegacyEvent(raw, 'null-z', null);
    insertLegacyEvent(raw, 'tie-a', '2026-10-10T10:00:00.000Z');
    insertLegacyEvent(raw, 'null-a', null);

    const before = raw
      .prepare(`SELECT ${LEGACY_ACTIVITY_COLUMNS} FROM ActivityLog ORDER BY id`)
      .all();
    applyMigration(raw, SEQUENCE_MIGRATION);

    const after = raw
      .prepare(`SELECT ${LEGACY_ACTIVITY_COLUMNS}, seq FROM ActivityLog ORDER BY id`)
      .all();
    expect(after.map(({ seq: _seq, ...event }: any) => event)).toEqual(before);
    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'null-a', seq: 1 },
      { id: 'null-z', seq: 2 },
      { id: 'tie-a', seq: 3 },
      { id: 'tie-z', seq: 4 },
      { id: 'later', seq: 5 },
    ]);
    expect(raw.prepare('SELECT id, last_seq FROM ActivitySequence').all()).toEqual([
      { id: 1, last_seq: 5 },
    ]);
  });

  it('backfills tied legacy null IDs by row identity without changing existing columns', () => {
    const { raw } = createPreSequenceDb();
    insertLegacyEvent(raw, 'tie-z', '2026-10-10T10:00:00.000Z');
    insertLegacyEvent(raw, null, '2026-10-10T10:00:00.000Z');
    insertLegacyEvent(raw, null, '2026-10-10T10:00:00.000Z');
    insertLegacyEvent(raw, null, null);
    insertLegacyEvent(raw, 'tie-a', '2026-10-10T10:00:00.000Z');
    const before = raw
      .prepare(
        `SELECT rowid AS rowNumber, ${LEGACY_ACTIVITY_COLUMNS} FROM ActivityLog ORDER BY rowid`
      )
      .all();

    applyMigration(raw, SEQUENCE_MIGRATION);

    expect(
      raw
        .prepare(
          `SELECT rowid AS rowNumber, ${LEGACY_ACTIVITY_COLUMNS} FROM ActivityLog ORDER BY rowid`
        )
        .all()
    ).toEqual(before);
    expect(
      raw.prepare('SELECT rowid AS rowNumber, id, seq FROM ActivityLog ORDER BY seq').all()
    ).toEqual([
      { rowNumber: 4, id: null, seq: 1 },
      { rowNumber: 2, id: null, seq: 2 },
      { rowNumber: 3, id: null, seq: 3 },
      { rowNumber: 5, id: 'tie-a', seq: 4 },
      { rowNumber: 1, id: 'tie-z', seq: 5 },
    ]);
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 5,
    });
  });

  it('initialises an empty log counter at zero', () => {
    const { raw } = createPreSequenceDb();
    applyMigration(raw, SEQUENCE_MIGRATION);

    expect(raw.prepare('SELECT id, last_seq FROM ActivitySequence').all()).toEqual([
      { id: 1, last_seq: 0 },
    ]);
  });

  it('creates a unique global sequence index and an organisation sequence index', () => {
    const { raw } = createSequencedDb();
    const indexes = raw.prepare("PRAGMA index_list('ActivityLog')").all();

    expect(
      indexes.find((index: any) => index.name === 'idx_activity_log_seq_unique')
    ).toMatchObject({
      unique: 1,
    });
    expect(indexes.find((index: any) => index.name === 'idx_activity_log_org_seq')).toMatchObject({
      unique: 0,
    });
    expect(
      raw
        .prepare('PRAGMA index_info(idx_activity_log_org_seq)')
        .all()
        .map((column: any) => column.name)
    ).toEqual(['org_id', 'seq']);
  });

  it('enforces one fixed counter row and the JavaScript safe-integer range', () => {
    const { raw } = createSequencedDb();

    expect(() =>
      raw.prepare('INSERT INTO ActivitySequence (id, last_seq) VALUES (2, 0)').run()
    ).toThrow();
    expect(() =>
      raw.prepare('UPDATE ActivitySequence SET last_seq = ? WHERE id = 1').run(MAX_SAFE_INTEGER + 1)
    ).toThrow();
  });
});

describe('activity sequence allocation', () => {
  it('allocates sequential values to ORM and raw conditional audit inserts', async () => {
    const { db, raw } = createSequencedDb();

    await db.insert(activityLog).values({
      id: 'orm-event',
      actorId: TIM,
      orgId: 'org-md',
      projectId: 'proj-acme-solar',
      entityType: 'task',
      entityId: 'task-orm-event',
      taskId: 'task-orm-event',
      action: 'created',
      summary: 'Fixture ORM event',
      createdAt: '2026-10-11T12:00:00.000Z',
    });
    raw.prepare("UPDATE Users SET name = 'Fixture Reader' WHERE id = ?").run(TIM);
    raw
      .prepare(
        `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS})
        SELECT ?, ?, ?, NULL, 'member', ?, NULL, NULL, 'bot_renamed', ?, NULL, 'token', NULL, ?
        WHERE changes() = 1`
      )
      .run(
        'raw-audit-event',
        TIM,
        'org-md',
        'bot|fixture-001',
        'Fixture bot rename',
        '2026-10-11T12:01:00.000Z'
      );

    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'orm-event', seq: 1 },
      { id: 'raw-audit-event', seq: 2 },
    ]);
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 2,
    });
  });

  it('keeps changes()-conditional bot audits empty after a no-op mutation', () => {
    const { raw } = createSequencedDb();
    raw.prepare("UPDATE Users SET name = 'Fixture Reader' WHERE id = ?").run(TIM);
    raw
      .prepare(
        `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS})
        SELECT ?, ?, ?, NULL, 'member', ?, NULL, NULL, 'bot_renamed', ?, NULL, 'token', NULL, ?
        WHERE changes() = 1`
      )
      .run(
        'raw-audit-event',
        TIM,
        'org-md',
        'bot|fixture-001',
        'Fixture bot rename',
        '2026-10-11T12:00:00.000Z'
      );

    raw.prepare("UPDATE Users SET name = 'Fixture Observer' WHERE id = 'missing-user'").run();
    raw
      .prepare(
        `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS})
        SELECT ?, ?, ?, NULL, 'member', ?, NULL, NULL, 'bot_renamed', ?, NULL, 'token', NULL, ?
        WHERE changes() = 1`
      )
      .run(
        'no-op-audit-event',
        TIM,
        'org-md',
        'bot|fixture-001',
        'This no-op audit must not be written',
        '2026-10-11T12:01:00.000Z'
      );

    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'raw-audit-event', seq: 1 },
    ]);
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 1,
    });
  });

  it('allocates sequences by inserted row identity even when an ActivityLog id is null', () => {
    const { raw } = createSequencedDb();
    raw
      .prepare(
        `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS})
        VALUES (NULL, NULL, 'org-md', NULL, 'task', 'task-null-id', NULL, NULL, 'created',
          'Fixture null-id event', NULL, NULL, NULL, '2026-10-11T12:00:00.000Z')`
      )
      .run();

    expect(raw.prepare('SELECT id, seq FROM ActivityLog').all()).toEqual([{ id: null, seq: 1 }]);
  });

  it('allocates one consecutive value per row in a multi-row insert without changing changes()', () => {
    const { raw } = createSequencedDb();
    raw
      .prepare(
        `INSERT INTO ActivityLog (${LEGACY_ACTIVITY_COLUMNS}) VALUES
        ('multi-a', NULL, 'org-md', NULL, 'task', 'task-multi-a', NULL, NULL, 'created', 'Fixture A', NULL, NULL, NULL, '2026-10-11T12:00:00.000Z'),
        ('multi-b', NULL, 'org-md', NULL, 'task', 'task-multi-b', NULL, NULL, 'created', 'Fixture B', NULL, NULL, NULL, '2026-10-11T12:01:00.000Z'),
        ('multi-c', NULL, 'org-md', NULL, 'task', 'task-multi-c', NULL, NULL, 'created', 'Fixture C', NULL, NULL, NULL, '2026-10-11T12:02:00.000Z')`
      )
      .run();

    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'multi-a', seq: 1 },
      { id: 'multi-b', seq: 2 },
      { id: 'multi-c', seq: 3 },
    ]);
    expect(raw.prepare('SELECT changes() AS changed_rows').get()).toEqual({ changed_rows: 3 });
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 3,
    });
  });

  it('rejects nonzero and null overrides while accepting zero as the insert sentinel', () => {
    const { raw } = createSequencedDb();

    insertRawEvent(raw, 'zero-sentinel', 0);
    expect(() => insertRawEvent(raw, 'nonzero-override', 41)).toThrow();
    expect(() => insertRawEvent(raw, 'null-override', null)).toThrow();

    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'zero-sentinel', seq: 1 },
    ]);
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 1,
    });
  });

  it('keeps allocated sequence values immutable', () => {
    const { raw } = createSequencedDb();
    insertRawEvent(raw, 'immutable-event');

    expect(() =>
      raw.prepare('UPDATE ActivityLog SET seq = 2 WHERE id = ?').run('immutable-event')
    ).toThrow();
    expect(() =>
      raw.prepare('UPDATE ActivityLog SET seq = 0 WHERE id = ?').run('immutable-event')
    ).toThrow();
    raw.prepare('UPDATE ActivityLog SET seq = 1 WHERE id = ?').run('immutable-event');

    expect(raw.prepare('SELECT id, seq FROM ActivityLog').all()).toEqual([
      { id: 'immutable-event', seq: 1 },
    ]);
  });

  it('rolls the counter increment back when assigning an allocated sequence fails', () => {
    const { raw } = createSequencedDb();
    raw.exec(`CREATE TRIGGER reject_fixture_sequence_assignment
      BEFORE UPDATE OF seq ON ActivityLog
      WHEN OLD.seq = 0
      BEGIN
        SELECT RAISE(ABORT, 'fixture allocation failure');
      END;`);

    expect(() => insertRawEvent(raw, 'allocation-failure-event')).toThrow();
    expect(raw.prepare('SELECT count(*) AS count FROM ActivityLog').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 0,
    });
  });

  it('rolls an allocated event and counter increment back when a later batch statement fails', async () => {
    const { db, raw } = createSequencedDb();
    const first = db.insert(activityLog).values({
      id: 'batch-event',
      actorId: TIM,
      orgId: 'org-md',
      entityType: 'task',
      entityId: 'task-batch-event',
      action: 'created',
      summary: 'Fixture batch event',
    });
    const laterFailure = db.insert(activityLog).values({
      id: 'batch-event',
      actorId: TIM,
      orgId: 'org-md',
      entityType: 'task',
      entityId: 'task-batch-event',
      action: 'created',
      summary: 'Duplicate fixture event',
    });

    await expect(db.batch([first, laterFailure])).rejects.toThrow();

    expect(raw.prepare('SELECT count(*) AS count FROM ActivityLog').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 0,
    });
  });

  it('does not allocate when the counter is missing or exhausted', () => {
    const { raw } = createSequencedDb();
    raw.prepare('DELETE FROM ActivitySequence WHERE id = 1').run();
    expect(() => insertRawEvent(raw, 'missing-counter-event')).toThrow();
    expect(raw.prepare('SELECT count(*) AS count FROM ActivityLog').get()).toEqual({ count: 0 });

    raw.prepare('INSERT INTO ActivitySequence (id, last_seq) VALUES (1, ?)').run(MAX_SAFE_INTEGER);
    expect(() => insertRawEvent(raw, 'exhausted-counter-event')).toThrow();
    expect(raw.prepare('SELECT count(*) AS count FROM ActivityLog').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: MAX_SAFE_INTEGER,
    });
  });

  it('does not reuse values after deleting the highest event or cascading a workspace deletion', () => {
    const { raw } = createSequencedDb();
    insertRawEvent(raw, 'retained-event');
    insertRawEvent(raw, 'deleted-highest-event');
    raw.prepare('DELETE FROM ActivityLog WHERE id = ?').run('deleted-highest-event');
    insertRawEvent(raw, 'after-row-delete');

    raw.prepare('DELETE FROM Organisations WHERE id = ?').run('org-md');
    insertRawEvent(raw, 'after-workspace-cascade', undefined, {
      orgId: 'org-tim',
      projectId: 'proj-personal',
    });

    expect(raw.prepare('SELECT id, seq FROM ActivityLog ORDER BY seq').all()).toEqual([
      { id: 'after-workspace-cascade', seq: 4 },
    ]);
    expect(raw.prepare('SELECT last_seq FROM ActivitySequence WHERE id = 1').get()).toEqual({
      last_seq: 4,
    });
  });
});
