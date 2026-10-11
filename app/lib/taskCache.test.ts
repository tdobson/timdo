import { QueryClient } from '@tanstack/react-query';
import type { Project, ProjectSummary } from '../types/project.types';
import {
  applyOptimisticTaskPatch,
  invalidateBoardCaches,
  patchTaskCaches,
  setTaskCacheAccount,
  updateTaskNoteSummary,
} from './taskCache';

const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'task-1',
  project: 'Task one',
  status: 'do',
  priority: 5,
  size: '**',
  userId: 'user-1',
  notes: 'The original full body stays intact',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const summary = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => {
  const { notes: _notes, ...base } = project(overrides);
  return { ...base, noteCount: 2, lastNoteAt: '2026-10-02T00:00:00.000Z', ...overrides };
};

describe('task cache helpers', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => queryClient.clear());

  it('patches task views in legacy arrays and page envelopes without spreading bodies into summaries', () => {
    const full = project();
    const short = summary();
    queryClient.setQueryData(['projects'], [full]);
    queryClient.setQueryData(['board-summary', 'user-1', 'all'], [short]);
    queryClient.setQueryData(['board-done-history', 'user-1'], {
      pages: [{ items: [short], nextCursor: 'next', total: 60 }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(['board-full', 'user-1', 'task-1'], full);

    patchTaskCaches(queryClient, project({ priority: 8, notes: 'Edited body' }));

    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      priority: 8,
      notes: 'Edited body',
    });
    const summaryData = queryClient.getQueryData<ProjectSummary[]>([
      'board-summary',
      'user-1',
      'all',
    ]);
    expect(summaryData?.[0]).toMatchObject({ priority: 8, noteCount: 2 });
    expect(summaryData?.[0]).not.toHaveProperty('notes');
    const history = queryClient.getQueryData<{
      pages: Array<{ items: ProjectSummary[]; nextCursor: string; total: number }>;
      pageParams: unknown[];
    }>(['board-done-history', 'user-1']);
    expect(history?.pages[0]).toMatchObject({ nextCursor: 'next', total: 60 });
    expect(history?.pages[0].items[0]).not.toHaveProperty('notes');
    expect(queryClient.getQueryData<Project>(['board-full', 'user-1', 'task-1'])?.notes).toBe(
      'Edited body'
    );
  });

  it('does not mistake raw Tasks rows, whose title field is not TaskView.project, for task views', () => {
    const rawRow = { id: 'task-1', title: 'Raw task', status: 'do', priority: 5, notes: 'body' };
    queryClient.setQueryData(['tasks', 'list', {}], [rawRow]);

    patchTaskCaches(queryClient, project({ priority: 9 }));

    expect(queryClient.getQueryData(['tasks', 'list', {}])).toEqual([rawRow]);
  });

  it('does not apply a stale account id to the next account cache', () => {
    setTaskCacheAccount(queryClient, 'account-a');
    queryClient.setQueryData(['projects'], [project({ priority: 4, goalId: 'goal-b' })]);
    setTaskCacheAccount(queryClient, 'account-b');

    patchTaskCaches(queryClient, project({ priority: 8, goalId: 'goal-a' }), 'account-a');

    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      priority: 4,
      goalId: 'goal-b',
    });
  });

  it('updates note counts and only derives a deleted latest timestamp from a loaded timeline', () => {
    const current = summary({ noteCount: 2, lastNoteAt: '2026-10-02T00:00:00.000Z' });
    queryClient.setQueryData(['board-summary', 'user-1'], [current]);
    const added = {
      id: 'update-3',
      projectId: 'task-1',
      userId: 'user-1',
      note: 'New note',
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    };

    updateTaskNoteSummary(queryClient, 'task-1', { type: 'added', update: added }, 'user-1');
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'user-1'])?.[0]
    ).toMatchObject({
      noteCount: 3,
      lastNoteAt: added.createdAt,
    });

    updateTaskNoteSummary(queryClient, 'task-1', { type: 'deleted' }, 'user-1');
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'user-1'])?.[0]
    ).toMatchObject({
      noteCount: 2,
      lastNoteAt: added.createdAt,
    });

    updateTaskNoteSummary(queryClient, 'task-1', { type: 'deleted', remaining: [] }, 'user-1');
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'user-1'])?.[0]
    ).toMatchObject({
      noteCount: 1,
      lastNoteAt: null,
    });
  });

  it('restarts older Done continuation after a relevant board mutation', async () => {
    const historyKey = ['board-done-history', 'user-1', {}, '2026-09-27'] as const;
    queryClient.setQueryData(historyKey, {
      pages: [{ items: [summary({ id: 'old-task', status: 'done' })], nextCursor: 'next' }],
      pageParams: [undefined, 'next'],
    });

    await invalidateBoardCaches(queryClient, 'user-1');

    expect(queryClient.getQueryData(historyKey)).toBeUndefined();
  });

  it('leaves read-only views unchanged during optimistic mutation', () => {
    const viewOnly = summary({ canEdit: false, priority: 5 });
    queryClient.setQueryData(['board-summary', 'user-1'], [viewOnly]);

    const rollback = applyOptimisticTaskPatch(queryClient, 'task-1', { priority: 9 }, 'user-1');
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'user-1'])?.[0].priority
    ).toBe(5);
    rollback();
    expect(
      queryClient.getQueryData<ProjectSummary[]>(['board-summary', 'user-1'])?.[0].priority
    ).toBe(5);
  });
});
