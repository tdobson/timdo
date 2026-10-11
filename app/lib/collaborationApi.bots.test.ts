import * as collaborationApi from './collaborationApi';

const botApi = collaborationApi as unknown as Record<string, (...args: any[]) => Promise<any>>;

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('bot management API', () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.NEXT_PUBLIC_WORKER_API_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = 'https://worker.example.test/api/v2';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = originalBaseUrl;
  });

  it('loads bot views with account authentication and an abort signal', async () => {
    const rows = [{ id: 'bot|fixture', kind: 'bot', name: 'Forum watcher', tokens: [] }];
    const controller = new AbortController();
    (global.fetch as jest.Mock).mockResolvedValue(response(rows));

    await expect(
      botApi.fetchBots('org fixture', 'fictional-session-token', controller.signal)
    ).resolves.toEqual(rows);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.test/api/v2/organisations/org%20fixture/bots',
      expect.objectContaining({
        headers: { Authorization: 'Bearer fictional-session-token' },
        signal: controller.signal,
      })
    );
  });

  it('creates a bot through a no-store response path', async () => {
    const result = {
      bot: { id: 'bot|fixture', kind: 'bot', name: 'Forum watcher', role: 'member', tokens: [] },
      token: 'fictional-one-time-token',
    };
    (global.fetch as jest.Mock).mockResolvedValue(response(result, 201));

    await expect(
      botApi.createBot(
        'org-1',
        { name: 'Forum watcher', role: 'member', tokenName: 'initial' },
        'fictional-session-token'
      )
    ).resolves.toEqual(result);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.test/api/v2/organisations/org-1/bots',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        headers: {
          Authorization: 'Bearer fictional-session-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Forum watcher', role: 'member', tokenName: 'initial' }),
      })
    );
  });

  it('surfaces concurrent bot edits as a reloadable 409 without retrying', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      response({ error: 'Bot was changed by another request' }, 409)
    );

    await expect(
      botApi.updateBot('org-1', 'bot|fixture', { name: 'New name' }, 'fictional-session-token')
    ).rejects.toMatchObject({ status: 409, message: 'Bot was changed by another request' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles no-content revoke and disable responses without parsing JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 204 });

    await expect(
      botApi.revokeBotToken('org-1', 'bot|fixture', 'token-1', 'fictional-session-token')
    ).resolves.toBeUndefined();
    await expect(
      botApi.disableBot('org-1', 'bot|fixture', 'fictional-session-token')
    ).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://worker.example.test/api/v2/organisations/org-1/bots/bot%7Cfixture/tokens/token-1',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://worker.example.test/api/v2/organisations/org-1/bots/bot%7Cfixture',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
