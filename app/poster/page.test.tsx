import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import { useActiveTasksPoster } from '../hooks/useActiveTasksPoster';
import { useProjects } from '../hooks/useProjectQueries';
import { useWallOfDonePoster } from '../hooks/useWallOfDonePoster';
import PosterStudioPage from './page';

jest.mock('next-auth/react', () => ({
  useSession: jest.fn(() => ({
    data: { user: { name: 'Casey Example' }, accessToken: 'fake-token' },
    status: 'authenticated',
  })),
}));

jest.mock('../hooks/useWallOfDonePoster', () => ({
  useWallOfDonePoster: jest.fn(() => ({
    data: '<svg viewBox="0 0 100 100"><text>Wall of Done Test SVG</text></svg>',
    isLoading: false,
    isError: false,
  })),
}));

jest.mock('../hooks/useActiveTasksPoster', () => ({
  useActiveTasksPoster: jest.fn(() => ({
    data: '<svg viewBox="0 0 100 100"><text>Active Tasks Test SVG</text></svg>',
    isLoading: false,
    isError: false,
  })),
}));

jest.mock('../hooks/useProjectQueries', () => ({ useProjects: jest.fn() }));

jest.mock('../hooks/useGoalQueries', () => ({
  useGoals: jest.fn(() => ({
    data: [{ id: 'g1', title: 'Example goal', type: 'aim' }],
    isLoading: false,
    isError: false,
  })),
}));

const mockedUseProjects = jest.mocked(useProjects);
const mockedUseWallOfDonePoster = jest.mocked(useWallOfDonePoster);
const mockedUseActiveTasksPoster = jest.mocked(useActiveTasksPoster);

const ownTasks = [
  { id: 'p1', project: 'Example task 1', category: 'Home Projects', status: 'do', size: '***' },
  { id: 'p2', project: 'Example task 2', category: 'Trip Planning', status: 'do', size: '***' },
  {
    id: 'p3',
    project: 'Shared task',
    category: 'View-only workspace',
    status: 'do',
    size: '***',
    isMine: false,
  },
];

describe('PosterStudioPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseProjects.mockReturnValue({
      data: ownTasks,
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useProjects>);
  });

  it('renders title, poster options, actions, and categories from the user’s tasks', () => {
    render(<PosterStudioPage />);

    expect(screen.getByText('Poster Studio')).toBeInTheDocument();
    expect(screen.getByText('Wall of Done (6× A4)')).toBeInTheDocument();
    expect(screen.getByText('Active Tasks Readout')).toBeInTheDocument();
    expect(screen.getByText('Life Goals & Routines')).toBeInTheDocument();
    expect(screen.getByText('Download Master SVG')).toBeInTheDocument();
    expect(screen.getByText('Download 6× A4 Tiled Package')).toBeInTheDocument();
    expect(screen.getByText('Print (Laser Optimized)')).toBeInTheDocument();
    expect(screen.getByText('Fit to Screen')).toBeInTheDocument();

    expect(screen.getByText('All Categories')).toBeInTheDocument();
    expect(screen.getByText('Home Projects')).toBeInTheDocument();
    expect(screen.getByText('Trip Planning')).toBeInTheDocument();
    expect(screen.queryByText('View-only workspace')).not.toBeInTheDocument();
  });

  it('shows no category chips for an account with no tasks', () => {
    mockedUseProjects.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useProjects>);

    render(<PosterStudioPage />);

    expect(screen.getByText('All Categories')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('uses a selected custom category to filter both poster queries', () => {
    render(<PosterStudioPage />);

    fireEvent.click(screen.getByText('Home Projects'));

    expect(mockedUseWallOfDonePoster).toHaveBeenLastCalledWith(
      expect.objectContaining({ categories: ['Home Projects'] })
    );
    expect(mockedUseActiveTasksPoster).toHaveBeenLastCalledWith(
      expect.objectContaining({ categories: ['Home Projects'] })
    );
  });
});
