import React from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notifications } from '@mantine/notifications';
import { render } from '../../../test-utils/render';
import type { ApiToken } from '../../hooks/useApiTokens';
import AccessPage from './page';

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/settings/access',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

const API = 'https://worker.example.com/api/v2';
const SECRET = 'tdo_NewSecretValue1234567890abcdefghijklmnop';

let tokens: ApiToken[] = [];
let createError: { status: number; error: string } | null = null;
const fetchMock = jest.fn();

function respond(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  createError = null;
  tokens = [
    {
      id: 'tok-1',
      name: 'Laptop CLI',
      prefix: 'tdo_Ab12Cd',
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
    {
      id: 'tok-2',
      name: 'Claude Desktop',
      prefix: 'tdo_Zz99Yy',
      createdAt: new Date(Date.now() - 600_000).toISOString(),
      lastUsedAt: null,
    },
  ];
  fetchMock.mockImplementation((url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url === `${API}/users/me/tokens` && method === 'GET') {
      return respond(tokens);
    }
    if (url === `${API}/users/me/tokens` && method === 'POST') {
      if (createError) {
        return respond({ error: createError.error }, false, createError.status);
      }
      const { name } = JSON.parse(String(init.body));
      const created = {
        id: 'tok-new',
        name,
        prefix: SECRET.slice(0, 10),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      tokens = [created, ...tokens];
      return respond({ ...created, token: SECRET }, true, 201);
    }
    const del = url.match(/\/users\/me\/tokens\/([^/]+)$/);
    if (del && method === 'DELETE') {
      tokens = tokens.filter((t) => t.id !== del[1]);
      return respond({ message: 'Token revoked' });
    }
    return respond({ error: 'Not found' }, false, 404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function createToken(name: string) {
  await screen.findByTestId('token-row-tok-1');
  fireEvent.change(screen.getByTestId('token-name-input'), { target: { value: name } });
  await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
}

describe('AccessPage', () => {
  it('lists tokens with their prefix, created date and last used', async () => {
    render(<AccessPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'CLI and MCP access' })
    ).toBeInTheDocument();
    const laptop = await screen.findByTestId('token-row-tok-1');
    expect(within(laptop).getByText('Laptop CLI')).toBeInTheDocument();
    expect(within(laptop).getByText('tdo_Ab12Cd…')).toBeInTheDocument();
    expect(laptop).toHaveTextContent('Created 3d ago');
    expect(laptop).toHaveTextContent('Last used 2h ago');

    const desktop = screen.getByTestId('token-row-tok-2');
    expect(desktop).toHaveTextContent('Last used Never');

    const [listCall] = fetchMock.mock.calls;
    expect(listCall[0]).toBe(`${API}/users/me/tokens`);
    expect(listCall[1].headers.Authorization).toBe('Bearer test-token');
  });

  it('shows an empty state when there are no tokens', async () => {
    tokens = [];
    render(<AccessPage />);
    expect(await screen.findByTestId('tokens-empty')).toHaveTextContent('No tokens yet');
  });

  it('shows a new token once, with a copy button and the login command', async () => {
    render(<AccessPage />);
    await createToken('Work laptop');

    const panel = await screen.findByTestId('new-token-panel');
    expect(within(panel).getByTestId('new-token-value')).toHaveTextContent(SECRET);
    expect(
      within(panel).getByText(/Copy it now\. You won.t be able to see it again\./)
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Copy token' })).toBeInTheDocument();
    // The login command never contains the token, so it can't end up in shell history
    const login = within(panel).getByTestId('new-token-login-command');
    expect(login).toHaveTextContent('bin/timdo login');
    expect(login).not.toHaveTextContent(SECRET);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post?.[1].body)).toEqual({ name: 'Work laptop' });
    expect(post?.[1].headers.Authorization).toBe('Bearer test-token');

    // The new token joins the list, showing only its prefix
    const row = await screen.findByTestId('token-row-tok-new');
    expect(within(row).getByText('Work laptop')).toBeInTheDocument();
    expect(row).not.toHaveTextContent(SECRET);
    // The name box is cleared ready for another
    expect(screen.getByTestId('token-name-input')).toHaveValue('');
  });

  it('hides the token for good when dismissed', async () => {
    render(<AccessPage />);
    await createToken('Work laptop');
    const panel = await screen.findByTestId('new-token-panel');

    await userEvent.click(within(panel).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByTestId('new-token-panel')).not.toBeInTheDocument());
    expect(screen.queryByText(SECRET, { exact: false })).not.toBeInTheDocument();
  });

  it('asks before revoking, then calls DELETE', async () => {
    render(<AccessPage />);
    const row = await screen.findByTestId('token-row-tok-1');

    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Laptop CLI' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Anything using this token will stop working straight away.')
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke token' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe(
        `${API}/users/me/tokens/tok-1`
      )
    );
    await waitFor(() => expect(screen.queryByTestId('token-row-tok-1')).not.toBeInTheDocument());
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
  });

  it("doesn't revoke when the confirm is cancelled", async () => {
    render(<AccessPage />);
    const row = await screen.findByTestId('token-row-tok-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Laptop CLI' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(screen.getByTestId('token-row-tok-1')).toBeInTheDocument();
  });

  it("shows the API's message when a token can't be created", async () => {
    createError = {
      status: 400,
      error: 'You already have 20 tokens. Revoke one you no longer use.',
    };
    render(<AccessPage />);
    await createToken('One too many');

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'You already have 20 tokens. Revoke one you no longer use.',
          color: 'red',
        })
      )
    );
    expect(screen.queryByTestId('new-token-panel')).not.toBeInTheDocument();
  });

  it('shows an error with a retry when the list fails to load', async () => {
    fetchMock.mockImplementation(() =>
      respond({ error: 'Database is having a moment' }, false, 500)
    );
    render(<AccessPage />);

    expect(await screen.findByText('Database is having a moment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a copyable events example with the token supplied on stdin', async () => {
    render(<AccessPage />);

    await screen.findByTestId('token-row-tok-1');
    const example = screen.getByTestId('integration-example');
    expect(example).toHaveTextContent('curl --config -');
    expect(example).toHaveTextContent(`${API}/events?after=0`);
    expect(example).toHaveTextContent('Authorization: Bearer YOUR_TIMDO_TOKEN');
    expect(example).toHaveTextContent("<<'CURL'");
    expect(screen.getByRole('link', { name: 'Integration guide' })).toHaveAttribute(
      'href',
      'https://github.com/tdobson/timdo/blob/main/docs/integrations.md'
    );
  });

  it('shows the setup steps with copyable commands and the source link', async () => {
    render(<AccessPage />);
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(steps).toHaveTextContent('git clone https://github.com/tdobson/timdo.git && cd timdo');
    expect(steps).toHaveTextContent('bin/timdo login');
    expect(steps).toHaveTextContent('bin/timdo whoami');
    expect(steps).toHaveTextContent('claude mcp add timdo -- node "$(pwd)/mcp/index.js"');
    expect(steps).toHaveTextContent('bin/timdo list do --mine');
    expect(steps).toHaveTextContent('bin/timdo activity -n 20');
    expect(steps).toHaveTextContent('bin/timdo ws list');
    expect(within(steps).getAllByRole('button', { name: 'Copy command' }).length).toBe(8);
    expect(screen.getByRole('link', { name: /source code/i })).toHaveAttribute(
      'href',
      'https://github.com/tdobson/timdo'
    );
  });
});
