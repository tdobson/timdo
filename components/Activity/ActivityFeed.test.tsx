import React from 'react';
import { configure, screen, waitFor, within } from '@testing-library/react';
import type { ActivityEntry } from '../../app/types/collaboration.types';
import { render } from '../../test-utils/render';
import { ActivityFeed } from './ActivityFeed';
import { continueSentence, initials, parseTimestamp, relativeTime } from './activityFormat';

configure({ asyncUtilTimeout: 10000 });

const API = 'https://worker.example.com/api/v2';
const ME = { id: 'user-1', email: 'casey@example.com', name: 'Casey Example' };

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: Math.random().toString(36).slice(2),
    actorId: 'user-2',
    actorName: 'Jordan Example',
    orgId: 'org-1',
    projectId: 'proj-1',
    projectName: 'Acme Solar',
    entityType: 'task',
    entityId: 'task-1',
    taskId: 'task-1',
    epicId: null,
    action: 'status_changed',
    summary: 'Moved "Fix inverter" from Do to Done',
    changes: null,
    createdAt: minutesAgo(120),
    ...partial,
  };
}

let activity: ActivityEntry[] | 'error' = [];
const fetchMock = jest.fn();

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const respond = (body: unknown, ok = true, status = 200) =>
      Promise.resolve({
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
    if (url.startsWith(`${API}/users/me`)) {
      return respond(ME);
    }
    if (url.startsWith(`${API}/activity`)) {
      return activity === 'error'
        ? respond({ error: 'Database is having a nap' }, false, 500)
        : respond(activity);
    }
    if (url.startsWith(`${API}/organisations`)) {
      return respond([{ id: 'org-1', name: 'Northstar Workshop', isPersonal: false }]);
    }
    return respond([]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('ActivityFeed', () => {
  it('shows "You" for the signed-in user and the actor name for others', async () => {
    activity = [
      entry({ id: 'a1' }),
      entry({
        id: 'a2',
        actorId: ME.id,
        actorName: 'Casey Example',
        summary: 'Created "Order panels"',
      }),
    ];
    render(<ActivityFeed />);

    const items = await screen.findAllByTestId('activity-item');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Jordan Example')).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('Jordan Example moved “Fix inverter” from Do to Done');
    await waitFor(() => expect(within(items[1]).getByText('You')).toBeInTheDocument());
    expect(within(items[1]).queryByText('Casey Example')).not.toBeInTheDocument();
    expect(items[1]).toHaveTextContent('You created “Order panels”');
  });

  it('marks bot actors and distinguishes owner-secret and token provenance', async () => {
    activity = [
      entry({
        id: 'bot-token',
        actorId: 'bot|fixture',
        actorName: 'Forum watcher',
        actorKind: 'bot',
        via: 'token',
        viaDetail: 'nightly sync',
        summary: 'Created "Bot task"',
      }),
      entry({
        id: 'owner-secret',
        actorId: 'user-2',
        actorName: 'Jordan Example',
        actorKind: 'human',
        via: 'owner_secret',
        summary: 'Renamed "Workspace"',
      }),
    ];
    render(<ActivityFeed />);

    const items = await screen.findAllByTestId('activity-item');
    expect(within(items[0]).getByText('Forum watcher')).toBeInTheDocument();
    expect(within(items[0]).getByLabelText('Bot identity')).toBeInTheDocument();
    expect(items[0]).not.toHaveTextContent('nightly sync');
    expect(
      within(items[0]).getByRole('img', { name: 'Via token "nightly sync"' })
    ).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('(via owner secret)');
  });

  it('links task titles to the task page and shows the project badge', async () => {
    activity = [entry({ id: 'a1', taskId: 'task-42' })];
    render(<ActivityFeed />);

    const link = await screen.findByRole('link', { name: /Fix inverter/ });
    expect(link).toHaveAttribute('href', '/tasks/task-42');
    expect(screen.getByText('Acme Solar')).toBeInTheDocument();
  });

  it('links epic events to the epic page', async () => {
    activity = [
      entry({
        id: 'e1',
        taskId: null,
        epicId: 'epic-7',
        entityType: 'epic',
        summary: 'Created epic "Rollout"',
      }),
    ];
    render(<ActivityFeed />);
    const link = await screen.findByRole('link', { name: /Rollout/ });
    expect(link).toHaveAttribute('href', '/epics/epic-7');
  });

  it('gives the system actor a distinct icon instead of initials', async () => {
    activity = [
      entry({
        id: 's1',
        actorId: null,
        actorName: 'TimDo',
        summary: 'Brought "Chase invoice" back to Do (return date reached)',
      }),
    ];
    render(<ActivityFeed />);

    const item = await screen.findByTestId('activity-item');
    expect(within(item).getByTestId('activity-system-icon')).toBeInTheDocument();
    expect(item).toHaveTextContent('TimDo brought “Chase invoice” back to Do');
  });

  it('shows an empty state', async () => {
    activity = [];
    render(<ActivityFeed />);
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });

  it('shows a compact empty state', async () => {
    activity = [];
    render(<ActivityFeed taskId="task-1" compact title="Activity" />);
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('shows the server error with a retry button', async () => {
    activity = 'error';
    render(<ActivityFeed />);
    expect(await screen.findByText("Couldn't load activity")).toBeInTheDocument();
    expect(screen.getByText('Database is having a nap')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('passes its filters to the API and hides links back to the same task', async () => {
    activity = [entry({ id: 'a1', taskId: 'task-1' })];
    render(<ActivityFeed taskId="task-1" limit={5} compact />);

    await screen.findByTestId('activity-item');
    const activityCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/activity'));
    expect(activityCall?.[0]).toBe(`${API}/activity?taskId=task-1&limit=5`);
    expect(activityCall?.[1].headers.Authorization).toBe('Bearer test-token');
    // Already on this task: no self-link and no project badge
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Acme Solar')).not.toBeInTheDocument();
  });
});

describe('activityFormat', () => {
  it('formats initials, sentences and times', () => {
    expect(initials('Jordan Example')).toBe('JE');
    expect(initials('jordan@example.com')).toBe('JO');
    expect(initials('')).toBe('?');
    expect(continueSentence('Moved "X" to Done')).toBe('moved "X" to Done');
    expect(continueSentence('ACME Solar was renamed')).toBe('ACME Solar was renamed');
    const now = new Date('2026-10-08T12:00:00Z');
    expect(relativeTime(new Date('2026-10-08T11:59:50Z'), now)).toBe('just now');
    expect(relativeTime(new Date('2026-10-08T10:00:00Z'), now)).toBe('2h ago');
    expect(relativeTime(new Date('2026-10-06T12:00:00Z'), now)).toBe('2d ago');
    expect(parseTimestamp('2026-10-08 10:05:44')?.toISOString()).toBe('2026-10-08T10:05:44.000Z');
  });
});
