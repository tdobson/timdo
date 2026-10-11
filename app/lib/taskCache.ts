import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { Project, ProjectUpdate } from '../types/project.types';

const TASK_CACHE_ROOTS = new Set([
  'projects',
  'tasks',
  'board-summary',
  'board-done-history',
  'board-full',
]);
const BOARD_LIST_ROOTS = ['board-summary', 'board-counts'] as const;

export interface TaskCacheScope {
  accountId: string | null;
  epoch: number;
}
type AccountCacheState = TaskCacheScope;
type CacheAccount = string | null | undefined | TaskCacheScope;

const accountCacheStates = new WeakMap<QueryClient, AccountCacheState>();

/** Record the active account and advance its cache epoch whenever identity changes. */
export function setTaskCacheAccount(queryClient: QueryClient, accountId: string | null): number {
  const current = accountCacheStates.get(queryClient);
  if (!current) {
    accountCacheStates.set(queryClient, { accountId, epoch: 0 });
    return 0;
  }
  if (current.accountId !== accountId) {
    const next = { accountId, epoch: current.epoch + 1 };
    accountCacheStates.set(queryClient, next);
    return next.epoch;
  }
  return current.epoch;
}

/** Capture the account and epoch when a mutation begins, not when its response arrives. */
export function captureTaskCacheScope(
  queryClient: QueryClient,
  accountId: string | null | undefined
): TaskCacheScope {
  const normalizedAccountId = accountId ?? null;
  let current = accountCacheStates.get(queryClient);
  if (!current) {
    current = { accountId: normalizedAccountId, epoch: 0 };
    accountCacheStates.set(queryClient, current);
  }
  return { accountId: normalizedAccountId, epoch: current.epoch };
}

export function isTaskCacheScopeCurrent(queryClient: QueryClient, scope: TaskCacheScope): boolean {
  const current = accountCacheStates.get(queryClient);
  return !!current && current.accountId === scope.accountId && current.epoch === scope.epoch;
}

function cacheAccountId(account: CacheAccount): string | null | undefined {
  return account && typeof account === 'object' ? account.accountId : account;
}

function isCacheAccountCurrent(queryClient: QueryClient, account: CacheAccount): boolean {
  if (account === undefined) {
    return true;
  }
  if (account !== null && typeof account === 'object') {
    return isTaskCacheScopeCurrent(queryClient, account);
  }
  const current = accountCacheStates.get(queryClient);
  return !current || current.accountId === account;
}

type CacheQuery = ReturnType<QueryClient['getQueryCache']>['findAll'] extends (
  ...args: any[]
) => infer R
  ? R extends Array<infer T>
    ? T
    : never
  : never;

type TaskPatch = Partial<Project> & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Raw Tasks rows carry `title`; TaskView rows carry the user-facing `project` title. */
function isTaskView(value: unknown): value is Project {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.project === 'string' &&
    typeof value.status === 'string'
  );
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function withoutBody<T extends Record<string, unknown>>(patch: T): T {
  const result = { ...patch };
  delete result.notes;
  return result;
}

function mergeTaskView(current: Project, incoming: Project): Project {
  const source = hasOwn(current, 'notes') ? incoming : withoutBody(incoming as TaskPatch);
  return { ...current, ...source };
}

function mapTaskViews(data: unknown, taskId: string, update: (task: Project) => Project): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => (isTaskView(item) && item.id === taskId ? update(item) : item));
  }
  if (!isRecord(data)) {
    return data;
  }
  if (isTaskView(data)) {
    return data.id === taskId ? update(data) : data;
  }
  if (Array.isArray(data.pages)) {
    return { ...data, pages: data.pages.map((page) => mapTaskViews(page, taskId, update)) };
  }
  if (Array.isArray(data.items)) {
    return { ...data, items: mapTaskViews(data.items, taskId, update) };
  }
  return data;
}

function isSupportedCacheKey(queryKey: QueryKey): boolean {
  return typeof queryKey[0] === 'string' && TASK_CACHE_ROOTS.has(queryKey[0]);
}

function belongsToAccount(queryKey: QueryKey, accountId?: string | null): boolean {
  if (
    !accountId ||
    !['board-summary', 'board-counts', 'board-done-history', 'board-full'].includes(
      String(queryKey[0])
    )
  ) {
    return true;
  }
  return queryKey[1] === accountId;
}

function taskQueries(queryClient: QueryClient, account?: CacheAccount): CacheQuery[] {
  if (!isCacheAccountCurrent(queryClient, account)) {
    return [];
  }
  return queryClient
    .getQueryCache()
    .findAll()
    .filter(
      (query) =>
        isSupportedCacheKey(query.queryKey) &&
        belongsToAccount(query.queryKey, cacheAccountId(account))
    ) as CacheQuery[];
}

/** Apply an immutable change only to TaskView rows in recognised list, detail and page caches. */
export function patchTaskViews(
  queryClient: QueryClient,
  taskId: string,
  update: (task: Project) => Project,
  account?: CacheAccount
): void {
  taskQueries(queryClient, account).forEach((query) => {
    if (query.state.data === undefined) {
      return;
    }
    queryClient.setQueryData(query.queryKey, (old) => mapTaskViews(old, taskId, update));
  });
}

/** Reconcile one authoritative TaskView across recognised cache shapes, keeping summaries body-free. */
export function patchTaskCaches(
  queryClient: QueryClient,
  updated: Project,
  account?: CacheAccount
): void {
  patchTaskViews(queryClient, updated.id, (current) => mergeTaskView(current, updated), account);
}

