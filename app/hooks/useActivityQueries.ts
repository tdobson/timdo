import { useId } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchActivity } from '../lib/collaborationApi';
import type { ActivityFilters } from '../types/collaboration.types';

/** Query keys for the activity log. Invalidate `activityKeys.all` after anything that logs. */
export const activityKeys = {
  all: ['activity'] as const,
  account: (accountId: string | null) => ['activity', accountId] as const,
  list: (accountId: string | null, filters: ActivityFilters) =>
    [
      ...activityKeys.account(accountId),
      {
        taskId: filters.taskId ?? null,
        epicId: filters.epicId ?? null,
        projectId: filters.projectId ?? null,
        orgId: filters.orgId ?? null,
        limit: filters.limit ?? null,
      },
    ] as const,
};

/**
 * Who did what, newest first, filtered by task, epic, project or workspace.
 * Keeps the previous page on screen while a bigger `limit` loads, so "Load more" doesn't flash.
 */
export function useActivity(filters: ActivityFilters, options: { enabled?: boolean } = {}) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const instanceId = useId();
  const cacheAccountId = accountId ?? `unscoped:${instanceId}`;

  return useQuery({
    queryKey: activityKeys.list(cacheAccountId, filters),
    queryFn: ({ signal }) => fetchActivity(filters, token, signal),
    enabled: !!token && !!accountId && (options.enabled ?? true),
    staleTime: 30 * 1000,
    // Only keep the old list on screen when just the limit grew, not when filters or account changed
    placeholderData: (previous, previousQuery) => {
      const previousAccountId = previousQuery?.queryKey?.[1];
      const prevFilters = previousQuery?.queryKey?.[2] as Record<string, unknown> | undefined;
      const nextFilters = activityKeys.list(accountId, filters)[2];
      const sameFilters =
        previousAccountId === cacheAccountId &&
        !!prevFilters &&
        prevFilters.taskId === nextFilters.taskId &&
        prevFilters.epicId === nextFilters.epicId &&
        prevFilters.projectId === nextFilters.projectId &&
        prevFilters.orgId === nextFilters.orgId;
      return sameFilters ? keepPreviousData(previous) : undefined;
    },
  });
}
