import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import { mergeProjects } from '../lib/apiClient';
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
