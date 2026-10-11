import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import { clearOnAccountChange } from '../../components/Providers';
import { mergeProjects } from '../lib/apiClient';
import type { Project } from '../types/project.types';
import { useMergeProjects, useUpdateProject } from './useProjectMutations';

jest.mock('../lib/apiClient', () => ({
  ...jest.requireActual('../lib/apiClient'),
  mergeProjects: jest.fn(),
}));

jest.mock('@mantine/notifications', () => ({
  notifications: {
    show: jest.fn(),
  },
}));

describe('useMergeProjects', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('calls mergeProjects and invalidates queries on success', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    (mergeProjects as jest.Mock).mockResolvedValueOnce({
      id: 'target-1',
      project: 'Target Project',
    });

    const { result } = renderHook(() => useMergeProjects(), { wrapper });

    await result.current.mutateAsync({ targetId: 'target-1', sourceId: 'source-2' });

    expect(mergeProjects).toHaveBeenCalledWith('target-1', 'source-2', 'test-token');
    // ['projects'] is a prefix of every cached single task, so this refreshes both tasks too
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project-updates', 'target-1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tasks Merged',
        color: 'green',
      })
    );
  });

  it('shows error notification when merge fails', async () => {
    (mergeProjects as jest.Mock).mockRejectedValueOnce(
      new Error('Cannot merge a task into itself')
    );

    const { result } = renderHook(() => useMergeProjects(), { wrapper });

    await expect(
      result.current.mutateAsync({ targetId: 'target-1', sourceId: 'target-1' })
    ).rejects.toThrow('Cannot merge a task into itself');

    await waitFor(() => {
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Merge Failed',
          message: 'Cannot merge a task into itself',
          color: 'red',
        })
      );
    });
  });
});

describe('useUpdateProject', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not let an earlier account response overwrite the current legacy task cache', async () => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'https://worker.example.com/api/v2';
    const originalFetch = global.fetch;
    let resolveFetch: (response: Response) => void = () => {};
    global.fetch = jest.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    ) as unknown as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    clearOnAccountChange(queryClient, undefined, 'test-user-id');
    const taskForAccountA: Project = {
      id: 'shared-task',
      project: 'Fictional shared task',
      status: 'do',
      priority: 5,
      size: '**',
      userId: 'account-a',
      goalId: 'goal-a',
      notes: 'Fictional full body',
      isDeleted: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    queryClient.setQueryData(['projects'], [taskForAccountA]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useUpdateProject(), { wrapper });
    let mutation: Promise<Project>;

    act(() => {
      mutation = result.current.mutateAsync({
        projectId: taskForAccountA.id,
        data: { priority: 8 },
      });
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    clearOnAccountChange(queryClient, 'test-user-id', 'account-b');
    const taskForAccountB = { ...taskForAccountA, priority: 4, goalId: 'goal-b' };
    queryClient.setQueryData(['projects'], [taskForAccountB]);

    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ ...taskForAccountA, priority: 8 }),
      } as Response);
      await mutation;
    });

    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      priority: 4,
      goalId: 'goal-b',
    });
    unmount();
    queryClient.clear();
    global.fetch = originalFetch;
  });

  it('ignores a mutation from before logout and relogin with the same account id', async () => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'https://worker.example.com/api/v2';
    const originalFetch = global.fetch;
    let resolveFetch: (response: Response) => void = () => {};
    global.fetch = jest.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    ) as unknown as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    clearOnAccountChange(queryClient, undefined, 'test-user-id');
    const taskBeforeLogout: Project = {
      id: 'shared-task',
      project: 'Fictional shared task',
      status: 'do',
      priority: 5,
      size: '**',
      userId: 'test-user-id',
      goalId: 'old-goal',
      notes: 'Fictional full body',
      isDeleted: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    queryClient.setQueryData(['projects'], [taskBeforeLogout]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useUpdateProject(), { wrapper });
    let mutation: Promise<Project>;

    act(() => {
      mutation = result.current.mutateAsync({
        projectId: taskBeforeLogout.id,
        data: { priority: 8 },
      });
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    clearOnAccountChange(queryClient, 'test-user-id', null);
    clearOnAccountChange(queryClient, null, 'test-user-id');
    const taskAfterLogin = { ...taskBeforeLogout, priority: 4, goalId: 'new-session-goal' };
    queryClient.setQueryData(['projects'], [taskAfterLogin]);

    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ ...taskBeforeLogout, priority: 8 }),
      } as Response);
      await mutation;
    });

    expect(queryClient.getQueryData<Project[]>(['projects'])?.[0]).toMatchObject({
      priority: 4,
      goalId: 'new-session-goal',
    });
    unmount();
    queryClient.clear();
    global.fetch = originalFetch;
  });

  it('shows the API message when a viewer tries to change a task', async () => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'https://worker.example.com/api/v2';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'You have view-only access to "Acme Solar"' }),
    }) as unknown as typeof fetch;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUpdateProject(), { wrapper });

    await expect(
      result.current.mutateAsync({ projectId: 'task-1', data: { status: 'done' } })
    ).rejects.toThrow('You have view-only access to "Acme Solar"');

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'You have view-only access to "Acme Solar"',
          color: 'red',
        })
      )
    );
  });
});
