import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { clearOnAccountChange } from '../../components/Providers';
import type { Project, ProjectSummary } from '../types/project.types';
import { useClaimTask } from './useTaskMutations';

jest.mock('../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { id: 'member-one', name: 'Member One' }, userId: 'member-one' }),
}));

const summary: ProjectSummary = {
  id: 'task-one',
  project: 'Fictional task one',
  status: 'do',
  priority: 5,
  size: '**',
  userId: 'member-two',
  assigneeId: null,
  assigneeName: null,
  isShared: true,
  canEdit: true,
  noteCount: 1,
  lastNoteAt: '2026-10-01T00:00:00.000Z',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const fullTask: Project = {
  ...summary,
  notes: 'Fictional full body',
  assigneeId: 'member-one',
  assigneeName: 'Member One',
  isMine: true,
};

function rawTask() {
  return {
    id: 'task-one',
    title: 'Fictional raw row',
    status: 'do',
    priority: 5,
    notes: 'Raw endpoint body',
  };
}

describe('assignment cache shapes', () => {
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.NEXT_PUBLIC_WORKER_API_BASE_URL;
  let queryClient: QueryClient;
  let resolveFetch: (response: Response) => void;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'https://worker.example.com/api/v2';
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(['board-summary', 'test-user-id', {}, '2026-09-27'], [summary]);
    queryClient.setQueryData(['board-full', 'test-user-id', 'task-one'], {
      ...summary,
      notes: 'Fictional full body',
    });
    queryClient.setQueryData(['tasks', 'list', {}], [rawTask()]);
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    queryClient.clear();
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = originalApiUrl;
    jest.clearAllMocks();
  });

  it('updates summary and detail views optimistically without spreading into raw Tasks rows', async () => {
    const { result } = renderHook(() => useClaimTask(), { wrapper });

    act(() => result.current.mutate('task-one'));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        queryClient.getQueryData<ProjectSummary[]>([
          'board-summary',
          'test-user-id',
          {},
          '2026-09-27',
        ])?.[0]
      ).toMatchObject({
        assigneeId: 'member-one',
        assigneeName: 'Member One',
        isMine: true,
      });
    });
    expect(
      queryClient.getQueryData<ProjectSummary[]>([
        'board-summary',
        'test-user-id',
        {},
        '2026-09-27',
      ])?.[0]
    ).not.toHaveProperty('notes');
    expect(queryClient.getQueryData(['tasks', 'list', {}])).toEqual([rawTask()]);

    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => fullTask,
      } as unknown as Response);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData<ProjectSummary[]>([
        'board-summary',
        'test-user-id',
        {},
        '2026-09-27',
      ])?.[0]
    ).not.toHaveProperty('notes');
    expect(
      queryClient.getQueryData<Project>(['board-full', 'test-user-id', 'task-one'])?.notes
    ).toBe('Fictional full body');
  });

  it('does not roll back an old account assignment into the next account cache', async () => {
    clearOnAccountChange(queryClient, undefined, 'test-user-id');
    const accountATask = { ...fullTask, assigneeId: null, assigneeName: null, isMine: false };
    queryClient.setQueryData<Project[]>(
      ['projects'],
      [{ ...accountATask, notes: 'Fictional body' }]
    );
    const { result } = renderHook(() => useClaimTask(), { wrapper });
    let mutation: Promise<Project>;

    act(() => {
      mutation = result.current.mutateAsync('task-one');
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      assigneeId: 'member-one',
      isMine: true,
    });

    clearOnAccountChange(queryClient, 'test-user-id', 'account-b');
    queryClient.setQueryData<Project[]>(
      ['projects'],
      [{ ...fullTask, assigneeId: 'member-one', assigneeName: 'Member One', isMine: false }]
    );

    await act(async () => {
      resolveFetch({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: 'Account A no longer has access' }),
      } as unknown as Response);
      await expect(mutation).rejects.toThrow('Account A no longer has access');
    });

    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      assigneeId: 'member-one',
      assigneeName: 'Member One',
      isMine: false,
    });
  });
});
