import React from 'react';
import { screen } from '@testing-library/react';
import { render } from '../../test-utils/render';
import type { ActivityEntry, SharingWorkspace } from '../types/collaboration.types';
import ActivityPage from './page';

const API = 'https://worker.example.test/api/v2';

const event: ActivityEntry = {
  id: 'event-1',
  actorId: 'user-2',
  actorName: 'Jordan Example',
  orgId: 'workspace-1',
  projectId: null,
  projectName: null,
  entityType: 'organisation',
  entityId: 'workspace-1',
  taskId: null,
  epicId: null,
  action: 'renamed',
  summary: 'Renamed a workspace',
  changes: null,
  createdAt: '2026-10-11T09:00:00.000Z',
};

const workspace: SharingWorkspace = {
  id: 'workspace-1',
  name: 'Workshop',
  slug: 'workshop',
  isPersonal: false,
  role: 'member',
  memberCount: 1,
  projectCount: 0,
  createdBy: 'user-1',
  members: [],
  projects: [],
  invites: [],
};

function response(body: unknown, cursor?: string) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-next-cursor' ? (cursor ?? null) : null),
    },
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_WORKER_API_BASE_URL = API;
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('uses the paged endpoint for the activity page and offers older records', async () => {
  const fetchMock = jest.fn((url: string) => {
    if (url.includes('/activity')) {
      return response([event], 'opaque-page-cursor');
    }
    if (url.endsWith('/organisations/sharing')) {
      return response([workspace]);
    }
    if (url.endsWith('/users/me')) {
      return response({ id: 'user-1', name: 'Casey Example' });
    }
    return response([]);
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<ActivityPage />);

  expect(await screen.findByText('Jordan Example')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Load older activity' })).toBeInTheDocument();

  const requests = fetchMock.mock.calls.filter(([url]) => String(url).includes('/activity'));
  expect(requests).toHaveLength(1);
  const activityUrl = new URL(requests[0][0]);
  expect(activityUrl.pathname).toBe('/api/v2/activity');
  expect(activityUrl.searchParams.get('paged')).toBe('1');
  expect(activityUrl.searchParams.get('limit')).toBe('50');
  expect(activityUrl.searchParams.has('before')).toBe(false);
});
