import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { render } from '../test-utils/render';
import HomePage from './page';

// Mock next/navigation to prevent "invariant expected app router to be mounted" error
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

const useSessionMock = useSession as jest.Mock;

describe('HomePage', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    });
  });

  it('renders the hero section with main headline when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(
      screen.getByRole('heading', { name: /Life Management Without the Overwhelm/i })
    ).toBeInTheDocument();
  });

  it('renders the hero subtitle when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(
      screen.getByText(/Get everything out of your head and into a visual board/i)
    ).toBeInTheDocument();
  });

  it('renders CTA buttons when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    const getStartedButtons = screen.getAllByRole('button', { name: /Get Started/i });
    expect(getStartedButtons.length).toBeGreaterThan(0);

    const signInButtons = screen.getAllByRole('button', { name: /Sign In/i });
    expect(signInButtons.length).toBeGreaterThan(0);
  });

  it('renders the features section when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(
      screen.getByRole('heading', { name: /Finally, a tool that works the way you think/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/Print Your Progress/i)).toBeInTheDocument();
    expect(screen.getByText(/Speak, Don't Type/i)).toBeInTheDocument();
    expect(screen.getByText(/No Feature Bloat/i)).toBeInTheDocument();
  });

  it('renders the creator section when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(screen.getByText(/Built by someone who gets it/i)).toBeInTheDocument();
    expect(screen.getByText(/Made by Tim Dobson/i)).toBeInTheDocument();
  });

  it('renders the final CTA section when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(screen.getByText(/Ready to clear your head?/i)).toBeInTheDocument();
  });

  it('renders footer with links when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    expect(screen.getByText(/© 2025 Tim Dobson/i)).toBeInTheDocument();
  });

  it('does not render a link to the board page when unauthenticated', () => {
    // Act
    render(<HomePage />, { session: null });

    // Assert
    const boardLinks = screen.queryAllByRole('link', { name: /go to.*board/i });
    expect(boardLinks).toHaveLength(0);
  });
});

describe('HomePage onboarding gate (signed in)', () => {
  const WORKER_API_URL = 'https://worker.example.com/api/v2';
  const originalFetch = global.fetch;

  const mockApi = (tasks: unknown[], orgs: unknown[]) => {
    global.fetch = jest.fn((url: string) => {
      if (url.endsWith('/projects')) {
        return Promise.resolve({ ok: true, json: async () => tasks });
      }
      if (url.endsWith('/organisations')) {
        return Promise.resolve({ ok: true, json: async () => orgs });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    mockPush.mockClear();
    process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = WORKER_API_URL;
    useSessionMock.mockReturnValue({
      data: { user: { name: 'Casey Example', id: 'user-1' }, accessToken: 'token' },
      status: 'authenticated',
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends a brand new solo user to onboarding', async () => {
    mockApi([], [{ id: 'org-p', name: 'Casey Example', isPersonal: true, memberCount: 1 }]);

    render(<HomePage />);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/onboarding'));
  });

  it('sends someone invited to a shared workspace straight to the board, even with no tasks', async () => {
    mockApi(
      [],
      [
        { id: 'org-p', name: 'Casey Example', isPersonal: true, memberCount: 1 },
        { id: 'org-2', name: 'Northstar Workshop', isPersonal: false, memberCount: 2 },
      ]
    );

    render(<HomePage />);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
    expect(mockPush).not.toHaveBeenCalledWith('/onboarding');
  });

  it('sends anyone with tasks to the board', async () => {
    mockApi([{ id: 't1' }], [{ id: 'org-p', name: 'Casey Example', isPersonal: true, memberCount: 1 }]);

    render(<HomePage />);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/board'));
  });
});
