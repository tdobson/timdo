import { getProjectCounts, getProjectPage } from './apiClient';

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

describe('board list API helpers', () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.NEXT_PUBLIC_WORKER_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'http://example.com/api/v2';
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = originalEnv;
  });

  it('reads page totals and continuation headers and forwards the abort signal', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Total-Count': '81', 'X-Next-Cursor': 'next-page' }),
      json: async () => [{ id: 'done-1' }],
    } as unknown as Response);

    const page = await getProjectPage(
      {
        status: ['done'],
        doneBefore: '2026-09-27',
        sort: 'completed',
        fields: 'summary',
        limit: 50,
        cursor: 'page-token',
      },
      'token',
      controller.signal
    );

    expect(page).toEqual({ items: [{ id: 'done-1' }], total: 81, nextCursor: 'next-page' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v2/projects');
    expect(parsed.searchParams.get('status')).toBe('done');
    expect(parsed.searchParams.get('doneBefore')).toBe('2026-09-27');
    expect(parsed.searchParams.get('sort')).toBe('completed');
    expect(parsed.searchParams.get('fields')).toBe('summary');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(parsed.searchParams.get('cursor')).toBe('page-token');
    expect(init.signal).toBe(controller.signal);
  });

  it('fetches aggregate counts from the static counts route with the same membership filters', async () => {
    const counts = {
      byStatus: { do: 2, delay: 3, awaiting: 4, delegate: 5, done: 6 },
      total: 20,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => counts,
    } as unknown as Response);

    await expect(
      getProjectCounts({ category: 'Workshop', assignee: 'me' }, 'token')
    ).resolves.toEqual(counts);
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v2/projects/counts');
    expect(parsed.searchParams.get('category')).toBe('Workshop');
    expect(parsed.searchParams.get('assignee')).toBe('me');
  });
});
