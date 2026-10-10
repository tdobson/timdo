import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import {
  SIMILAR_DEBOUNCE_MS,
  useAddNoteInstead,
  useSimilarTasks,
  worthCheckingTitle,
  type SimilarTask,
} from './useSimilarTasks';

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

const API = 'https://worker.example.com/api/v2';

const brokenOfferPage: SimilarTask = {
  id: 'task-3f2a',
  shortId: '3f2a91c0',
  title: 'Broken offer page',
  status: 'do',
  projectId: 'proj-installation',
  projectName: 'Installation',
  orgId: 'org-acme',
  orgName: 'Acme Solar',
  assigneeId: 'user-robin',
  assigneeName: 'Robin Fairweather',
  score: 0.67,
  canEdit: true,
  matchedRef: false,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** The URL of the nth fetch call, parsed. */
const calledUrl = (n = 0) => new URL((global.fetch as jest.Mock).mock.calls[n][0]);
const fetchCount = () => (global.fetch as jest.Mock).mock.calls.length;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ASYNC_TIMEOUT = { timeout: 5000 };

describe('worthCheckingTitle', () => {
  it('requires two distinct significant words', () => {
    expect(worthCheckingTitle('')).toBe(false);
    expect(worthCheckingTitle('Call')).toBe(false);
    expect(worthCheckingTitle('Do it')).toBe(false);
    expect(worthCheckingTitle('Call Robin')).toBe(true);
    expect(worthCheckingTitle('Fix offer-page')).toBe(true);
    expect(worthCheckingTitle('Plot 12')).toBe(false);
    expect(worthCheckingTitle('Plot 112')).toBe(true);
    expect(worthCheckingTitle('Rückruf für Müller')).toBe(true);
    expect(worthCheckingTitle('offer page '.repeat(50))).toBe(false);
  });

  it('ignores stop words and duplicate words when counting a title', () => {
    expect(worthCheckingTitle('Fix the')).toBe(false);
    expect(worthCheckingTitle('Fix the offer')).toBe(true);
    expect(worthCheckingTitle('Fix offer offer')).toBe(true);
    expect(worthCheckingTitle('Fix fix')).toBe(false);
  });
});

describe('useSimilarTasks', () => {
  const originalFetch = global.fetch;
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    global.fetch = jest.fn(async () =>
      jsonResponse(200, [brokenOfferPage])
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('asks once typing pauses, scoped to the chosen project, and returns the matches', async () => {
    const { result } = renderHook(
      () => useSimilarTasks('Fix the offer page', { projectId: 'proj-installation' }),
      { wrapper }
    );

    // Nothing before the pause
    expect(result.current.similar).toEqual([]);
    expect(fetchCount()).toBe(0);

    await waitFor(() => expect(result.current.similar).toEqual([brokenOfferPage]), ASYNC_TIMEOUT);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map(({ queryKey }) => queryKey)
    ).toContainEqual(['task-similar', 'test-user-id', 'Fix the offer page', 'proj-installation']);
    expect(fetchCount()).toBe(1);
    const url = calledUrl();
    expect(url.pathname).toBe('/api/v2/tasks/similar');
    expect(url.searchParams.get('title')).toBe('Fix the offer page');
    expect(url.searchParams.get('projectId')).toBe('proj-installation');
    expect(url.searchParams.get('limit')).toBe('3');
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('searches every workspace when no project is picked', async () => {
    const { result } = renderHook(() => useSimilarTasks('Broken offer page'), { wrapper });

    await waitFor(() => expect(result.current.similar).toHaveLength(1), ASYNC_TIMEOUT);
    expect(calledUrl().searchParams.has('projectId')).toBe(false);
  });

  it('only asks for the title typed last when typing is quick', async () => {
    const { result, rerender } = renderHook(({ title }) => useSimilarTasks(title), {
      wrapper,
      initialProps: { title: 'Fix' },
    });

    jest.useFakeTimers();
    try {
      for (const title of ['Fix the', 'Fix the off', 'Fix the offer', 'Fix the offer page']) {
        act(() => jest.advanceTimersByTime(SIMILAR_DEBOUNCE_MS - 50));
        rerender({ title });
      }
      act(() => jest.advanceTimersByTime(SIMILAR_DEBOUNCE_MS));
      await waitFor(() => expect(result.current.similar).toHaveLength(1), ASYNC_TIMEOUT);
    } finally {
      jest.useRealTimers();
    }
    expect(fetchCount()).toBe(1);
    expect(calledUrl().searchParams.get('title')).toBe('Fix the offer page');
  });

  it('drops a request that is still running when the title changes', async () => {
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      // The first request never answers; the second does
      return signals.length === 1
        ? new Promise(() => {})
        : Promise.resolve(jsonResponse(200, [brokenOfferPage]));
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(({ title }) => useSimilarTasks(title), {
      wrapper,
      initialProps: { title: 'Fix offer' },
    });
    await waitFor(() => expect(signals).toHaveLength(1), ASYNC_TIMEOUT);

    rerender({ title: 'Fix offer page' });
    await waitFor(() => expect(signals).toHaveLength(2), ASYNC_TIMEOUT);
    await waitFor(() => expect(result.current.similar).toEqual([brokenOfferPage]), ASYNC_TIMEOUT);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('hides prior suggestions until the current title and project have both resolved', async () => {
    const nextTitleTask = { ...brokenOfferPage, id: 'task-next', shortId: 'next0001' };
    const nextProjectTask = { ...brokenOfferPage, id: 'task-project', shortId: 'project1', projectId: 'proj-next' };
    let resolveTitle: ((value: any) => void) | undefined;
    let resolveProject: ((value: any) => void) | undefined;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [brokenOfferPage]))
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveTitle = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveProject = resolve; })
      ) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ title, projectId }) => useSimilarTasks(title, { projectId }),
      { wrapper, initialProps: { title: 'Broken offer page', projectId: 'proj-installation' } }
    );
    await waitFor(() => expect(result.current.similar).toEqual([brokenOfferPage]), ASYNC_TIMEOUT);

    rerender({ title: 'Fix broken offer page', projectId: 'proj-installation' });
    expect(result.current.similar).toEqual([]);
    await waitFor(() => expect(fetchCount()).toBe(2), ASYNC_TIMEOUT);
    expect(result.current.similar).toEqual([]);
    act(() => resolveTitle?.(jsonResponse(200, [nextTitleTask])));
    await waitFor(() => expect(result.current.similar).toEqual([nextTitleTask]), ASYNC_TIMEOUT);

    rerender({ title: 'Fix broken offer page', projectId: 'proj-next' });
    expect(result.current.similar).toEqual([]);
    await waitFor(() => expect(fetchCount()).toBe(3), ASYNC_TIMEOUT);
    expect(result.current.similar).toEqual([]);
    act(() => resolveProject?.(jsonResponse(200, [nextProjectTask])));
    await waitFor(() => expect(result.current.similar).toEqual([nextProjectTask]), ASYNC_TIMEOUT);
  });

  it('asks for nothing while disabled or for a one-word title', async () => {
    const { result, rerender } = renderHook(
      ({ title, enabled }) => useSimilarTasks(title, { enabled }),
      { wrapper, initialProps: { title: 'Broken offer page', enabled: false } }
    );
    rerender({ title: 'Invoices', enabled: true });

    await act(() => pause(SIMILAR_DEBOUNCE_MS + 100));
    expect(result.current.similar).toEqual([]);
    expect(fetchCount()).toBe(0);
  });

  it('shows nothing when the check fails', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(500, { error: 'Something broke' })
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useSimilarTasks('Broken offer page'), { wrapper });

    await waitFor(() => expect(fetchCount()).toBe(1), ASYNC_TIMEOUT);
    await act(() => pause(10));
    expect(result.current.similar).toEqual([]);
  });
});

describe('useAddNoteInstead', () => {
  const originalFetch = global.fetch;
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts the note to the existing task and says where it went', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(201, { id: 'note-1', note: 'Fix the offer page' })
    ) as unknown as typeof fetch;
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAddNoteInstead(), { wrapper });

    await act(() =>
      result.current.mutateAsync({ task: brokenOfferPage, note: 'Fix the offer page' })
    );

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${API}/projects/task-3f2a/updates`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ note: 'Fix the offer page' });
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Note added',
        message: 'Added to #3f2a91c0 "Broken offer page"',
      })
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project-updates', 'task-3f2a'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['activity'] });
  });

  it('toasts the API message when the note is refused', async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(403, { error: 'You have view-only access to "Acme Solar"' })
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useAddNoteInstead(), { wrapper });

    act(() => result.current.mutate({ task: brokenOfferPage, note: 'Fix the offer page' }));
    await waitFor(() => expect(result.current.isError).toBe(true), ASYNC_TIMEOUT);
    expect(result.current.error?.message).toBe('You have view-only access to "Acme Solar"');
    expect(notifications.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not add note',
        message: 'You have view-only access to "Acme Solar"',
        color: 'red',
      })
    );
  });
});
