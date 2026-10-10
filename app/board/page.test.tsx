import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSession } from 'next-auth/react';
import { render } from '../../test-utils/render';
import type { Project } from '../types/project.types';
import BoardPage from './page';

// Mock next/navigation
const mockPush = jest.fn();
const mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useSearchParams: () => mockSearchParams,
}));

// Mock external dependencies
jest.mock('next-auth/react', () => {
  return {
    useSession: jest.fn(),
    signIn: jest.fn(),
    signOut: jest.fn(),
    SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

const useSessionMock = useSession as jest.Mock;

// Mock fetch
global.fetch = jest.fn();
const fetchMock = global.fetch as jest.Mock;
const WORKER_API_URL = 'https://worker.example.com/api/v2';

// Mock organisations hook: a personal workspace and one shared with Jordan
jest.mock('../hooks/useOrganisationQueries', () => ({
  ...jest.requireActual('../hooks/useOrganisationQueries'),
  useOrganisations: () => ({
    data: [
      { id: 'org-personal', name: 'Personal Workspace', isPersonal: true, memberCount: 1 },
      { id: 'org-2', name: 'Northstar Workshop', isPersonal: false, memberCount: 2 },
    ],
    isLoading: false,
    isError: false,
  }),
}));

/** Answer each API call by URL so extra queries (me, members, epics) don't steal responses. */
function mockApi(projects: unknown, projectsResponse?: Partial<Response>) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/projects')) {
      return Promise.resolve(projectsResponse ?? { ok: true, json: async () => projects });
    }
    if (url.endsWith('/users/me')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 'user-1', email: 'casey@example.com', name: 'Casey Example' }),
      });
    }
    if (url.includes('/organisations/org-2/members')) {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { userId: 'user-1', userName: 'Casey Example', userEmail: 'casey@example.com' },
          { userId: 'user-2', userName: 'Jordan Example', userEmail: 'jordan@example.com' },
        ],
      });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}

const mockProjects: Project[] = [
  {
    id: '1',
    project: 'Do Project',
    status: 'do',
    priority: 10,
    size: '*',
    category: 'Acme Solar',
    reason: '',
    notes: '',
    userId: 'user-1',
    isDeleted: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    statusLastChangedOn: '2024-01-01T00:00:00.000Z',
  },
  {
    id: '2',
    project: 'Delay Project',
    status: 'delay',
    priority: 5,
    size: '**',
    category: 'Personal',
    reason: '',
    notes: '',
    userId: 'user-1',
    isDeleted: false,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    statusLastChangedOn: '2024-01-02T00:00:00.000Z',
  },
  {
    id: '3',
    project: 'Done Project',
    status: 'done',
    priority: 1,
    size: '***',
    category: 'Acme Solar',
    reason: '',
    notes: '',
    userId: 'user-1',
    isDeleted: false,
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
    statusLastChangedOn: '2024-01-03T00:00:00.000Z',
  },
  {
    id: '4',
    project: 'Another Do Project',
    status: 'do',
    priority: 8,
    size: '****',
    category: 'Personal Project',
    reason: '',
    notes: '',
    userId: 'user-1',
    isDeleted: false,
    createdAt: '2024-01-04T00:00:00.000Z',
    updatedAt: '2024-01-04T00:00:00.000Z',
    statusLastChangedOn: '2024-01-04T00:00:00.000Z',
  },
];

