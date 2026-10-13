import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSession } from 'next-auth/react';
import type { ActivityEntry } from '../../app/types/collaboration.types';
import { render } from '../../test-utils/render';
import { ActivityFeed } from './ActivityFeed';

const API = 'https://worker.example.test/api/v2';

function entry(id: string, summary = `Changed task ${id}`): ActivityEntry {
  return {
    id,
    actorId: 'user-2',
    actorName: 'Jordan Example',
    orgId: 'workspace-1',
    projectId: 'project-1',
    projectName: 'Workshop',
    entityType: 'task',
    entityId: `task-${id}`,
    taskId: `task-${id}`,
    epicId: null,
    action: 'updated',
    summary,
    changes: null,
    createdAt: '2026-10-11T09:00:00.000Z',
  };
}

function response(body: unknown, options: { status?: number; cursor?: string } = {}) {
  const status = options.status ?? 200;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'x-next-cursor' ? (options.cursor ?? null) : null,
    },
  });
}

const pagedFeed = (props: React.ComponentProps<typeof ActivityFeed>) => (
  <ActivityFeed {...props} paged />
);

function setSession(id: string, token: string) {
  (useSession as jest.Mock).mockReturnValue({
    data: {
      user: { id, email: `${id}@example.test`, name: 'Fictional User' },
      accessToken: token,
      expires: '1',
    },
    status: 'authenticated',
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  setSession('test-user-id', 'test-token');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('paged ActivityFeed', () => {
  it('loads older pages on demand, deduplicates IDs and hides cursor values', async () => {
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (parsed.searchParams.has('before')) {
        return response([entry('old'), entry('new', 'Updated again')]);
      }
      return response([entry('new')], { cursor: 'opaque-test-cursor' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({ orgId: 'workspace-1' }));

    expect(await screen.findByText('Jordan Example')).toBeInTheDocument();
    const getActivityCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/activity'));
    expect(getActivityCalls()).toHaveLength(1);
    const firstUrl = new URL(getActivityCalls()[0][0]);
    expect(firstUrl.pathname).toBe('/api/v2/activity');
    expect(firstUrl.searchParams.get('paged')).toBe('1');
    expect(firstUrl.searchParams.get('orgId')).toBe('workspace-1');
    expect(firstUrl.searchParams.has('before')).toBe(false);

    const loadOlder = screen.getByRole('button', { name: 'Load older activity' });
    loadOlder.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.getAllByTestId('activity-item')).toHaveLength(2));
    const nextUrl = new URL(getActivityCalls()[1][0]);
    expect(nextUrl.searchParams.get('before')).toBe('opaque-test-cursor');
    expect(nextUrl.searchParams.get('paged')).toBe('1');
    expect(screen.getByText("That's everything")).toBeInTheDocument();
    expect(screen.queryByText('opaque-test-cursor')).not.toBeInTheDocument();
  });

  it('keeps loaded rows after an ordinary older-page error and retries that page', async () => {
    let olderCalls = 0;
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (parsed.searchParams.has('before')) {
        olderCalls += 1;
        return olderCalls === 1
          ? response({ error: 'Temporary service problem' }, { status: 500 })
          : response([entry('old')]);
      }
      return response([entry('new')], { cursor: 'cursor-for-retry' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    await screen.findByText('Jordan Example');
    await userEvent.click(screen.getByRole('button', { name: 'Load older activity' }));

    expect(await screen.findByText('Temporary service problem')).toBeInTheDocument();
    expect(screen.getByText(/changed task new/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('activity-item')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByTestId('activity-item')).toHaveLength(2));
    expect(olderCalls).toBe(2);
  });

  it('clears old pages and starts over after a stale-cursor response', async () => {
    let initialCalls = 0;
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/activity')) {
        return response([]);
      }
      if (parsed.searchParams.has('before')) {
        return response({ error: 'Cursor scope changed' }, { status: 409 });
      }
      initialCalls += 1;
      return response([entry(initialCalls === 1 ? 'old-private-row' : 'fresh-row')], {
        cursor: initialCalls === 1 ? 'stale-cursor' : undefined,
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    await screen.findByText(/changed task old-private-row/i);
    await userEvent.click(screen.getByRole('button', { name: 'Load older activity' }));

    await screen.findByText(/changed task fresh-row/i);
    await waitFor(() =>
      expect(screen.queryByText(/changed task old-private-row/i)).not.toBeInTheDocument()
    );
    const activityCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/activity'));
    expect(
      activityCalls.map(([url]) => new URL(url).searchParams.get('before') ?? 'first')
    ).toEqual(['first', 'stale-cursor', 'first']);
    expect(initialCalls).toBe(2);
    expect(activityCalls).toHaveLength(3);
    expect(new URL(activityCalls[2][0]).searchParams.has('before')).toBe(false);
  });

  it('clears previously loaded rows after a permission failure', async () => {
    let initialCalls = 0;
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/activity')) {
        return response([]);
      }
      if (parsed.searchParams.has('before')) {
        return response({ error: 'You no longer have access' }, { status: 403 });
      }
      initialCalls += 1;
      return response([entry(initialCalls === 1 ? 'restricted-row' : 'current-row')], {
        cursor: initialCalls === 1 ? 'permission-cursor' : undefined,
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    await screen.findByText(/changed task restricted-row/i);
    await userEvent.click(screen.getByRole('button', { name: 'Load older activity' }));

    expect(await screen.findByText(/changed task current-row/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/changed task restricted-row/i)).not.toBeInTheDocument()
    );
    expect(initialCalls).toBe(2);
  });

  it('shows the loading skeleton while the first page is pending', async () => {
    let resolveFirstPage: ((value: Awaited<ReturnType<typeof response>>) => void) | undefined;
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/activity')) {
        return response([]);
      }
      return new Promise((resolve) => {
        resolveFirstPage = resolve;
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    expect(screen.getByLabelText('Loading activity')).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      resolveFirstPage?.(await response([entry('first-page-row')]));
    });
    expect(await screen.findByText(/changed task first-page-row/i)).toBeInTheDocument();
  });

  it('shows a first-page retry and handles empty history', async () => {
    let calls = 0;
    const fetchMock = jest.fn((url: string) => {
      if (!new URL(url).pathname.endsWith('/activity')) {
        return response([]);
      }
      calls += 1;
      return calls === 1
        ? response({ error: 'Try again in a moment' }, { status: 503 })
        : response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    expect(await screen.findByText('Try again in a moment')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older activity' })).not.toBeInTheDocument();
  });

  it('does not show a cursor or duplicate rows while loading an older page', async () => {
    let resolveOlder: ((value: Awaited<ReturnType<typeof response>>) => void) | undefined;
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      if (parsed.searchParams.has('before')) {
        return new Promise((resolve) => {
          resolveOlder = resolve;
        });
      }
      return response([entry('new')], { cursor: 'not-for-display' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    await screen.findByText(/changed task new/i);
    await userEvent.click(screen.getByRole('button', { name: 'Load older activity' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading older activity');
    expect(screen.getAllByTestId('activity-item')).toHaveLength(1);
    expect(screen.queryByText('not-for-display')).not.toBeInTheDocument();

    resolveOlder?.(await response([entry('old')]));
    await waitFor(() => expect(screen.getAllByTestId('activity-item')).toHaveLength(2));
  });

  it('keeps the paging action and long activity text usable in narrow layouts', async () => {
    const fetchMock = jest.fn((url: string) => {
      const parsed = new URL(url);
      return parsed.pathname.endsWith('/activity')
        ? response([entry('narrow-layout-row')], { cursor: 'private-cursor' })
        : response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(pagedFeed({}));
    await screen.findByText(/changed task narrow-layout-row/i);

    const button = screen.getByRole('button', { name: 'Load older activity' });
    expect(button).toHaveAttribute('data-block', 'true');
    expect(screen.getByTestId('activity-feed')).toHaveStyle({ minWidth: 0 });
    expect(screen.getByTestId('activity-item').querySelector('p')).toHaveStyle({
      overflowWrap: 'anywhere',
    });
  });

  it('discards late results after the signed-in account changes even when fetch ignores abort', async () => {
    let resolveOldAccount: ((value: Awaited<ReturnType<typeof response>>) => void) | undefined;
    const fetchMock = jest.fn((url: string, init: RequestInit = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/activity')) {
        const authorization = (init.headers as Record<string, string>).Authorization;
        if (authorization === 'Bearer account-a-token') {
          return new Promise((resolve) => {
            resolveOldAccount = resolve;
          });
        }
        return response([entry('account-b-row')]);
      }
      return response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    setSession('account-a', 'account-a-token');

    const view = render(pagedFeed({}));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/activity'))
      ).toHaveLength(1)
    );
    const oldSignal = fetchMock.mock.calls.find(([url]) => String(url).includes('/activity'))?.[1]
      ?.signal;
    expect(oldSignal).toBeDefined();

    setSession('account-b', 'account-b-token');
    view.rerender(pagedFeed({}));
    expect(await screen.findByText(/changed task account-b-row/i)).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      resolveOldAccount?.(await response([entry('account-a-row')]));
    });
    expect(screen.queryByText(/changed task account-a-row/i)).not.toBeInTheDocument();
    expect(screen.getByText(/changed task account-b-row/i)).toBeInTheDocument();
  });

  it('discards late results when filters change even when fetch ignores abort', async () => {
    let resolveOldFilter: ((value: Awaited<ReturnType<typeof response>>) => void) | undefined;
    const fetchMock = jest.fn<Promise<unknown>, [string, RequestInit?]>((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/activity')) {
        if (parsed.searchParams.get('orgId') === 'old-workspace') {
          return new Promise((resolve) => {
            resolveOldFilter = resolve;
          });
        }
        return response([entry('new-filter-row')]);
      }
      return response([]);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ActivityFeed paged orgId="old-workspace" />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes('/activity'))
      ).toHaveLength(1)
    );
    const oldSignal = fetchMock.mock.calls.find(([url]) => String(url).includes('/activity'))?.[1]
      ?.signal;
    expect(oldSignal).toBeDefined();

    view.rerender(<ActivityFeed paged orgId="new-workspace" />);
    expect(await screen.findByText(/changed task new-filter-row/i)).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      resolveOldFilter?.(await response([entry('old-filter-row')]));
    });
    expect(screen.queryByText(/changed task old-filter-row/i)).not.toBeInTheDocument();
    expect(screen.getByText(/changed task new-filter-row/i)).toBeInTheDocument();
  });
});
