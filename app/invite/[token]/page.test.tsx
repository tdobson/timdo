import React from 'react';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signIn, useSession } from 'next-auth/react';
import { render } from '../../../test-utils/render';
import InvitePage from './page';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useParams: () => ({ token: 'tok-abc' }),
}));

configure({ asyncUtilTimeout: 10000 });

const API = 'https://worker.example.com/api/v2';
const useSessionMock = useSession as jest.Mock;
const fetchMock = jest.fn();

let acceptResponse: { ok: boolean; status: number; body: unknown };
let workspaces: unknown[];

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
  useSessionMock.mockReturnValue({
    data: { user: { name: 'Casey Example' }, accessToken: 'test-token', expires: '1' },
    status: 'authenticated',
  });
  workspaces = [
    { id: 'org-1', name: 'Personal Workspace', isPersonal: true, role: 'owner' },
    { id: 'org-2', name: 'Northstar Workshop', isPersonal: false, role: 'member' },
  ];
  fetchMock.mockImplementation((url: string) => {
    if (url === `${API}/organisations/invites/accept`) {
      return respond(acceptResponse.body, acceptResponse.ok, acceptResponse.status);
    }
    if (url === `${API}/organisations`) {
      return respond(workspaces);
    }
    return respond([]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('InvitePage (/invite/[token])', () => {
  it('accepts the invite once and says which workspace they joined', async () => {
    acceptResponse = {
      ok: true,
      status: 200,
      body: { success: true, orgId: 'org-2', role: 'member' },
    };
    render(<InvitePage />);

    expect(await screen.findByText("You've joined Northstar Workshop")).toBeInTheDocument();
    expect(screen.getByText(/You're a member: work on tasks, epics and notes/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your tasks' })).toHaveAttribute('href', '/');

    const acceptCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/invites/accept'));
    expect(acceptCalls).toHaveLength(1);
    expect(JSON.parse(acceptCalls[0][1].body)).toEqual({ token: 'tok-abc' });
    expect(acceptCalls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('explains an expired invite', async () => {
    acceptResponse = {
      ok: false,
      status: 400,
      body: { error: 'This invite has expired. Ask for a new one.' },
    };
    render(<InvitePage />);

    expect(await screen.findByText('This invite has expired')).toBeInTheDocument();
    expect(
      screen.getByText(/Ask whoever shared it with you to send a new one/)
    ).toBeInTheDocument();
  });

  it('reassures someone whose invite was already claimed when they signed in', async () => {
    acceptResponse = {
      ok: false,
      status: 400,
      body: { error: 'This invite link is invalid or has already been used' },
    };
    render(<InvitePage />);

    expect(await screen.findByText('This invite has already been used')).toBeInTheDocument();
    expect(screen.getByText(/You're in Northstar Workshop/)).toBeInTheDocument();
  });

  it('says a used link does not work when they are not in any shared workspace', async () => {
    workspaces = [{ id: 'org-1', name: 'Personal Workspace', isPersonal: true, role: 'owner' }];
    acceptResponse = {
      ok: false,
      status: 400,
      body: { error: 'This invite link is invalid or has already been used' },
    };
    render(<InvitePage />);

    await waitFor(() =>
      expect(screen.getByTestId('invite-error')).toHaveTextContent("This invite link doesn't work")
    );
  });

  it('asks signed-out visitors to sign in, without calling the API', async () => {
    useSessionMock.mockReturnValue({ data: null, status: 'unauthenticated' });
    render(<InvitePage />);

    expect(screen.getByText("You've been invited to TimDo")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(signIn).toHaveBeenCalledWith(
      'auth0',
      expect.objectContaining({ callbackUrl: expect.any(String) })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
