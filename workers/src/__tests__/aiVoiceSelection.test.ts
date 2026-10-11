import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processVoiceCommand } from '../services/aiService';
import { loadVoiceContext } from '../services/voiceContextService';
import { boardScaleTaskId, CASEY_ID, seedBoardScale } from './fixtures/boardScaleFixture';
import { createTestDb } from './helpers/testDb';

const voiceState = vi.hoisted(() => ({
  transcript: 'Scale',
  events: [] as string[],
  invokeArgs: null as any,
  invokeResult: { summary: 'Nothing', changes: [] as unknown[] },
}));

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => {
          voiceState.events.push('transcription');
          return { text: voiceState.transcript };
        }),
      },
    },
  })),
}));

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async (args: any) => {
          voiceState.invokeArgs = args;
          return voiceState.invokeResult;
        }),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

const audio = () => new File(['fictional audio'], 'voice.webm', { type: 'audio/webm' });

describe('transcript-first bounded voice selection', () => {
  let db: any;
  let raw: any;
  let stats: ReturnType<typeof createTestDb>['stats'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    raw = testDb.raw;
    stats = testDb.stats;
    seedBoardScale(testDb.raw);
    voiceState.transcript = 'Scale';
    voiceState.events.length = 0;
    voiceState.invokeArgs = null;
    voiceState.invokeResult = { summary: 'Nothing', changes: [] };
  });

  it('uses single-word title matches but caps the sample and keeps true SQL aggregates', async () => {
    const context = await loadVoiceContext(db, CASEY_ID, 'Scale');

    expect(context.tasks).toHaveLength(150);
    expect(context.tasks.every((task: any) => task.project.startsWith('Scale task '))).toBe(true);
    expect((context as any).taskCounts).toMatchObject({
      total: 1000,
      byStatus: { do: 213, delay: 213, awaiting: 212, delegate: 212, done: 150 },
    });
    expect((context as any).taskCounts.byAssignee).toEqual(
      expect.arrayContaining([
        { assigneeId: CASEY_ID, count: 334 },
        { assigneeId: 'scale-user-jordan', count: 333 },
        { assigneeId: null, count: 333 },
      ])
    );
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
    expect(stats.statements.some((statement) => statement.sql.includes('Tasks_FTS'))).toBe(true);
  });

  it('transcribes before calling the real SQL context loader', async () => {
    const loadContext = vi.fn(async (transcript: string) => {
      voiceState.events.push('selection');
      return loadVoiceContext(db, CASEY_ID, transcript);
    });

    await processVoiceCommand({
      audioFile: audio(),
      groqApiKey: 'test-key',
      loadContext,
    } as any);

    expect(voiceState.events).toEqual(['transcription', 'selection']);
    expect(loadContext).toHaveBeenCalledWith('Scale');
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('tells the model the sample size, cap and true visible counts', async () => {
    const context = await loadVoiceContext(db, CASEY_ID, 'Scale');
    await processVoiceCommand({ audioFile: audio(), groqApiKey: 'test-key', context });

    const promptTasks = JSON.parse(voiceState.invokeArgs.projects);
    expect(promptTasks).toHaveLength(150);
    expect(voiceState.invokeArgs.taskSample).toContain('True visible task total: 1000');
    expect(voiceState.invokeArgs.taskSample).toContain(
      'Selected sample: 150 of 1000, with a cap of 150'
    );
    expect(voiceState.invokeArgs.taskSample).toContain(
      'Status totals across all visible tasks: Do 213'
    );
    expect(voiceState.invokeArgs.taskSample).toContain('Assignee totals across all visible tasks:');
    expect(voiceState.invokeArgs.taskSample).toContain('Do not guess a task id');
  });

  it('hydrates a selected task body before returning an echoed clipped note', async () => {
    const taskId = boardScaleTaskId(20);
    const context = await loadVoiceContext(db, CASEY_ID, taskId);
    const excerpt = context.promptFields!.get(taskId)!.notes!;
    const fullBody = raw.prepare('SELECT notes FROM Tasks WHERE id = ?').get(taskId).notes;
    expect(excerpt).toHaveLength(163);
    expect(fullBody).toContain('Full task body 20');
    expect(excerpt).not.toBe(fullBody);

    voiceState.transcript = taskId;
    voiceState.invokeResult = {
      summary: 'Updated the selected task',
      changes: [
        {
          type: 'update',
          projectId: taskId,
          after: {
            id: taskId,
            project: 'Scale task 0020',
            category: 'Scale 20',
            status: 'do',
            priority: 5,
            size: '***',
            notes: excerpt,
          },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: audio(),
      groqApiKey: 'test-key',
      context,
    });

    expect(
      JSON.parse(voiceState.invokeArgs.projects).find((task: any) => task.id === taskId).notes
    ).toBe(excerpt);
    expect(result.proposedChanges[0].before?.notes).toBe(fullBody);
    expect(result.proposedChanges[0].after?.notes).toBe(fullBody);
  });

  it.each([
    {
      field: 'notes' as const,
      proposedBody: (excerpt: string) => `${excerpt} Add a follow-up sentence.`,
    },
    {
      field: 'reason' as const,
      proposedBody: (excerpt: string) => `${excerpt.slice(0, -3)}. Add a follow-up sentence.`,
    },
  ])('rejects an edit derived from a clipped $field excerpt', async ({ field, proposedBody }) => {
    const taskId = boardScaleTaskId(20);
    if (field === 'reason') {
      raw
        .prepare('UPDATE Tasks SET reason = ? WHERE id = ?')
        .run(`Full task reason. ${'The fictional reason must remain intact. '.repeat(12)}`, taskId);
    }
    const context = await loadVoiceContext(db, CASEY_ID, taskId);
    const excerpt = context.promptFields!.get(taskId)![field]!;
    const fullBody = raw.prepare(`SELECT ${field} FROM Tasks WHERE id = ?`).get(taskId)[field];
    expect(fullBody).not.toBe(excerpt);

    voiceState.transcript = taskId;
    voiceState.invokeResult = {
      summary: `Updated the task ${field}`,
      changes: [
        {
          type: 'update',
          projectId: taskId,
          after: {
            id: taskId,
            project: 'Scale task 0020',
            category: 'Scale 20',
            status: 'done',
            priority: 5,
            size: '***',
            [field]: proposedBody(excerpt),
          },
        },
      ],
    };

    const result = await processVoiceCommand({ audioFile: audio(), groqApiKey: 'test-key', context });
    const proposal = result.proposedChanges[0];
    const message = `I couldn't safely change the task ${field} for "Scale task 0020" because the voice model only saw an excerpt, so I left the full text unchanged.`;

    expect(proposal.after?.[field]).toBe(fullBody);
    expect(proposal.before?.[field]).toBe(fullBody);
    expect(proposal.after?.status).toBe('done');
    expect((proposal as any).warnings).toContain(message);
    expect(result.warnings).toContain(message);
  });

  it.each(['notes', 'reason'] as const)(
    'keeps explicit %s replacements when the complete field was in the prompt',
    async (field) => {
      const taskId = boardScaleTaskId(21);
      const context = await loadVoiceContext(db, CASEY_ID, taskId);
      const replacement = `Explicit replacement for ${field}.`;
      expect(context.promptFields!.get(taskId)![field]).toBe(
        raw.prepare(`SELECT ${field} FROM Tasks WHERE id = ?`).get(taskId)[field]
      );

      voiceState.transcript = taskId;
      voiceState.invokeResult = {
        summary: `Updated the task ${field}`,
        changes: [
          {
            type: 'update',
            projectId: taskId,
            after: {
              id: taskId,
              project: 'Scale task 0021',
              category: 'Scale 21',
              status: 'do',
              priority: 2,
              size: '***',
              [field]: replacement,
            },
          },
        ],
      };

      const result = await processVoiceCommand({ audioFile: audio(), groqApiKey: 'test-key', context });

      expect(result.proposedChanges[0].after?.[field]).toBe(replacement);
      expect((result.proposedChanges[0] as any).warnings).not.toContain(
        expect.stringContaining('only saw an excerpt')
      );
    }
  );

  it('keeps a status-only edit and hydrates the full bodies without a body warning', async () => {
    const taskId = boardScaleTaskId(20);
    const context = await loadVoiceContext(db, CASEY_ID, taskId);
    const fullNotes = raw.prepare('SELECT notes FROM Tasks WHERE id = ?').get(taskId).notes;
    const fullReason = raw.prepare('SELECT reason FROM Tasks WHERE id = ?').get(taskId).reason;
    voiceState.transcript = taskId;
    voiceState.invokeResult = {
      summary: 'Marked the selected task done',
      changes: [
        {
          type: 'update',
          projectId: taskId,
          after: {
            id: taskId,
            project: 'Scale task 0020',
            category: 'Scale 20',
            status: 'done',
            priority: 5,
            size: '***',
          },
        },
      ],
    };

    const result = await processVoiceCommand({ audioFile: audio(), groqApiKey: 'test-key', context });
    const proposal = result.proposedChanges[0];

    expect(proposal.after?.status).toBe('done');
    expect(proposal.before?.notes).toBe(fullNotes);
    expect(proposal.before?.reason).toBe(fullReason);
    expect(result.warnings).toEqual([]);
  });

  it('checks a proposed source against a holder outside the bounded sample', async () => {
    const holderId = boardScaleTaskId(890);
    raw
      .prepare(
        `
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, label, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        'voice-source-holder',
        holderId,
        'org-md',
        'source',
        'forum.post',
        'outside-sample-source',
        null,
        CASEY_ID,
        '2026-10-09T09:00:00.000Z'
      );
    const transcript = 'whimsical garden request';
    const context = await loadVoiceContext(db, CASEY_ID, transcript);
    expect(context.tasks.some((task) => task.id === holderId)).toBe(false);

    voiceState.transcript = transcript;
    voiceState.invokeResult = {
      summary: 'Added a new task',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'Handle a fresh garden enquiry',
            category: 'Acme Solar',
            status: 'do',
            priority: 5,
            size: '***',
            refs: [{ ref: 'forum.post:outside-sample-source', role: 'source' }],
          },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: audio(),
      groqApiKey: 'test-key',
      context,
    });

    expect((result.proposedChanges[0] as any).refs).toEqual([
      expect.objectContaining({ ref: 'forum.post:outside-sample-source', role: 'link' }),
    ]);
    expect(result.warnings).toContain(
      'forum.post:outside-sample-source is already the source of "Scale task 0890", so it\'s added as a plain link instead.'
    );
  });

  it('warns and leaves unknown and out-of-sample targets unchanged', async () => {
    voiceState.transcript = 'whimsical blue-jam picnic';
    const context = await loadVoiceContext(db, CASEY_ID, voiceState.transcript);
    expect(context.tasks.some((task) => task.id === boardScaleTaskId(890))).toBe(false);
    stats.reset();
    voiceState.invokeResult = {
      summary: 'No listed task matched',
      changes: [
        {
          type: 'update',
          projectId: boardScaleTaskId(890),
          after: { project: 'Scale task 0890', status: 'done', priority: 5, size: '***' },
        },
        {
          type: 'delete',
          projectId: 'unknown-task-identifier',
          after: { project: 'Unknown task' },
        },
      ],
    };

    const result = await processVoiceCommand({
      audioFile: audio(),
      groqApiKey: 'test-key',
      context,
    });

    expect(result.proposedChanges).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.includes('selected task sample'))).toBe(true);
    expect(stats.queries).toBe(0);
  });
});
