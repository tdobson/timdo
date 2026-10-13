import { fetchActivityPage } from './collaborationApi';

const API = 'https://worker.example.test/api/v2';

function response(body: unknown, status = 200, nextCursor: string | null = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-next-cursor' ? nextCursor : null),
    },
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchActivityPage', () => {
  it('requests an opt-in page and reads its continuation header', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response([], 200, 'opaque-cursor'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    const page = await fetchActivityPage(
      { taskId: 'task-1', orgId: 'workspace-1', limit: 25 },
      'fictional-access-token',
      'opaque-before',
      controller.signal
    );

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v2/activity');
    expect(parsed.searchParams.get('paged')).toBe('1');
    expect(parsed.searchParams.get('taskId')).toBe('task-1');
    expect(parsed.searchParams.get('orgId')).toBe('workspace-1');
    expect(parsed.searchParams.get('limit')).toBe('25');
    expect(parsed.searchParams.get('before')).toBe('opaque-before');
    expect(init.headers.Authorization).toBe('Bearer fictional-access-token');
    expect(init.signal).toBe(controller.signal);
    expect(init.cache).toBe('no-store');
    expect(page).toEqual({ entries: [], nextCursor: 'opaque-cursor' });
  });

  it('does not add an empty before parameter to the initial page', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchActivityPage({}, 'fictional-access-token');

    const parsed = new URL(fetchMock.mock.calls[0][0]);
    expect(parsed.searchParams.get('paged')).toBe('1');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(parsed.searchParams.has('before')).toBe(false);
  });

  it('preserves response status for permission and stale-scope handling', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ error: 'Scope changed' }, 409));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchActivityPage({}, 'fictional-access-token', 'stale-cursor')
    ).rejects.toMatchObject({
      status: 409,
      message: 'Scope changed',
    });
  });
});
