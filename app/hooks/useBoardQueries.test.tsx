import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import {
  boardQueryKeys,
  useBoardDoneHistory,
  useBoardProjectDetail,
  useBoardSummaries,
} from './useBoardQueries';

jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));

const useSessionMock = useSession as jest.Mock;

describe('board query keys and hydration', () => {
  let queryClient: QueryClient;
  const originalFetch = global.fetch;
  const originalApiUrl = process.env.NEXT_PUBLIC_WORKER_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'http://example.test/api/v2';
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    useSessionMock.mockReturnValue({
      data: { user: { id: 'account-one' }, accessToken: 'token-one' },
      status: 'authenticated',
    });
  });

  afterEach(() => {
    queryClient.clear();
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = originalApiUrl;
    jest.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('keeps summary and detail data in separate account-scoped cache families', () => {
    const filters = { customer: 'Workshop', orgId: 'org-a' };
    expect(boardQueryKeys.summary('account-one', filters, '2026-09-27')).not.toEqual(
      boardQueryKeys.summary('account-two', filters, '2026-09-27')
    );
    expect(boardQueryKeys.summary('account-one', filters, '2026-09-27')).not.toEqual(
      boardQueryKeys.counts('account-one', filters)
    );
    expect(boardQueryKeys.detail('account-one', 'task-1')).not.toEqual(
      boardQueryKeys.detail('account-two', 'task-1')
    );
    expect(boardQueryKeys.doneHistory('account-one', filters, '2026-09-27', 2)).not.toEqual(
      boardQueryKeys.doneHistory('account-one', filters, '2026-09-27', 3)
    );
  });

  it('requests body-free open and recent-Done summaries without an unbounded old-Done list', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => [],
        }) as unknown as Response
    );

    renderHook(() => useBoardSummaries({ orgId: 'workspace-one' }, '2026-09-27'), { wrapper });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const [requestUrl] = (global.fetch as jest.Mock).mock.calls[0];
    const url = new URL(requestUrl);
    expect(url.pathname).toBe('/api/v2/projects');
    expect(url.searchParams.get('fields')).toBe('summary');
    expect(url.searchParams.get('status')).toBe('do,delay,awaiting,delegate,done');
    expect(url.searchParams.get('doneSince')).toBe('2026-09-27');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('doneBefore')).toBe(false);
  });

  it('loads older Done pages only when enabled, with a fixed cutoff and bounded page size', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'X-Total-Count': '18' }),
          json: async () => [],
        }) as unknown as Response
    );

    renderHook(() => useBoardDoneHistory({ customer: 'Fictional Workshop' }, '2026-09-27', true), {
      wrapper,
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const [requestUrl] = (global.fetch as jest.Mock).mock.calls[0];
    const url = new URL(requestUrl);
    expect(url.searchParams.get('status')).toBe('done');
    expect(url.searchParams.get('doneBefore')).toBe('2026-09-27');
    expect(url.searchParams.get('sort')).toBe('completed');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('fields')).toBe('summary');
  });

  it('does not fetch full detail until the caller expands a card', () => {
    global.fetch = jest.fn();
    renderHook(() => useBoardProjectDetail('task-1', false), { wrapper });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('passes the query abort signal to full-detail fetches so a collapsed card can cancel hydration', async () => {
    let requestSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      requestSignal = options?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => {});
    });

    const hook = renderHook(() => useBoardProjectDetail('task-1', true), { wrapper });
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    hook.unmount();
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
  });
});
