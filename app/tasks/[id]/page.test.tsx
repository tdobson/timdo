import React from 'react';
import { screen } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { render } from '../../../test-utils/render';
import type { Project } from '../../types/project.types';
import TaskDetailPage from './page';

// Mock next/navigation
const mockPush = jest.fn();
let mockParams = { id: 'task-123' };

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
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));

// Mock fetch
global.fetch = jest.fn();
const fetchMock = global.fetch as jest.Mock;
const WORKER_API_URL = 'https://worker.example.com/api/v2';

const mockTask: Project = {
  id: 'task-123',
  userId: 'user-123',
  project: 'Build Mars Rover',
  reason: 'Explore red planet',
  status: 'do',
  priority: 8,
  size: '***',
  notes: 'Check fuel cells',
  category: 'Personal',
  epicId: 'epic-1',
  goalId: 'goal-1',
  awaitUntil: null,
  gmailThreadId: 'thread-xyz',
  isDeleted: false,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
};

describe('TaskDetailPage', () => {
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
  });

  it('renders task details properly when task exists', async () => {
    fetchMock.mockImplementation((url: string) => {
      // The page loads just this task, not every task
      if (url.endsWith('/projects/task-123')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockTask,
        });
      }
      if (url.endsWith('/projects')) {
        return Promise.resolve({
          ok: true,
          json: async () => [mockTask],
        });
      }
      if (url.includes('/projects/task-123/updates')) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      }
      if (url.endsWith('/epics')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'epic-1', title: 'Rover Mission', category: 'Personal' }],
        });
      }
      if (url.endsWith('/goals')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'goal-1', title: 'Explore Space', type: 'aim' }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    mockParams = { id: 'task-123' };
    render(<TaskDetailPage />);

    expect(await screen.findByDisplayValue('Build Mars Rover')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Explore red planet')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Check fuel cells')).toBeInTheDocument();
    expect(screen.getByText('Back to Board')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `${WORKER_API_URL}/projects/task-123`,
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } })
    );
  });

  it('renders not found when task does not exist or is not shared with me', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/projects/non-existent')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ error: 'Task not found' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    mockParams = { id: 'non-existent' };
    render(<TaskDetailPage />);

    expect(await screen.findByText('Task Not Found')).toBeInTheDocument();
  });

  it('shows the API message when access is refused', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/projects/task-locked')) {
        return Promise.resolve({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: 'You have view-only access to "Acme Solar"' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    mockParams = { id: 'task-locked' };
    render(<TaskDetailPage />);

    expect(await screen.findByText('You have view-only access to "Acme Solar"')).toBeInTheDocument();
  });
});