describe('BoardPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = WORKER_API_URL;
    window.localStorage.clear();
    // Default to authenticated state for most tests
    useSessionMock.mockReturnValue({
      data: {
        user: { name: 'Test User' },
        accessToken: 'test-token',
      },
      status: 'authenticated',
    });
  });

  it('filters and sorts projects into their correct sections', async () => {
    // Arrange
    mockApi(mockProjects);

    // Act
    render(<BoardPage />);

    // Assert
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${WORKER_API_URL}/projects`,
        expect.objectContaining({ headers: expect.any(Object) })
      )
    );
    // Check "Do" section
    const doSection = await screen.findByTestId('section-do');
    expect(within(doSection).getByRole('heading', { name: 'Do' })).toBeInTheDocument();
    const doProjectControls = within(doSection).getAllByTestId(/project-card-control-/);
    expect(doProjectControls).toHaveLength(2);
    expect(within(doSection).getByText('Do Project')).toBeInTheDocument();
    expect(within(doSection).getByText('Another Do Project')).toBeInTheDocument();

    // Check "Delay" section
    const delaySections = await screen.findAllByTestId('section-delay');
    expect(delaySections.length).toBeGreaterThan(0);
    const delaySection = delaySections[0];
    expect(within(delaySection).getByRole('heading', { name: /Delay/ })).toBeInTheDocument();
    const delayProjectControls = within(delaySection).getAllByTestId(/project-card-control-/);
    expect(delayProjectControls).toHaveLength(1);
    expect(within(delaySection).getByText('Delay Project')).toBeInTheDocument();

    // Check "Done" section
    const doneSection = await screen.findByTestId('section-done');
    expect(within(doneSection).getByRole('heading', { name: /Done/ })).toBeInTheDocument();
    const doneProjectItems = await within(doneSection).findAllByTestId('done-project-item');
    expect(doneProjectItems).toHaveLength(1);
    expect(within(doneSection).getByText('Done Project')).toBeInTheDocument();
  });

  it('renders the awaiting section collapsed by default', async () => {
    const awaitingProjects: Project[] = [
      ...mockProjects,
      {
        id: '5',
        project: 'Awaiting Project',
        status: 'awaiting',
        priority: 4,
        size: '***',
        reason: '',
        notes: '',
        awaitUntil: '2026-08-03',
        userId: 'user-1',
        isDeleted: false,
        createdAt: '2024-01-05T00:00:00.000Z',
        updatedAt: '2024-01-05T00:00:00.000Z',
        statusLastChangedOn: '2024-01-05T00:00:00.000Z',
      },
    ];
    mockApi(awaitingProjects);

    render(<BoardPage />);

    const awaitingSection = await screen.findByTestId('section-awaiting');
    expect(within(awaitingSection).getByRole('heading', { name: /awaiting/i })).toBeInTheDocument();
    expect(within(awaitingSection).queryByText('Awaiting Project')).not.toBeInTheDocument();
  });

  it('allows the delay section to be collapsed and expanded', async () => {
    // Arrange
    mockApi(mockProjects);
    const user = userEvent.setup();

    // Act
    render(<BoardPage />);

    // Assert
    const delayHeading = await screen.findByRole('heading', { name: /Delay/i });
    expect(screen.getByText('Delay Project')).toBeInTheDocument();

    // Click to collapse
    await user.click(delayHeading);
    expect(screen.queryByText('Delay Project')).not.toBeInTheDocument();

    // Click to expand
    await user.click(delayHeading);
    expect(await screen.findByText('Delay Project')).toBeInTheDocument();
  });

  it('filters tasks when clicking category pills', async () => {
    mockApi(mockProjects);
    const user = userEvent.setup();

    render(<BoardPage />);

    // Click Acme Solar pill
    const acmeSolarPill = await screen.findByRole('button', { name: 'Acme Solar' });
    await user.click(acmeSolarPill);

    expect(mockPush).toHaveBeenCalledWith('/board?category=Acme%20Solar');
  });

  it('shows a loader while the session is loading', () => {
    // Arrange
    useSessionMock.mockReturnValue({ data: null, status: 'loading' });

    // Act
    render(<BoardPage />);

    // Assert
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('displays an error message if fetching projects fails', async () => {
    // Arrange
    const errorMessage = 'Failed to fetch';
    mockApi([], { ok: false, status: 500, json: async () => ({ error: errorMessage }) });

    // Act
    render(<BoardPage />);

    // Assert
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByText(`There was a problem fetching your projects: ${errorMessage}`)
    ).toBeInTheDocument();
  });

  it('renders the workspace selector with Personal and the Mine / Everyone control', async () => {
    mockApi(mockProjects);
    const user = userEvent.setup();

    render(<BoardPage />);

    const workspace = await screen.findByRole('textbox', { name: /workspace/i });
    expect(workspace).toHaveValue('All workspaces');
    await user.click(workspace);
    expect(await screen.findByRole('option', { name: 'Personal' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Northstar Workshop' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Personal Workspace' })).not.toBeInTheDocument();

    expect(screen.getByRole('radio', { name: 'Everyone' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Mine' })).toBeInTheDocument();
  });
});

describe('BoardPage with shared work', () => {
  const sharedTasks: Project[] = [
    {
      ...mockProjects[0],
      id: 'mine-1',
      project: 'My shared task',
      category: 'Acme Solar',
      orgId: 'org-2',
      orgName: 'Northstar Workshop',
      isShared: true,
      isMine: true,
      assigneeId: 'user-1',
      assigneeName: 'Casey Example',
    },
    {
      ...mockProjects[0],
      id: 'task-2',
      project: "Jordan's task",
      category: 'Acme Solar',
      orgId: 'org-2',
      orgName: 'Northstar Workshop',
      isShared: true,
      isMine: false,
      assigneeId: 'user-2',
      assigneeName: 'Jordan Example',
    },
    {
      ...mockProjects[3],
      id: 'personal-1',
      project: 'Personal errand',
      category: 'Personal Project',
      orgId: 'org-personal',
      orgName: 'Personal Workspace',
      isShared: false,
      isMine: true,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = WORKER_API_URL;
    useSessionMock.mockReturnValue({
      data: { user: { name: 'Casey Example', id: 'user-1' }, accessToken: 'test-token' },
      status: 'authenticated',
    });
  });

  it('shows everyone by default and filters to my tasks with Mine, remembering the choice', async () => {
    mockApi(sharedTasks);
    const user = userEvent.setup();

    render(<BoardPage />);

    expect(await screen.findByText("Jordan's task")).toBeInTheDocument();
    expect(screen.getByText('My shared task')).toBeInTheDocument();
    expect(screen.getByText('Personal errand')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Mine' }));

    await waitFor(() => expect(screen.queryByText("Jordan's task")).not.toBeInTheDocument());
    expect(screen.getByText('My shared task')).toBeInTheDocument();
    expect(screen.getByText('Personal errand')).toBeInTheDocument();
    expect(window.localStorage.getItem('timdo:assignee-scope')).toBe(JSON.stringify('mine'));
  });

  it('restores Mine from localStorage and explains an empty Mine view', async () => {
    window.localStorage.setItem('timdo:assignee-scope', JSON.stringify('mine'));
    // Jordan's view: everything shared, nothing of his own
    mockApi(sharedTasks.filter((t) => t.id === 'task-2').map((t) => ({ ...t, isMine: false })));
    const user = userEvent.setup();

    render(<BoardPage />);

    expect(
      await screen.findByText(
        "Nothing assigned to you yet. Switch to Everyone to see the whole team's work."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show everyone/i }));
    expect(await screen.findByText("Jordan's task")).toBeInTheDocument();
  });

  it('groups category pills by workspace and says who a workspace is shared with', async () => {
    mockApi(sharedTasks);

    render(<BoardPage />);

    const sharedLabel = await screen.findByTestId('workspace-label-org-2');
    expect(sharedLabel).toHaveTextContent('Northstar Workshop');
    expect(screen.getByTestId('workspace-label-org-personal')).toHaveTextContent('Personal');
    // Unassigned only makes sense once something is shared
    expect(screen.getByRole('radio', { name: 'Unassigned' })).toBeInTheDocument();
  });
});
