import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { fetchOrganisationMembers } from '../lib/apiClient';
import { fetchActivity, fetchBots, fetchSharingOverview } from '../lib/collaborationApi';
import type { SharingWorkspace } from '../types/collaboration.types';
import { activityKeys, useActivity } from './useActivityQueries';
import { botKeys, useBotList } from './useBotQueries';
import { organisationKeys, useOrganisationMembers } from './useOrganisationQueries';
import { sharingKeys, useSharingOverview } from './useSharingQueries';

jest.mock('next-auth/react', () => ({ useSession: jest.fn() }));
jest.mock('../lib/apiClient', () => ({
  fetchOrganisationMembers: jest.fn().mockResolvedValue([]),
}));
jest.mock('../lib/collaborationApi', () => ({
  fetchActivity: jest.fn().mockResolvedValue([]),
  fetchBots: jest.fn().mockResolvedValue([]),
  fetchSharingOverview: jest.fn().mockResolvedValue([]),
}));

const mockUseSession = useSession as unknown as jest.Mock;
const mockFetchActivity = fetchActivity as jest.MockedFunction<typeof fetchActivity>;
const mockFetchBots = fetchBots as jest.MockedFunction<typeof fetchBots>;
const mockFetchOrganisationMembers = fetchOrganisationMembers as jest.MockedFunction<
  typeof fetchOrganisationMembers
>;
const mockFetchSharingOverview = fetchSharingOverview as jest.MockedFunction<
  typeof fetchSharingOverview
>;

function makeSession(id: string, token: string) {
  return {
    data: {
      user: { id, name: `${id} Example`, email: `${id}@example.test` },
      accessToken: token,
      expires: '2099-01-01',
    },
  };
}

describe('account-scoped sharing and activity reads', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mockUseSession.mockReturnValue(makeSession('account-a', 'fictional-token-a'));
  });

  afterEach(() => queryClient.clear());

  it('keys activity data by account and forwards an abort signal to the read', async () => {
    const { result } = renderHook(() => useActivity({ orgId: 'org-1' }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = queryClient.getQueryCache().getAll()[0];
    expect(query.queryKey).toEqual(activityKeys.list('account-a', { orgId: 'org-1' }));
    expect(mockFetchActivity).toHaveBeenCalledWith(
      {
        orgId: 'org-1',
        taskId: undefined,
        epicId: undefined,
        projectId: undefined,
        limit: undefined,
      },
      'fictional-token-a',
      expect.any(AbortSignal)
    );
  });

  it('does not expose cached activity when a token session has no stable account identity', async () => {
    const filters = { orgId: 'org-1' };
    queryClient.setQueryData(activityKeys.list(null, filters), [
      { id: 'activity-from-another-session' },
    ]);
    mockUseSession.mockReturnValue({
      data: {
        user: { name: 'Unidentified session' },
        accessToken: 'fictional-token-without-account-id',
        expires: '2099-01-01',
      },
    });

    const { result } = renderHook(() => useActivity(filters), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.data).toBeUndefined();
    expect(mockFetchActivity).not.toHaveBeenCalled();
  });

  it('keys sharing overview by account and forwards its abort signal', async () => {
    const { result } = renderHook(() => useSharingOverview(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = queryClient.getQueryCache().getAll()[0];
    expect(query.queryKey).toEqual(sharingKeys.overview('account-a'));
    expect(mockFetchSharingOverview).toHaveBeenCalledWith(
      'fictional-token-a',
      expect.any(AbortSignal)
    );
  });

  it('keys bot lists by account and workspace and forwards an abort signal', async () => {
    const workspace: SharingWorkspace = {
      id: 'org-1',
      name: 'Northstar Workshop',
      slug: 'northstar-workshop',
      isPersonal: false,
      role: 'admin',
      memberCount: 1,
      projectCount: 0,
      createdBy: 'account-a',
      members: [],
      projects: [],
      invites: [],
    };
    const { result } = renderHook(() => useBotList(workspace), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = queryClient.getQueryCache().getAll()[0];
    expect(query.queryKey).toEqual(botKeys.list('account-a', 'org-1'));
    expect(mockFetchBots).toHaveBeenCalledWith(
      'org-1',
      'fictional-token-a',
      expect.any(AbortSignal)
    );
  });

  it('does not query the management endpoint for a workspace member', async () => {
    const workspace: SharingWorkspace = {
      id: 'org-1',
      name: 'Northstar Workshop',
      slug: 'northstar-workshop',
      isPersonal: false,
      role: 'member',
      memberCount: 1,
      projectCount: 0,
      createdBy: 'account-a',
      members: [],
      projects: [],
      invites: [],
    };
    queryClient.setQueryData(botKeys.list('account-a', 'org-1', 'manager'), [
      { id: 'bot|fixture', name: 'Forum watcher', tokens: [{ name: 'private token label' }] },
    ]);
    const { result } = renderHook(() => useBotList(workspace), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));

    expect(result.current.data).toBeUndefined();
    expect(mockFetchBots).not.toHaveBeenCalled();
  });

  it('scopes member lists by account and passes abort signals', async () => {
    const { result } = renderHook(() => useOrganisationMembers('org-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = queryClient.getQueryCache().getAll()[0];
    expect(query.queryKey).toEqual(organisationKeys.members('org-1', 'account-a'));
    expect(mockFetchOrganisationMembers).toHaveBeenCalledWith(
      'org-1',
      'fictional-token-a',
      expect.any(AbortSignal)
    );
  });
});
