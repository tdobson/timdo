import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import PosterStudioPage from './page';

// Mock next-auth/react
jest.mock('next-auth/react', () => ({
  useSession: jest.fn(() => ({
    data: { user: { name: 'Tim' }, accessToken: 'fake-token' },
    status: 'authenticated',
  })),
}));

// Mock hooks
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

jest.mock('../hooks/useProjectQueries', () => ({
  useProjects: jest.fn(() => ({
    data: [
      {
        id: 'p1',
        project: 'Active Project 1',
        status: 'do',
        size: '***',
      },
    ],
    isLoading: false,
    isError: false,
  })),
}));

jest.mock('../hooks/useGoalQueries', () => ({
  useGoals: jest.fn(() => ({
    data: [
      {
        id: 'g1',
        title: 'Strategic Aim 1',
        type: 'aim',
      },
    ],
    isLoading: false,
    isError: false,
  })),
}));

describe('PosterStudioPage', () => {
  it('renders title, segmented control options, and action buttons', () => {
    render(<PosterStudioPage />);

    // Title
    expect(screen.getByText('Poster Studio')).toBeInTheDocument();

    // 3 SegmentedControl options
    expect(screen.getByText('Wall of Done (6× A4)')).toBeInTheDocument();
    expect(screen.getByText('Active Tasks Readout')).toBeInTheDocument();
    expect(screen.getByText('Life Goals & Routines')).toBeInTheDocument();

    // Action buttons
    expect(screen.getByText('Download Master SVG')).toBeInTheDocument();
    expect(screen.getByText('Download 6× A4 Tiled Package')).toBeInTheDocument();
    expect(screen.getByText('Print (Laser Optimized)')).toBeInTheDocument();

    // Zoom toggle button
    expect(screen.getByText('Fit to Screen')).toBeInTheDocument();

    // Category Multi-Select Filter bar
    expect(screen.getByText('All Categories')).toBeInTheDocument();
    // With no tasks there are no project chips to offer: the filter is built from real tasks
    expect(screen.queryByText('Solfit')).not.toBeInTheDocument();
  });
});