/** Remove a task from list/page caches without assuming their totals or filter membership. */
export function removeTaskCaches(
  queryClient: QueryClient,
  taskId: string,
  account?: CacheAccount
): void {
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  taskQueries(queryClient, account).forEach((query) => {
    if (query.state.data === undefined) {
      return;
    }
    const filter = (data: unknown): unknown => {
      if (Array.isArray(data)) {
        return data.filter((item) => !isRecord(item) || item.id !== taskId);
      }
      if (!isRecord(data)) {
        return data;
      }
      if (data.id === taskId && (isTaskView(data) || typeof data.title === 'string')) {
        return undefined;
      }
      if (Array.isArray(data.pages)) {
        return { ...data, pages: data.pages.map(filter) };
      }
      if (Array.isArray(data.items)) {
        return { ...data, items: filter(data.items) };
      }
      return data;
    };
    queryClient.setQueryData(query.queryKey, filter(query.state.data));
  });
  queryClient.removeQueries({
    predicate: (query) =>
      belongsToAccount(query.queryKey, cacheAccountId(account)) &&
      ((query.queryKey[0] === 'board-full' && query.queryKey[2] === taskId) ||
        (query.queryKey[0] === 'projects' &&
          query.queryKey[1] === 'detail' &&
          query.queryKey[2] === taskId)),
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Apply a narrow optimistic patch and return a rollback that cannot erase a newer overlapping edit. */
export function applyOptimisticTaskPatch(
  queryClient: QueryClient,
  taskId: string,
  patch: TaskPatch,
  account?: CacheAccount
): () => void {
  const applied = withoutBody(patch as Record<string, unknown>);
  const snapshots = new Map<string, { queryKey: QueryKey; values: Record<string, unknown> }>();

  taskQueries(queryClient, account).forEach((query) => {
    if (query.state.data === undefined) {
      return;
    }
    const queryKey = query.queryKey;
    queryClient.setQueryData(queryKey, (old) =>
      mapTaskViews(old, taskId, (current) => {
        if (current.canEdit === false) {
          return current;
        }
        const values: Record<string, unknown> = {};
        Object.keys(applied).forEach((key) => {
          values[key] = (current as unknown as Record<string, unknown>)[key];
        });
        snapshots.set(JSON.stringify(queryKey), { queryKey, values });
        return { ...current, ...applied };
      })
    );
  });

  return () => {
    if (!isCacheAccountCurrent(queryClient, account)) {
      return;
    }
    snapshots.forEach(({ queryKey, values }) => {
      queryClient.setQueryData(queryKey, (old) =>
        mapTaskViews(old, taskId, (current) => {
          const result = { ...current } as Record<string, unknown>;
          Object.entries(applied).forEach(([key, appliedValue]) => {
            if (sameValue(result[key], appliedValue)) {
              const previous = values[key];
              if (previous === undefined && !hasOwn(current, key)) {
                delete result[key];
              } else {
                result[key] = previous;
              }
            }
          });
          return result as unknown as Project;
        })
      );
    });
  };
}

/** Invalidate every board membership result after a change whose filter impact is not knowable. */
export async function invalidateBoardCaches(
  queryClient: QueryClient,
  account?: CacheAccount,
  taskId?: string
): Promise<void> {
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  const accountId = cacheAccountId(account);
  const predicates = BOARD_LIST_ROOTS.map((root) => ({
    predicate: (query: { queryKey: QueryKey }) =>
      query.queryKey[0] === root && (!accountId || query.queryKey[1] === accountId),
  }));
  await Promise.all(predicates.map((filters) => queryClient.cancelQueries(filters)));
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  await Promise.all(predicates.map((filters) => queryClient.invalidateQueries(filters)));
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  const history = {
    predicate: (query: { queryKey: QueryKey }) =>
      query.queryKey[0] === 'board-done-history' && (!accountId || query.queryKey[1] === accountId),
  };
  await queryClient.cancelQueries(history);
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  await queryClient.resetQueries(history);
  if (!isCacheAccountCurrent(queryClient, account)) {
    return;
  }
  if (taskId) {
    const detail = {
      predicate: (query: { queryKey: QueryKey }) =>
        query.queryKey[0] === 'board-full' &&
        query.queryKey[2] === taskId &&
        (!accountId || query.queryKey[1] === accountId),
    };
    await queryClient.cancelQueries(detail);
    if (!isCacheAccountCurrent(queryClient, account)) {
      return;
    }
    await queryClient.invalidateQueries(detail);
  }
}

function lastNoteTime(updates: ProjectUpdate[]): string | null {
  const timestamps = updates
    .map((update) => update.createdAt)
    .filter((createdAt) => Number.isFinite(Date.parse(createdAt)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return timestamps[0] || null;
}

/** Update summary note metadata; deletion only recalculates the latest time from a loaded timeline. */
export function updateTaskNoteSummary(
  queryClient: QueryClient,
  taskId: string,
  change:
    | { type: 'added'; update: ProjectUpdate }
    | { type: 'deleted'; remaining?: ProjectUpdate[] },
  account?: CacheAccount
): void {
  taskQueries(queryClient, account).forEach((query) => {
    if (query.state.data === undefined) {
      return;
    }
    queryClient.setQueryData(query.queryKey, (old) =>
      mapTaskViews(old, taskId, (current) => {
        const count = typeof current.noteCount === 'number' ? current.noteCount : undefined;
        if (count === undefined) {
          return current;
        }
        const noteCount = change.type === 'added' ? count + 1 : Math.max(0, count - 1);
        const latest =
          change.type === 'added'
            ? lastNoteTime([change.update]) &&
              (!current.lastNoteAt ||
                Date.parse(change.update.createdAt) > Date.parse(current.lastNoteAt))
              ? change.update.createdAt
              : current.lastNoteAt
            : change.remaining
              ? lastNoteTime(change.remaining)
              : current.lastNoteAt;
        return { ...current, noteCount, lastNoteAt: latest } as Project;
      })
    );
  });
}
