import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  getProjectById,
  getProjectCounts,
  getProjectList,
  getProjectPage,
  isAccessError,
} from '../lib/apiClient';
import type {
  ProjectCounts,
  ProjectDetail,
  ProjectListFilters,
  ProjectSummary,
} from '../types/project.types';

export type BoardMembershipFilters = Pick<
  ProjectListFilters,
  | 'category'
  | 'orgId'
  | 'projectId'
  | 'epicId'
  | 'goalId'
  | 'customer'
  | 'tag'
  | 'relatedTo'
  | 'assignee'
  | 'ref'
  | 'role'
  | 'shared'
  | 'noEpic'
  | 'noGoal'
  | 'noCategory'
  | 'unlinked'
>;

function canonicalFilters(filters: BoardMembershipFilters = {}): BoardMembershipFilters {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([a], [b]) => a.localeCompare(b))
  ) as BoardMembershipFilters;
}

export const boardQueryKeys = {
  summary: (accountId: string | null, filters: BoardMembershipFilters, doneSince: string) =>
    ['board-summary', accountId, canonicalFilters(filters), doneSince] as const,
  counts: (accountId: string | null, filters: BoardMembershipFilters) =>
    ['board-counts', accountId, canonicalFilters(filters)] as const,
  doneHistory: (
    accountId: string | null,
    filters: BoardMembershipFilters,
    doneBefore: string,
    revision = 0
  ) => ['board-done-history', accountId, canonicalFilters(filters), doneBefore, revision] as const,
  detail: (accountId: string | null, taskId: string) => ['board-full', accountId, taskId] as const,
};

function useBoardIdentity() {
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;
  return { accountId, token: session?.accessToken };
}

/** Open and recent-Done summaries only. Old Done rows are read through the separate archive query. */
export function useBoardSummaries(
  filters: BoardMembershipFilters,
  doneSince: string,
  enabled = true
) {
  const { accountId, token } = useBoardIdentity();
  const normalized = canonicalFilters(filters);

  return useQuery<ProjectSummary[], Error>({
    queryKey: boardQueryKeys.summary(accountId, normalized, doneSince),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return getProjectList<ProjectSummary>(
        {
          ...normalized,
          status: ['do', 'delay', 'awaiting', 'delegate', 'done'],
          doneSince,
          fields: 'summary',
        },
        token,
        signal
      );
    },
    enabled: !!token && !!accountId && enabled,
    staleTime: 30 * 1000,
  });
}

/** True counts use the server aggregate, including all-time Done. */
export function useBoardCounts(filters: BoardMembershipFilters, enabled = true) {
  const { accountId, token } = useBoardIdentity();
  const normalized = canonicalFilters(filters);

  return useQuery<ProjectCounts, Error>({
    queryKey: boardQueryKeys.counts(accountId, normalized),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return getProjectCounts(normalized, token, signal);
    },
    enabled: !!token && !!accountId && enabled,
    staleTime: 30 * 1000,
  });
}

/** Older completed tasks are fetched only when the person opens the archive. */
export function useBoardDoneHistory(
  filters: BoardMembershipFilters,
  doneBefore: string,
  enabled: boolean,
  revision = 0
) {
  const { accountId, token } = useBoardIdentity();
  const normalized = canonicalFilters(filters);

  return useInfiniteQuery({
    queryKey: boardQueryKeys.doneHistory(accountId, normalized, doneBefore, revision),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return getProjectPage<ProjectSummary>(
        {
          ...normalized,
          status: 'done',
          doneBefore,
          sort: 'completed',
          fields: 'summary',
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        token,
        signal
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!token && !!accountId && enabled,
    staleTime: 30 * 1000,
  });
}

/** A card only calls this hook while expanded; the request is abortable when it unmounts. */
export function useBoardProjectDetail(taskId: string, enabled = true) {
  const { accountId, token } = useBoardIdentity();

  return useQuery<ProjectDetail | null, Error>({
    queryKey: boardQueryKeys.detail(accountId, taskId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return getProjectById(taskId, token, signal);
    },
    enabled: !!token && !!accountId && !!taskId && enabled,
    retry: (failureCount, error) => !isAccessError(error) && failureCount < 2,
    staleTime: 30 * 1000,
  });
}
