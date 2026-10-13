import { useEffect, useId, useMemo, useRef } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchActivity, fetchActivityPage } from '../lib/collaborationApi';
import type { ActivityFilters } from '../types/collaboration.types';

type CanonicalActivityFilters = {
  taskId: string | null;
  epicId: string | null;
  projectId: string | null;
  orgId: string | null;
};

export function canonicalActivityFilters(filters: ActivityFilters): CanonicalActivityFilters {
  return {
    taskId: filters.taskId || null,
    epicId: filters.epicId || null,
    projectId: filters.projectId || null,
    orgId: filters.orgId || null,
  };
}

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
  pagedAccount: (accountId: string | null) =>
    [...activityKeys.account(accountId), 'paged'] as const,
  paged: (accountId: string | null, filters: ActivityFilters) =>
    [
      ...activityKeys.pagedAccount(accountId),
      canonicalActivityFilters(filters),
      filters.limit ?? 50,
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

function combineActivityAbortSignals(
  querySignal: AbortSignal,
  ownershipSignal: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (querySignal.aborted || ownershipSignal.aborted) {
    abort();
  } else {
    querySignal.addEventListener('abort', abort, { once: true });
    ownershipSignal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      querySignal.removeEventListener('abort', abort);
      ownershipSignal.removeEventListener('abort', abort);
    },
  };
}

class ObsoleteActivityRequestError extends Error {
  constructor() {
    super('Activity request is no longer current');
    this.name = 'AbortError';
  }
}

class InvalidActivityCursorContinuationError extends Error {
  constructor() {
    super('invalid_cursor');
    this.name = 'InvalidActivityCursorContinuationError';
  }
}

function isInvalidActivityCursorResponse(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { status, message } = error as { status?: unknown; message?: unknown };
  return status === 400 && message === 'invalid_cursor';
}

function isActivityScopeFailure(error: unknown): boolean {
  if (error instanceof InvalidActivityCursorContinuationError) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return status === 403 || status === 404 || status === 409;
}

/** Cursor-backed pages used by the full Activity page; legacy feeds keep using `useActivity`. */
export function useActivityPages(filters: ActivityFilters, options: { enabled?: boolean } = {}) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const instanceId = useId();
  const cacheAccountId = accountId ?? `unscoped:${instanceId}`;
  const normalizedFilters = useMemo(
    () => canonicalActivityFilters(filters),
    [filters.taskId, filters.epicId, filters.projectId, filters.orgId]
  );
  const pageSize = filters.limit ?? 50;
  const requestFilters = useMemo(
    () => ({
      taskId: normalizedFilters.taskId ?? undefined,
      epicId: normalizedFilters.epicId ?? undefined,
      projectId: normalizedFilters.projectId ?? undefined,
      orgId: normalizedFilters.orgId ?? undefined,
      limit: pageSize,
    }),
    [normalizedFilters, pageSize]
  );
  const queryKey = useMemo(
    () => activityKeys.paged(cacheAccountId, requestFilters),
    [cacheAccountId, requestFilters]
  );
  const ownershipKey = JSON.stringify([cacheAccountId, normalizedFilters, pageSize]);
  const ownership = useRef({ key: ownershipKey, generation: 0, controller: new AbortController() });
  if (ownership.current.key !== ownershipKey) {
    ownership.current = {
      key: ownershipKey,
      generation: ownership.current.generation + 1,
      controller: new AbortController(),
    };
  }
  const requestGeneration = ownership.current.generation;
  const ownershipController = ownership.current.controller;
  const ownershipSignal = ownershipController.signal;
  useEffect(
    () => () => {
      if (ownership.current.controller !== ownershipController) {
        ownershipController.abort();
      }
    },
    [ownershipKey]
  );
  const queryClient = useQueryClient();
  const previousAccount = useRef(cacheAccountId);

  // Account-scoped pages are private. Discard the previous account's cache when identity changes.
  useEffect(() => {
    if (previousAccount.current === cacheAccountId) {
      return;
    }
    queryClient.removeQueries({ queryKey: activityKeys.pagedAccount(previousAccount.current) });
    previousAccount.current = cacheAccountId;
  }, [cacheAccountId, queryClient]);

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const combined = combineActivityAbortSignals(signal, ownershipSignal);
      try {
        const page = await fetchActivityPage(
          requestFilters,
          token,
          pageParam ?? undefined,
          combined.signal
        );
        // Some fetch implementations ignore AbortSignal. The generation also rejects A -> B -> A.
        if (combined.signal.aborted || ownership.current.generation !== requestGeneration) {
          throw new ObsoleteActivityRequestError();
        }
        return page;
      } catch (error) {
        if (combined.signal.aborted || ownership.current.generation !== requestGeneration) {
          throw new ObsoleteActivityRequestError();
        }
        if (pageParam != null && isInvalidActivityCursorResponse(error)) {
          throw new InvalidActivityCursorContinuationError();
        }
        throw error;
      } finally {
        combined.cleanup();
      }
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!token && !!accountId && (options.enabled ?? true),
    staleTime: 0,
    retry: false,
  });

  const isScopeFailure = isActivityScopeFailure(query.error);
  useEffect(() => {
    if (!isScopeFailure || !query.data) {
      return;
    }
    // Reset drops every old page and restarts from the first-page cursor.
    void queryClient.resetQueries({ queryKey, exact: true });
  }, [isScopeFailure, query.data, queryClient, queryKey]);

  return { ...query, isScopeFailure };
}
