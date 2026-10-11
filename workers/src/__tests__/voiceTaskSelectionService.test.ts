import { beforeEach, describe, expect, it } from 'vitest';
import { selectVoiceTaskIds, VOICE_TASK_SAMPLE_CAP } from '../services/voiceTaskSelectionService';
import {
  boardScaleTaskId,
  CASEY_ID,
  JORDAN_ID,
  seedBoardScale,
} from './fixtures/boardScaleFixture';
import { createTestDb } from './helpers/testDb';

describe('bounded SQL voice task selection', () => {
  let db: any;
  let raw: any;
  let stats: ReturnType<typeof createTestDb>['stats'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    raw = testDb.raw;
    stats = testDb.stats;
    seedBoardScale(raw);
  });

  it('finds an exact ref on an old Done task outside the open-task tiers', async () => {
    const oldDoneId = boardScaleTaskId(890);
    raw
      .prepare(
        `
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, label, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        'voice-old-done-ref',
        oldDoneId,
        'org-md',
        'link',
        'forum.post',
        'old-done-reference',
        null,
        CASEY_ID,
        '2026-10-09T09:00:00.000Z'
      );

    const selection = await selectVoiceTaskIds(db, CASEY_ID, 'forum.post:old-done-reference');

    expect(selection.taskIds[0]).toBe(oldDoneId);
    expect(selection.taskIds).toContain(oldDoneId);
    expect(selection.taskIds.length).toBeLessThanOrEqual(VOICE_TASK_SAMPLE_CAP);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('limits every transcript and fallback candidate query and the final distinct sample', async () => {
    const selection = await selectVoiceTaskIds(db, CASEY_ID, 'Scale');

    expect(selection.taskIds).toHaveLength(VOICE_TASK_SAMPLE_CAP);
    expect(new Set(selection.taskIds).size).toBe(VOICE_TASK_SAMPLE_CAP);
    expect(stats.statements.length).toBeGreaterThan(0);
    expect(
      stats.statements.every((statement) => statement.rowsReturned <= VOICE_TASK_SAMPLE_CAP)
    ).toBe(true);
    expect(stats.statements.every((statement) => /limit\s+\?/i.test(statement.sql))).toBe(true);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it("adds other recently updated open tasks after the caller's own Do tasks", async () => {
    const selection = await selectVoiceTaskIds(
      db,
      JORDAN_ID,
      '',
      new Date('2026-10-11T12:00:00.000Z')
    );

    expect(selection.taskIds).toContain(boardScaleTaskId(0));
    expect(selection.taskIds).toContain(boardScaleTaskId(1));
    expect(selection.taskIds.length).toBeLessThanOrEqual(VOICE_TASK_SAMPLE_CAP);
  });

  it('warns when transcript title and id terms are capped', async () => {
    const transcript = Array.from({ length: 40 }, (_, index) => `distinctiveword${index}`).join(
      ' '
    );

    const selection = await selectVoiceTaskIds(db, CASEY_ID, transcript);

    expect(selection.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('first 16 distinctive words'),
        expect.stringContaining('first 12 task id-like strings'),
      ])
    );
    expect(selection.taskIds.length).toBeLessThanOrEqual(VOICE_TASK_SAMPLE_CAP);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });
});
