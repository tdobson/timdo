import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { activityKeys, canonicalActivityFilters, useActivityPages } from './useActivityQueries';

const API = 'https://worker.example.test/api/v2';

function response(body: unknown, cursor?: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-next-cursor' ? (cursor ?? null) : null),
    },
  });
}

function errorResponse(error: string, message: string, status = 400) {
  const body = { error, message };
  return Promise.resolve({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('activity page queries', () => {
  it('normalizes canonical filters and keeps account/filter ownership in the key', () => {
    expect(canonicalActivityFilters({ orgId: '', projectId: 'project-1' })).toEqual({
      taskId: null,
      epicId: null,
      projectId: 'project-1',
      orgId: null,
    });
    expect(activityKeys.paged('account-1', { orgId: 'workspace-1' })).toEqual(
      activityKeys.paged('account-1', { orgId: 'workspace-1', limit: 50 })
    );
    expect(activityKeys.paged('account-1', { orgId: 'workspace-1' })).not.toEqual(
      activityKeys.paged('account-2', { orgId: 'workspace-1' })
    );
    expect(activityKeys.paged('account-1', { orgId: 'workspace-1' })).not.toEqual(
      activityKeys.paged('account-1', { orgId: 'workspace-2' })
    );
  });

  it('fetches the first cursor page through its account-scoped infinite query', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/activity')) {
        return response([], 'opaque-cursor');
      }
      return response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useActivityPages({ projectId: 'project-1' }), { wrapper });

    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    const activityRequest = fetchMock.mock.calls.find(([url]) => String(url).includes('/activity'));
    const requestUrl = new URL(activityRequest?.[0]);
    expect(requestUrl.searchParams.get('paged')).toBe('1');
    expect(requestUrl.searchParams.get('projectId')).toBe('project-1');
    expect(requestUrl.searchParams.get('limit')).toBe('50');
    expect(requestUrl.searchParams.has('before')).toBe(false);
    expect(
      queryClient.getQueryCache().find({
        queryKey: activityKeys.paged('test-user-id', { projectId: 'project-1' }),
        exact: true,
      })
    ).toBeDefined();

    queryClient.clear();
  });

  it('restarts only the current account and filter after a continuation invalid_cursor', async () => {
    const requestedActivityPages: Array<{ before: string | null; projectId: string | null }> = [];
    const unrelatedFilterKey = activityKeys.paged('test-user-id', { projectId: 'project-2' });
    const unrelatedAccountKey = activityKeys.paged('other-account-id', { projectId: 'project-1' });
    const unrelatedFilterData = {
      pages: [{ entries: [{ id: 'other-filter-row' }] }],
      pageParams: [null],
    };
    const unrelatedAccountData = {
      pages: [{ entries: [{ id: 'other-account-row' }] }],
      pageParams: [null],
    };
    let firstPageCount = 0;
    const fetchMock = jest.fn((url: string) => {
      const parsedUrl = new URL(String(url));
      if (!parsedUrl.pathname.endsWith('/activity')) {
        return response([]);
      }

      const before = parsedUrl.searchParams.get('before');
      const projectId = parsedUrl.searchParams.get('projectId');
      requestedActivityPages.push({ before, projectId });
      if (before) {
        return errorResponse('invalid_cursor', 'The cursor is invalid or cannot be decrypted');
      }

      firstPageCount += 1;
      return firstPageCount === 1
        ? response([{ id: 'loaded-row' }], 'cursor-from-old-key')
        : response([{ id: 'restarted-row' }]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(unrelatedFilterKey, unrelatedFilterData);
    queryClient.setQueryData(unrelatedAccountKey, unrelatedAccountData);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useActivityPages({ projectId: 'project-1' }), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.data?.pages).toHaveLength(1);
      expect(result.current.data?.pages[0].entries).toEqual([{ id: 'restarted-row' }]);
      expect(result.current.hasNextPage).toBe(false);
    });

    expect(requestedActivityPages).toEqual([
      { before: null, projectId: 'project-1' },
      { before: 'cursor-from-old-key', projectId: 'project-1' },
      { before: null, projectId: 'project-1' },
    ]);
    expect(queryClient.getQueryData(unrelatedFilterKey)).toEqual(unrelatedFilterData);
    expect(queryClient.getQueryData(unrelatedAccountKey)).toEqual(unrelatedAccountData);

    queryClient.clear();
  });

  it('keeps an ordinary first-page 400 as a request error', async () => {
    const requestedActivityPages: Array<string | null> = [];
    const fetchMock = jest.fn((url: string) => {
      const parsedUrl = new URL(String(url));
      if (!parsedUrl.pathname.endsWith('/activity')) {
        return response([]);
      }
      requestedActivityPages.push(parsedUrl.searchParams.get('before'));
      return errorResponse('invalid_request', 'The activity request is invalid');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useActivityPages({ projectId: 'project-1' }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.isScopeFailure).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(requestedActivityPages).toEqual([null]);

    queryClient.clear();
  });
});
