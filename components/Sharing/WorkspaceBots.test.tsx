import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSession } from 'next-auth/react';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { BotView, SharingWorkspace } from '../../app/types/collaboration.types';
import { theme } from '../../theme';
import { WorkspaceCard } from './WorkspaceCard';

jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

const mockUseSession = useSession as unknown as jest.Mock;
const API = 'https://worker.example.test/api/v2';
const ONE_TIME_SECRET = 'fictional-secret-do-not-cache';

function workspace(role: SharingWorkspace['role'] = 'owner'): SharingWorkspace {
  return {
    id: 'org-1',
    name: 'Northstar Workshop',
    slug: 'northstar-workshop',
    isPersonal: false,
    role,
    memberCount: 1,
    projectCount: 0,
    createdBy: 'human-1',
    members: [
      {
        userId: 'human-1',
        userName: 'Taylor Example',
        userEmail: 'taylor@example.test',
        role,
        isMe: true,
      },
    ],
    projects: [],
    invites: [],
  };
}

function makeSession(accountId: string, token: string) {
  return {
    data: {
      user: { id: accountId, name: `${accountId} Example`, email: `${accountId}@example.test` },
      accessToken: token,
      expires: '2099-01-01',
    },
    status: 'authenticated',
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('Workspace bot management', () => {
  const originalFetch = global.fetch;
  let queryClient: QueryClient;
  let clipboardDescriptor: PropertyDescriptor | undefined;
  let renderCard: (ws: SharingWorkspace) => ReturnType<typeof render>;

  beforeEach(() => {
    jest.clearAllMocks();
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
    mockUseSession.mockReturnValue(makeSession('account-a', 'fictional-session-a'));
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    renderCard = (ws) =>
      render(
        <QueryClientProvider client={queryClient}>
          <MantineProvider theme={theme}>
            <WorkspaceCard workspace={ws} allWorkspaces={[ws]} />
          </MantineProvider>
        </QueryClientProvider>
      );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    } else {
      delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
    queryClient.clear();
  });

  it('lets a manager create a bot and keeps the one-time secret out of query and mutation caches', async () => {
    const bot = {
      id: 'bot|fixture',
      kind: 'bot',
      name: 'Forum watcher',
      role: 'member',
      createdByName: 'Taylor Example',
      createdAt: '2026-10-11T12:00:00.000Z',
      disabledAt: null,
      tokens: [
        { id: 'token-1', name: 'initial', prefix: 'tdo_abc', createdAt: null, lastUsedAt: null },
      ],
    };
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && !init.method) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return Promise.resolve(response({ bot, token: ONE_TIME_SECRET }, 201));
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderCard(workspace());

    const nameInput = await screen.findByRole('textbox', { name: 'Bot name' });
    await userEvent.type(nameInput, 'Forum watcher');
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByRole('textbox', { name: 'New bot token' })).toHaveValue(
      ONE_TIME_SECRET
    );
    expect(screen.getByRole('button', { name: "I've stored it" })).toBeInTheDocument();
    await waitFor(() => {
      const cachedValues = queryClient
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.state.data));
      const mutationValues = queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => JSON.stringify(mutation.state.data));
      expect([...cachedValues, ...mutationValues].join('\n')).not.toContain(ONE_TIME_SECRET);
    });

    await userEvent.click(screen.getByRole('button', { name: "I've stored it" }));
    expect(screen.queryByDisplayValue(ONE_TIME_SECRET)).not.toBeInTheDocument();
    const createRequests = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0][1]).toEqual(expect.objectContaining({ cache: 'no-store' }));
  });

  it('keeps the token available for manual copying when clipboard access fails', async () => {
    const bot = {
      id: 'bot|fixture',
      kind: 'bot',
      name: 'Forum watcher',
      role: 'member',
      createdByName: 'Taylor Example',
      createdAt: '2026-10-11T12:00:00.000Z',
      disabledAt: null,
      tokens: [],
    };
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return Promise.resolve(response({ bot, token: ONE_TIME_SECRET }, 201));
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('permission denied')) },
    });
    renderCard(workspace());

    await userEvent.type(await screen.findByRole('textbox', { name: 'Bot name' }), 'Forum watcher');
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    const secret = await screen.findByRole('textbox', { name: 'New bot token' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));

    expect(
      await screen.findByText(
        'Clipboard access failed. Select the token above and copy it manually.'
      )
    ).toBeInTheDocument();
    expect(secret).toHaveValue(ONE_TIME_SECRET);
  });

  it('shows the safe bot roster to viewers without management controls or synthetic emails', async () => {
    const ws = workspace('viewer');
    ws.members.push({
      userId: 'bot|fixture',
      userName: 'Forum watcher',
      kind: 'bot',
      role: 'member',
      isMe: false,
    });
    const fetchMock = jest.fn().mockResolvedValue(response([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderCard(ws);

    const botRow = await screen.findByTestId('member-row-bot|fixture');
    expect(within(botRow).getByText('Forum watcher')).toBeInTheDocument();
    expect(within(botRow).getByLabelText('Bot identity')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create bot' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('@bots.timdo.invalid');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/bots'))).toBe(false);
  });

  it('keeps generic member controls off bot rows for owners', async () => {
    const ws = workspace();
    ws.members.push({
      userId: 'bot|fixture',
      userName: 'Forum watcher',
      kind: 'bot',
      role: 'member',
      isMe: false,
    });
    global.fetch = jest.fn().mockResolvedValue(response([])) as unknown as typeof fetch;

    renderCard(ws);

    const botRow = await screen.findByTestId('member-row-bot|fixture');
    expect(within(botRow).getByLabelText('Bot identity')).toBeInTheDocument();
    expect(
      within(botRow).queryByRole('textbox', { name: 'Role for Forum watcher' })
    ).not.toBeInTheDocument();
    expect(
      within(botRow).queryByRole('button', { name: 'Remove Forum watcher' })
    ).not.toBeInTheDocument();
  });

  it('issues a token to the selected bot when bot names are duplicated', async () => {
    const duplicateBots: BotView[] = ['bot|first', 'bot|second'].map((id) => ({
      id,
      kind: 'bot',
      name: 'Forum watcher',
      role: 'member',
      createdByName: 'Taylor Example',
      createdAt: '2026-10-11T12:00:00.000Z',
      disabledAt: null,
      tokens: [],
    }));
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && (!init.method || init.method === 'GET')) {
        return Promise.resolve(response(duplicateBots));
      }
      if (url.endsWith('/organisations/org-1/bots/bot%7Csecond/tokens') && init.method === 'POST') {
        return Promise.resolve(
          response(
            {
              id: 'token-second',
              name: 'CLI token',
              prefix: 'tdo_second',
              createdAt: null,
              lastUsedAt: null,
              token: 'fictional-second-bot-token',
            },
            201
          )
        );
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderCard(workspace());

    const secondBot = await screen.findByTestId('bot-row-bot|second');
    await userEvent.click(
      within(secondBot).getByRole('button', { name: 'Issue token for Forum watcher' })
    );

    expect(await screen.findByRole('textbox', { name: 'New bot token' })).toHaveValue(
      'fictional-second-bot-token'
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/organisations/org-1/bots/bot%7Csecond/tokens`,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('does not expose bot management for a personal workspace owner', async () => {
    const ws = { ...workspace(), isPersonal: true };
    const fetchMock = jest.fn().mockResolvedValue(response([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderCard(ws);

    expect(screen.queryByRole('button', { name: 'Create bot' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/bots'))).toBe(false);
  });

  it('reloads after a conflicting rename and does not replay the request', async () => {
    const bot: BotView = {
      id: 'bot|fixture',
      kind: 'bot',
      name: 'Forum watcher',
      role: 'member',
      createdByName: 'Taylor Example',
      createdAt: '2026-10-11T12:00:00.000Z',
      disabledAt: null,
      tokens: [],
    };
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && (!init.method || init.method === 'GET')) {
        return Promise.resolve(response([bot]));
      }
      if (url.endsWith('/organisations/org-1/bots/bot%7Cfixture') && init.method === 'PUT') {
        return Promise.resolve(response({ error: 'Bot was changed by another request' }, 409));
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderCard(workspace());

    const nameInput = await screen.findByRole('textbox', { name: 'Name for Forum watcher' });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Stale name');
    await userEvent.click(screen.getByRole('button', { name: 'Save name for Forum watcher' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The latest settings have been loaded'
    );
    expect(await screen.findByRole('textbox', { name: 'Name for Forum watcher' })).toHaveValue(
      'Forum watcher'
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('renames, changes role, mints and revokes a token, and confirms bot disable', async () => {
    let bots: BotView[] = [
      {
        id: 'bot|fixture',
        kind: 'bot',
        name: 'Forum watcher',
        role: 'member',
        createdByName: 'Taylor Example',
        createdAt: '2026-10-11T12:00:00.000Z',
        disabledAt: null,
        tokens: [
          {
            id: 'token-old',
            name: 'initial',
            prefix: 'tdo_old',
            createdAt: null,
            lastUsedAt: null,
          },
        ],
      },
    ];
    const fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      if (url.endsWith('/organisations/org-1/bots') && method === 'GET') {
        return response(bots);
      }
      if (url.endsWith('/organisations/org-1/bots/bot%7Cfixture') && method === 'PUT') {
        const update = JSON.parse(String(init.body));
        bots = [{ ...bots[0], ...update }];
        return response(bots[0]);
      }
      if (url.endsWith('/organisations/org-1/bots/bot%7Cfixture/tokens') && method === 'POST') {
        const name = JSON.parse(String(init.body)).name;
        const token = {
          id: 'token-new',
          name,
          prefix: 'tdo_new',
          createdAt: null,
          lastUsedAt: null,
        };
        bots = [{ ...bots[0], tokens: [...bots[0].tokens, token] }];
        return response({ ...token, token: 'fictional-replacement-token' }, 201);
      }
      if (url.endsWith('/tokens/token-new') && method === 'DELETE') {
        bots = [{ ...bots[0], tokens: bots[0].tokens.filter((item) => item.id !== 'token-new') }];
        return { ok: true, status: 204 };
      }
      if (url.endsWith('/organisations/org-1/bots/bot%7Cfixture') && method === 'DELETE') {
        bots = [{ ...bots[0], role: null, disabledAt: '2026-10-11T13:00:00.000Z', tokens: [] }];
        return { ok: true, status: 204 };
      }
      return response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderCard(workspace());

    const nameInput = await screen.findByRole('textbox', { name: 'Name for Forum watcher' });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Forum watcher Plus');
    await userEvent.click(screen.getByRole('button', { name: 'Save name for Forum watcher' }));
    expect(await screen.findByText('Forum watcher Plus')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/organisations/org-1/bots/bot%7Cfixture`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ name: 'Forum watcher Plus' }),
        })
      )
    );

    const roleSelect = await screen.findByRole('textbox', { name: 'Role for Forum watcher Plus' });
    await userEvent.click(roleSelect);
    await userEvent.click(await screen.findByRole('option', { name: 'Viewer' }));
    await waitFor(() => expect(bots[0].role).toBe('viewer'));

    const replacementName = screen.getByRole('textbox', {
      name: 'New token name for Forum watcher Plus',
    });
    await userEvent.clear(replacementName);
    await userEvent.type(replacementName, 'Rotation test');
    await userEvent.click(
      screen.getByRole('button', { name: 'Issue token for Forum watcher Plus' })
    );
    expect(await screen.findByRole('textbox', { name: 'New bot token' })).toHaveValue(
      'fictional-replacement-token'
    );
    await userEvent.click(screen.getByRole('button', { name: "I've stored it" }));

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke token Rotation test for Forum watcher Plus' })
    );
    expect(
      await screen.findByRole('heading', { name: 'Revoke Rotation test?' })
    ).toBeInTheDocument();
    expect(screen.getByText(/will stop working in Northstar Workshop/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(bots[0].tokens.map((item) => item.id)).toEqual(['token-old']));

    await userEvent.click(screen.getByRole('button', { name: 'Disable Forum watcher Plus' }));
    expect(
      await screen.findByRole('heading', { name: 'Disable Forum watcher Plus?' })
    ).toBeInTheDocument();
    expect(screen.getByText(/all its tokens will be revoked/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disable bot' }));
    expect(await screen.findByText('Disabled', { selector: 'span' })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${API}/organisations/org-1/bots/bot%7Cfixture`,
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });

  it('keeps a one-time token visible until acknowledged and ignores a late copy from it', async () => {
    const bot: BotView = {
      id: 'bot|fixture',
      kind: 'bot',
      name: 'Forum watcher',
      role: 'member',
      createdByName: 'Taylor Example',
      createdAt: '2026-10-11T12:00:00.000Z',
      disabledAt: null,
      tokens: [],
    };
    let issuedTokens = 0;
    const createdBot: BotView = { ...bot, id: 'bot|created', name: 'Another bot' };
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && (!init.method || init.method === 'GET')) {
        return Promise.resolve(response([bot]));
      }
      if (
        url.endsWith('/organisations/org-1/bots/bot%7Cfixture/tokens') &&
        init.method === 'POST'
      ) {
        issuedTokens += 1;
        return Promise.resolve(
          response(
            {
              id: `token-${issuedTokens}`,
              name: 'Rotation token',
              prefix: `tdo_${issuedTokens}`,
              createdAt: null,
              lastUsedAt: null,
              token: `fictional-token-${issuedTokens}`,
            },
            201
          )
        );
      }
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return Promise.resolve(
          response({ bot: createdBot, token: 'fictional-created-token' }, 201)
        );
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    let resolveCopy!: () => void;
    const writeText = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderCard(workspace());

    const issueButton = await screen.findByRole('button', {
      name: 'Issue token for Forum watcher',
    });
    await userEvent.click(issueButton);
    expect(await screen.findByRole('textbox', { name: 'New bot token' })).toHaveValue(
      'fictional-token-1'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('fictional-token-1'));

    expect(issueButton).toBeDisabled();
    await userEvent.click(issueButton);
    const botNameInput = screen.getByRole('textbox', { name: 'Bot name' });
    await userEvent.type(botNameInput, 'Another bot');
    expect(screen.getByRole('button', { name: 'Create bot' })).toBeDisabled();
    fireEvent.submit(botNameInput.closest('form')!);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'New bot token' })).toHaveValue('fictional-token-1');

    await userEvent.click(screen.getByRole('button', { name: "I've stored it" }));
    await userEvent.click(screen.getByRole('button', { name: 'Issue token for Forum watcher' }));
    expect(await screen.findByRole('textbox', { name: 'New bot token' })).toHaveValue(
      'fictional-token-2'
    );
    resolveCopy();
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'New bot token' })).toHaveValue(
        'fictional-token-2'
      )
    );
    expect(screen.queryByText('Copied. Keep the token somewhere safe.')).not.toBeInTheDocument();
  });

  it('explains uncertain create outcomes and never automatically retries them', async () => {
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && !init.method) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return Promise.reject(new TypeError('network disconnected'));
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderCard(workspace());

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Bot name' }),
      'Lost response bot'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The request may have created the bot or token'
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'revoke the credential and issue a replacement'
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('does not reveal a late creation response after the account changes', async () => {
    let resolveCreation!: (value: unknown) => void;
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && !init.method) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreation = resolve;
        });
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const ui = renderCard(workspace());

    await userEvent.type(await screen.findByRole('textbox', { name: 'Bot name' }), 'Late bot');
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(resolveCreation).toBeDefined());

    mockUseSession.mockReturnValue(makeSession('account-b', 'fictional-session-b'));
    ui.rerender(
      <QueryClientProvider client={queryClient}>
        <MantineProvider theme={theme}>
          <WorkspaceCard workspace={workspace()} allWorkspaces={[workspace()]} />
        </MantineProvider>
      </QueryClientProvider>
    );

    resolveCreation(
      response({ bot: { id: 'bot|late', name: 'Late bot' }, token: ONE_TIME_SECRET }, 201)
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(screen.queryByDisplayValue(ONE_TIME_SECRET)).not.toBeInTheDocument();
    expect(notifications.show).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not reveal or invalidate after the workspace changes during bot creation', async () => {
    let resolveCreation!: (value: unknown) => void;
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith('/organisations/org-1/bots') && (!init.method || init.method === 'GET')) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith('/organisations/org-1/bots') && init.method === 'POST') {
        return new Promise((resolve) => {
          resolveCreation = resolve;
        });
      }
      return Promise.resolve(response([]));
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const initialWorkspace = workspace();
    const ui = renderCard(initialWorkspace);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Bot name' }), 'Late bot');
    await userEvent.click(screen.getByRole('button', { name: 'Create bot' }));
    await waitFor(() => expect(resolveCreation).toBeDefined());

    const nextWorkspace = {
      ...workspace(),
      id: 'org-2',
      name: 'Southstar Workshop',
      slug: 'southstar-workshop',
    };
    ui.rerender(
      <QueryClientProvider client={queryClient}>
        <MantineProvider theme={theme}>
          <WorkspaceCard workspace={nextWorkspace} allWorkspaces={[nextWorkspace]} />
        </MantineProvider>
      </QueryClientProvider>
    );

    resolveCreation(
      response({ bot: { id: 'bot|late', name: 'Late bot' }, token: ONE_TIME_SECRET }, 201)
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(screen.queryByDisplayValue(ONE_TIME_SECRET)).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-card-org-2')).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
