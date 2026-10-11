import { QueryClient } from '@tanstack/react-query';
import { invalidateAfterSharingChange } from './useSharingQueries';

describe('sharing visibility cache reset', () => {
  it('clears cached task summaries, details and notes when access is revoked', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const summaryKey = ['board-summary', 'account-a', {}, '2026-10-11'] as const;
    const task = {
      id: 'fictional-task',
      project: 'Fictional private task',
      status: 'do',
      priority: 5,
      size: '**',
      userId: 'account-a',
      isDeleted: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      noteCount: 1,
      lastNoteAt: '2026-10-10T00:00:00.000Z',
    };
    queryClient.setQueryData(summaryKey, [task]);
    queryClient.setQueryData(['board-full', 'account-a', task.id], {
      ...task,
      notes: 'Fictional private body',
    });
    queryClient.setQueryData(
      ['project-updates', task.id],
      [{ id: 'note-1', projectId: task.id, note: 'Fictional private note' }]
    );

    const summaryQuery = queryClient.getQueryCache().find({ queryKey: summaryKey });
    summaryQuery?.setState({
      status: 'error',
      error: new Error('You no longer have access to this workspace'),
      fetchStatus: 'idle',
    });
    expect(queryClient.getQueryData(summaryKey)).toEqual([task]);

    invalidateAfterSharingChange(queryClient, 'people');

    expect(queryClient.getQueryData(summaryKey)).toBeUndefined();
    expect(queryClient.getQueryData(['board-full', 'account-a', task.id])).toBeUndefined();
    expect(queryClient.getQueryData(['project-updates', task.id])).toBeUndefined();
    queryClient.clear();
  });
});
