import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import type { Project, RefView } from '../types/project.types';
import { projectKeys } from './useProjectQueries';
import { isPendingRef, RefApiError, sortRefs, useAddRef, useRemoveRef } from './useRefQueries';

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

const API = 'https://worker.example.com/api/v2';

function refView(overrides: Partial<RefView> = {}): RefView {
  return {
    id: 'ref-1',
    taskId: 'task-1',
    role: 'link',
    kind: 'github.issue',
    ref: 'acme/widgets#12',
    canonical: 'github.issue:acme/widgets#12',
    url: 'https://github.com/acme/widgets/issues/12',
    label: null,
    displayLabel: 'GitHub issue acme/widgets#12',
    createdById: 'user-1',
    createdByName: 'Robin Fairweather',
    createdAt: '2026-10-09T10:00:00.000Z',
    canDelete: true,
    ...overrides,
  };
}

const task = (refs: RefView[] = []): Project => ({
  id: 'task-1',
  userId: 'user-1',
  project: 'Broken offer page',
  status: 'do',
  priority: 5,
  size: '**',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  refs,
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('sortRefs', () => {
  it('orders Source, About, Reported by, Link, then oldest first', () => {
    const sorted = sortRefs([
      refView({ id: 'a', role: 'link', createdAt: '2026-10-09T09:00:00.000Z' }),
      refView({ id: 'b', role: 'reported_by' }),
      refView({ id: 'c', role: 'link', createdAt: '2026-10-08T09:00:00.000Z' }),
      refView({ id: 'd', role: 'source' }),
      refView({ id: 'e', role: 'about' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['d', 'e', 'b', 'c', 'a']);
  });
});

describe('ref mutations', () => {
  const originalFetch = global.fetch;
  let queryClient: QueryClient;
  let resolveFetch: (value: unknown) => void;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const cachedRefs = () => ({
    list: queryClient.getQueryData<Project[]>(projectKeys.all)?.[0].refs,
    detail: queryClient.getQueryData<Project>(projectKeys.detail('task-1'))?.refs,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const existing = refView({
      id: 'ref-old',
      role: 'source',
      kind: 'forum.post',
      ref: '4411',
      canonical: 'forum.post:4411',
      url: null,
      displayLabel: 'forum.post:4411',
    });
    queryClient.setQueryData(projectKeys.all, [task([existing])]);
    queryClient.setQueryData(projectKeys.detail('task-1'), task([existing]));
    // Each test answers the request when it wants to, so the optimistic state can be checked
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows a new link straight away, posts it, then swaps in the stored one', async () => {
    const { result } = renderHook(() => useAddRef(), { wrapper });

    act(() => {
      result.current.mutate({
        taskId: 'task-1',
        input: { ref: 'https://github.com/acme/widgets/issues/12', role: 'link' },
      });
    });

    await waitFor(() => expect(cachedRefs().list).toHaveLength(2));
    const pending = cachedRefs().list![1];
    expect(isPendingRef(pending)).toBe(true);
    expect(pending).toMatchObject({
      canonical: 'github.issue:acme/widgets#12',
      displayLabel: 'GitHub issue acme/widgets#12',
      url: 'https://github.com/acme/widgets/issues/12',
    });
    expect(cachedRefs().detail).toHaveLength(2);

    expect(global.fetch).toHaveBeenCalledWith(
      `${API}/tasks/task-1/refs`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'https://github.com/acme/widgets/issues/12', role: 'link' }),
      })
    );

    resolveFetch(jsonResponse(201, { ...refView({ id: 'ref-new' }), existing: false }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() =>
      expect(cachedRefs().detail?.map((r) => r.id)).toEqual(['ref-old', 'ref-new'])
    );
    expect(cachedRefs().list?.[1]).not.toHaveProperty('existing');
  });

  it('puts things back and reports the other task on a source clash', async () => {
    const { result } = renderHook(() => useAddRef(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', input: { ref: 'forum.post:7', role: 'source' } });
    });
    await waitFor(() => expect(cachedRefs().list).toHaveLength(2));

    resolveFetch(
      jsonResponse(409, {
        error: 'forum.post:7 is already the source of 3f2a91c0 "Broken offer page"',
        taskId: '3f2a91c0-0000-4000-8000-000000000000',
      })
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as RefApiError;
    expect(error).toBeInstanceOf(RefApiError);
    expect(error.status).toBe(409);
    expect(error.taskId).toBe('3f2a91c0-0000-4000-8000-000000000000');
    expect(error.message).toBe(
      'forum.post:7 is already the source of 3f2a91c0 "Broken offer page"'
    );
    expect(cachedRefs().list?.map((r) => r.id)).toEqual(['ref-old']);
    // The form shows add errors inline, so no toast
    expect(notifications.show).not.toHaveBeenCalled();
  });

  it('does not show the same link twice when it is already on the task', async () => {
    const { result } = renderHook(() => useAddRef(), { wrapper });

    act(() => {
      result.current.mutate({
        taskId: 'task-1',
        input: { ref: 'forum.post:4411', role: 'source' },
      });
    });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(cachedRefs().list?.map((r) => r.id)).toEqual(['ref-old']);
  });

  it('removes a link straight away and restores it with a toast when the API refuses', async () => {
    const { result } = renderHook(() => useRemoveRef(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', refId: 'ref-old' });
    });

    await waitFor(() => expect(cachedRefs().list).toEqual([]));
    expect(global.fetch).toHaveBeenCalledWith(
      `${API}/tasks/task-1/refs/ref-old`,
      expect.objectContaining({ method: 'DELETE' })
    );

    resolveFetch(jsonResponse(403, { error: 'You have view-only access to "Acme Solar"' }));

    await waitFor(() => expect(cachedRefs().list?.map((r) => r.id)).toEqual(['ref-old']));
    expect(cachedRefs().detail?.map((r) => r.id)).toEqual(['ref-old']);
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not remove link',
        message: 'You have view-only access to "Acme Solar"',
        color: 'red',
      })
    );
  });

  it('refreshes tasks and activity once the change is stored', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRemoveRef(), { wrapper });

    act(() => {
      result.current.mutate({ taskId: 'task-1', refId: 'ref-old' });
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    resolveFetch({ ok: true, status: 204, text: async () => '' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] });
  });
});
