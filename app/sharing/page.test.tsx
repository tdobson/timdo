import React from 'react';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notifications } from '@mantine/notifications';
import { render } from '../../test-utils/render';
import type { InviteResult, SharingWorkspace, WorkspaceRole } from '../types/collaboration.types';
import SharingPage from './page';

jest.mock('@mantine/notifications', () => ({
  notifications: { show: jest.fn() },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => '/sharing',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

// The full sharing page is heavy to render, so allow for a slow or busy machine
configure({ asyncUtilTimeout: 10000 });
jest.setTimeout(120000);

const API = 'https://worker.example.com/api/v2';
const OWNER = 'user-1';
const MEMBER = 'user-2';
const VIEWER = 'user-3';

function personal(): SharingWorkspace {
  return {
    id: 'org-1',
    name: 'Personal Workspace',
    slug: 'casey',
    isPersonal: true,
    role: 'owner',
    memberCount: 1,
    projectCount: 1,
    createdBy: OWNER,
    members: [
      {
        userId: OWNER,
        userName: 'Casey Example',
        userEmail: 'casey@example.com',
        role: 'owner',
        isMe: true,
      },
    ],
    projects: [
      {
        id: 'proj-1',
        key: 'PER',
        name: 'Personal Project',
        description: null,
        isArchived: false,
        openTasks: 67,
        doneTasks: 169,
        epicCount: 4,
      },
    ],
    invites: [],
  };
}

function shared(myRole: WorkspaceRole): SharingWorkspace {
  const roles: Record<string, WorkspaceRole> = {
    [OWNER]: 'owner',
    [MEMBER]: 'member',
    [VIEWER]: 'viewer',
  };
  // "Me" is Casey when owner; otherwise Jordan holds myRole and Casey stays owner
  const meId = myRole === 'owner' ? OWNER : MEMBER;
  if (meId === MEMBER) {
    roles[MEMBER] = myRole;
  }
  return {
    id: 'org-2',
    name: 'Northstar Workshop',
    slug: 'northstar-workshop',
    isPersonal: false,
    role: myRole,
    memberCount: 3,
    projectCount: 2,
    createdBy: OWNER,
    members: [
      {
        userId: MEMBER,
        userName: 'Jordan Example',
        userEmail: 'jordan@example.com',
        role: roles[MEMBER],
        isMe: meId === MEMBER,
      },
      {
        userId: OWNER,
        userName: 'Casey Example',
        userEmail: 'casey@example.com',
        role: roles[OWNER],
        isMe: meId === OWNER,
      },
      {
        userId: VIEWER,
        userName: 'Alex Example',
        userEmail: 'alex@example.com',
        role: roles[VIEWER],
        isMe: false,
      },
    ],
    projects: [
      {
        id: 'proj-2',
        key: 'ACS',
        name: 'Acme Solar',
        description: null,
        isArchived: false,
        openTasks: 37,
        doneTasks: 9,
        epicCount: 2,
      },
      {
        id: 'proj-3',
        key: 'OLD',
        name: 'Old Stuff',
        description: null,
        isArchived: true,
        openTasks: 0,
        doneTasks: 3,
        epicCount: 0,
      },
    ],
    invites:
      myRole === 'owner'
        ? [
            {
              id: 'inv-1',
              email: 'new@example.com',
              role: 'member',
              token: 'tok-pending',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
          ]
        : [],
  };
}

let overview: SharingWorkspace[] = [];
let inviteResult: InviteResult;
let roleChangeError: string | null = null;
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
  roleChangeError = null;
  fetchMock.mockImplementation((url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    if (url === `${API}/organisations/sharing`) {
      return respond(overview);
    }
    if (url.startsWith(`${API}/users/me`)) {
      return respond({ id: OWNER, email: 'casey@example.com', name: 'Casey Example' });
    }
    if (method === 'POST' && /\/organisations\/[^/]+\/invites$/.test(url)) {
      return respond(inviteResult, true, 201);
    }
    if (method === 'PUT' && url.includes('/members/')) {
      return roleChangeError
        ? respond({ error: roleChangeError }, false, 403)
        : respond({ ok: true });
    }
    if (method === 'PUT' && url.includes('/projects/')) {
      return respond({ ok: true });
    }
    if (url.includes('/users/search')) {
      return respond([]);
    }
    return respond([]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function workspaceCard(id: string) {
  return screen.findByTestId(`workspace-card-${id}`);
}

describe('SharingPage', () => {
  it('lists the personal workspace first with its privacy note', async () => {
    overview = [shared('owner'), personal()];
    render(<SharingPage />);

    const cards = await screen.findAllByTestId(/^workspace-card-/);
    expect(cards[0]).toHaveAttribute('data-testid', 'workspace-card-org-1');
    expect(within(cards[0]).getByRole('heading', { name: 'Personal' })).toBeInTheDocument();
    expect(
      within(cards[0]).getByText('Only you can see this unless you share it')
    ).toBeInTheDocument();
    expect(
      within(cards[1]).getByText('Shared with Jordan Example and Alex Example')
    ).toBeInTheDocument();
  });

  it('lets an owner change anyone, including choosing Owner and Admin', async () => {
    overview = [shared('owner')];
    render(<SharingPage />);
    const card = await workspaceCard('org-2');

    const memberSelect = within(card).getByRole('textbox', { name: 'Role for Jordan Example' });
    await userEvent.click(memberSelect);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Owner'),
      expect.stringContaining('Admin'),
      expect.stringContaining('Member'),
      expect.stringContaining('Viewer'),
    ]);
    expect(within(card).getByRole('button', { name: 'Remove Jordan Example' })).toBeInTheDocument();
    // Sole owner can't demote themselves
    expect(
      within(card).queryByRole('textbox', { name: 'Role for Casey Example' })
    ).not.toBeInTheDocument();
    // Management controls are there
    expect(within(card).getByTestId('share-email-input')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /add project/i })).toBeInTheDocument();
  });

  it('only lets an admin change members and viewers, between member and viewer', async () => {
    overview = [shared('admin')];
    render(<SharingPage />);
    const card = await workspaceCard('org-2');

    // Casey is an owner: no select, no remove
    expect(
      within(card).queryByRole('textbox', { name: 'Role for Casey Example' })
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByRole('button', { name: 'Remove Casey Example' })
    ).not.toBeInTheDocument();
    expect(
      within(within(card).getByTestId(`member-row-${OWNER}`)).getByText('Owner')
    ).toBeInTheDocument();

    const viewerSelect = within(card).getByRole('textbox', { name: 'Role for Alex Example' });
    await userEvent.click(viewerSelect);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Member'),
      expect.stringContaining('Viewer'),
    ]);
    expect(within(card).getByRole('button', { name: 'Remove Alex Example' })).toBeInTheDocument();
  });

  it('shows a read-only view to viewers', async () => {
    overview = [shared('viewer')];
    render(<SharingPage />);
    const card = await workspaceCard('org-2');

    expect(within(card).getByText('Jordan Example')).toBeInTheDocument();
    expect(within(card).getByText('Acme Solar')).toBeInTheDocument();
    expect(within(card).queryAllByRole('textbox', { name: /^Role for/ })).toHaveLength(0);
    expect(within(card).queryByTestId('share-email-input')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /add project/i })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Rename/ })).not.toBeInTheDocument();
    // They can still leave
    expect(within(card).getByRole('button', { name: /leave/i })).toBeInTheDocument();
  });

  it('shows server errors when a role change is refused', async () => {
    overview = [shared('owner')];
    roleChangeError = 'A workspace needs at least one owner';
    render(<SharingPage />);
    const card = await workspaceCard('org-2');

    await userEvent.click(within(card).getByRole('textbox', { name: 'Role for Jordan Example' }));
    await userEvent.click(await screen.findByRole('option', { name: /Viewer/ }));

    await waitFor(() =>
      expect(notifications.show).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'A workspace needs at least one owner', color: 'red' })
      )
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall?.[0]).toBe(`${API}/organisations/org-2/members/${MEMBER}`);
    expect(JSON.parse(putCall?.[1].body)).toEqual({ role: 'viewer' });
  });

  describe('sharing with someone', () => {
    async function shareWith(email: string) {
      const card = await workspaceCard('org-2');
      fireEvent.change(within(card).getByTestId('share-email-input'), { target: { value: email } });
      await userEvent.click(within(card).getByRole('button', { name: 'Share' }));
      return card;
    }

    it('confirms when they were added straight away', async () => {
      overview = [shared('owner')];
      inviteResult = {
        status: 'added',
        userId: 'user-4',
        name: 'Taylor Example',
        email: 'taylor@example.com',
        role: 'member',
      };
      render(<SharingPage />);
      const card = await shareWith('taylor@example.com');

      expect(await within(card).findByTestId('share-result-added')).toHaveTextContent(
        'Taylor Example can now see Northstar Workshop'
      );
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toBe(`${API}/organisations/org-2/invites`);
      expect(JSON.parse(post?.[1].body)).toEqual({ email: 'taylor@example.com', role: 'member' });
    });

    it('says when they are already in the workspace', async () => {
      overview = [shared('owner')];
      inviteResult = {
        status: 'already_member',
        userId: MEMBER,
        email: 'jordan@example.com',
        role: 'member',
      };
      render(<SharingPage />);
      const card = await shareWith('jordan@example.com');

      expect(await within(card).findByTestId('share-result-already')).toHaveTextContent(
        'jordan@example.com is already in Northstar Workshop as member'
      );
    });

    it('shows a copyable invite link when they have no account yet', async () => {
      overview = [shared('owner')];
      inviteResult = {
        status: 'invited',
        id: 'inv-2',
        email: 'fresh@example.com',
        role: 'member',
        token: 'tok-123',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      render(<SharingPage />);
      const card = await shareWith('fresh@example.com');

      const result = await within(card).findByTestId('share-result-invited');
      expect(within(result).getByTestId('invite-link')).toHaveTextContent(
        'https://timdo.tdobson.net/invite/tok-123'
      );
      expect(result).toHaveTextContent('join Northstar Workshop automatically when they sign in');
      expect(within(result).getByRole('button', { name: /copy link/i })).toBeInTheDocument();
    });

    it('asks for an email address before sharing', async () => {
      overview = [shared('owner')];
      render(<SharingPage />);
      await shareWith('jordan');
      expect(
        await screen.findByText('Enter an email address, or pick someone from the list')
      ).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });
  });

  it('lists pending invites with copy and cancel', async () => {
    overview = [shared('owner')];
    render(<SharingPage />);
    const card = await workspaceCard('org-2');
    const row = within(card).getByTestId('invite-row-inv-1');
    expect(row).toHaveTextContent('new@example.com');
    expect(within(row).getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Cancel invite for new@example.com' })
    ).toBeInTheDocument();
  });

  it('explains who gains and loses access before moving a project', async () => {
    overview = [personal(), shared('owner')];
    render(<SharingPage />);
    const card = await workspaceCard('org-1');

    await userEvent.click(within(card).getByRole('button', { name: 'Actions for Personal Project' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /move to workspace/i }));

    // Only one possible destination, so it's preselected
    const impact = await screen.findByTestId('move-impact');
    expect(impact).toHaveTextContent(
      "Everyone in Northstar Workshop will be able to see its 236 tasks and 4 epics. People in Personal who aren't in Northstar Workshop will lose access."
    );
    expect(impact).toHaveTextContent('Gains access: Jordan Example and Alex Example');

    await userEvent.click(screen.getByRole('button', { name: 'Move to Northstar Workshop' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put?.[0]).toBe(`${API}/organisations/org-1/projects/proj-1`);
      expect(JSON.parse(put?.[1].body)).toEqual({ orgId: 'org-2' });
    });
  });

  it('shows archived projects with a badge', async () => {
    overview = [shared('owner')];
    render(<SharingPage />);
    const row = await screen.findByTestId('project-row-proj-3');
    expect(within(row).getByText('Archived')).toBeInTheDocument();
    expect(row).toHaveTextContent('0 open · 3 done · 0 epics');
  });
});
