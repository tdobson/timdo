import React from 'react';
import { screen } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { render } from '../../../test-utils/render';
import EpicDetailPage from './page';

// Mock next/navigation
const mockPush = jest.fn();
let mockParams = { id: 'epic-123' };

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
  useParams: () => mockParams,
}));

// Mock next-auth/react
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const useSessionMock = useSession as jest.Mock;

jest.mock('../../../components/Activity/ActivityFeed', () => ({
  ActivityFeed: ({ epicId }: { epicId?: string }) => (
    <div data-testid="activity-feed">activity for {epicId}</div>
  ),
}));

// Mock fetch
global.fetch = jest.fn();
const fetchMock = global.fetch as jest.Mock;
const WORKER_API_URL = 'https://worker.example.com/api/v2';

const mockEpic = {
  id: 'epic-123',
  userId: 'user-1',
  title: 'Build Autonomous Rover',
  description: 'Construct chassis, calibrate lidar, and deploy guidance software',
  category: 'Acme Solar',
  goalId: 'goal-1',
  status: 'active',
  totalTasks: 2,
  doneTasks: 1,
  progressPercentage: 50,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

const mockTasks = [
  {
    id: 'task-1',
    userId: 'user-1',
    project: 'Solder motor driver board',
    reason: 'Power distribution',
    status: 'done',
    priority: 8,
    size: '**',
    category: 'Acme Solar',
    epicId: 'epic-123',
    goalId: 'goal-1',
    isDeleted: false,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  },
  {
    id: 'task-2',
    userId: 'user-1',
    project: 'Calibrate lidar sensors',
    reason: 'Obstacle avoidance',
    status: 'do',
    priority: 9,
    size: '***',
    category: 'Acme Solar',
    epicId: 'epic-123',
    goalId: 'goal-1',
    isDeleted: false,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  },
];

describe('EpicDetailPage (/epics/[id])', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = WORKER_API_URL;
    useSessionMock.mockReturnValue({
      data: {
        user: { name: 'Test User' },
        accessToken: 'test-token',
      },
      status: 'authenticated',
    });

    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/epics/epic-123')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => mockEpic });
      }
      if (url.includes('/epics')) {
        return Promise.resolve({
          ok: true,
          json: async () => [mockEpic],
        });
      }
      if (url.includes('/projects') && !url.includes('/updates')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockTasks,
        });
      }
      if (url.includes('/goals')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'goal-1', title: 'Plan a community garden', type: 'aim' }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
  });

  it('renders epic details, progress bar, linked goal, and tasks with completion checkboxes', async () => {
    mockParams = { id: 'epic-123' };
    render(<EpicDetailPage />);

    // Title and description
    expect(await screen.findByText('Build Autonomous Rover')).toBeInTheDocument();
    expect(
      screen.getByText('Construct chassis, calibrate lidar, and deploy guidance software')
    ).toBeInTheDocument();

    // Progress bar & counts
    expect(screen.getByText('50% (1/2 tasks completed)')).toBeInTheDocument();

    // Linked goal badge
    expect(screen.getByText(/Plan a community garden/i)).toBeInTheDocument();

    // Task items
    expect(screen.getByText('Solder motor driver board')).toBeInTheDocument();
    expect(screen.getByText('Calibrate lidar sensors')).toBeInTheDocument();

    // Checkbox toggles
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it('renders awaiting task badge with return date if set', async () => {
    mockParams = { id: 'epic-123' };
    const tasksWithAwaiting = [
      ...mockTasks,
      {
        id: 'task-3',
        userId: 'user-1',
        project: 'Wait for PCB delivery',
        reason: 'Supplier delay',
        status: 'awaiting',
        priority: 7,
        size: '*',
        category: 'Acme Solar',
        epicId: 'epic-123',
        goalId: 'goal-1',
        awaitUntil: '2026-09-15',
        isDeleted: false,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    ];

    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/epics/epic-123')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => mockEpic });
      }
      if (url.includes('/epics')) {
        return Promise.resolve({
          ok: true,
          json: async () => [mockEpic],
        });
      }
      if (url.includes('/projects') && !url.includes('/updates')) {
        return Promise.resolve({
          ok: true,
          json: async () => tasksWithAwaiting,
        });
      }
      if (url.includes('/goals')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'goal-1', title: 'Plan a community garden', type: 'aim' }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    render(<EpicDetailPage />);
    expect(await screen.findByText('Wait for PCB delivery')).toBeInTheDocument();
    expect(screen.getByText(/⏳ Awaiting \(2026-09-15\)/i)).toBeInTheDocument();
  });

  it('shows a shared epic with its workspace, creator, assignees and activity, and hides its goal from non-creators', async () => {
    mockParams = { id: 'epic-123' };
    const sharedEpic = {
      ...mockEpic,
      isShared: true,
      orgName: 'Northstar Workshop',
      canEdit: true,
      createdById: 'bot|fixture',
      createdByName: 'Forum watcher',
      createdByKind: 'bot',
      // Jordan Example isn't the creator, so the API never sends him the goal
      goalId: null,
    };
    const sharedTasks = mockTasks.map((t) => ({
      ...t,
      isShared: true,
      canEdit: true,
      assigneeId: 'user-1',
      assigneeName: 'Casey Example',
    }));
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/epics/epic-123')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => sharedEpic });
      }
      if (url.endsWith('/users/me')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'user-2', email: 'jordan@example.com', name: 'Jordan Example' }),
        });
      }
      if (url.includes('/projects') && !url.includes('/updates')) {
        return Promise.resolve({ ok: true, json: async () => sharedTasks });
      }
      if (url.includes('/goals')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'goal-1', title: 'Plan a community garden', type: 'aim' }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    render(<EpicDetailPage />);

    expect(await screen.findByText('Build Autonomous Rover')).toBeInTheDocument();
    expect(screen.getByText('Northstar Workshop')).toBeInTheDocument();
    expect(screen.getByTestId('epic-attribution')).toHaveTextContent('Created by Forum watcher');
    expect(screen.getByLabelText('Bot identity')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Assigned to Casey Example' })).toHaveLength(2);
    expect(screen.queryByText(/Plan a community garden/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-feed')).toHaveTextContent('activity for epic-123');
  });

  it('disables editing for viewers', async () => {
    mockParams = { id: 'epic-123' };
    const viewOnlyEpic = { ...mockEpic, isShared: true, canEdit: false, orgName: 'Team' };
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/epics/epic-123')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => viewOnlyEpic });
      }
      if (url.includes('/projects') && !url.includes('/updates')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockTasks.map((t) => ({ ...t, isShared: true, canEdit: false })),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    render(<EpicDetailPage />);

    expect(await screen.findByRole('button', { name: /edit epic/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete epic/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add task to epic/i })).toBeDisabled();
    screen.getAllByRole('checkbox').forEach((box) => expect(box).toBeDisabled());
  });
});
