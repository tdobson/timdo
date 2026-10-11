import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { canonicalRef, normaliseRole, parseRef } from '../../workers/src/lib/refs';
import { ApiError, apiFetch } from '../lib/apiClient';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';
import {
  captureTaskCacheScope,
  invalidateBoardCaches,
  isTaskCacheScopeCurrent,
  patchTaskViews,
  type TaskCacheScope,
} from '../lib/taskCache';
import type { RefInput, RefRole, RefView } from '../types/project.types';
import { notifyError } from './useProjectMutations';
import { projectKeys } from './useProjectQueries';

/**
 * Task refs (links to things outside TimDo) come with every task as `task.refs`, so there is
 * no separate list query: adding and removing patch the cached tasks straight away and then
 * refetch them. All ref mutations share one key so a burst of adds refetches once, at the end.
 */
export const refMutationKey = ['task-refs'] as const;

/** Display order on every surface: Source, About, Reported by, Link, then oldest first. */
export const REF_ROLE_ORDER: RefRole[] = ['source', 'about', 'reported_by', 'link'];

export function sortRefs(refs: RefView[]): RefView[] {
  return [...refs].sort(
    (a, b) =>
      REF_ROLE_ORDER.indexOf(a.role) - REF_ROLE_ORDER.indexOf(b.role) ||
      String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
  );
}

/**
 * An API failure from the refs endpoints. A source clash (409) carries the id of the task
 * that already has that source, so the UI can link to it.
 */
export class RefApiError extends ApiError {
  taskId: string | null;

  constructor(message: string, status: number, taskId: string | null = null) {
    super(message, status);
    this.name = 'RefApiError';
    this.taskId = taskId;
  }
}

async function readRefError(response: Response, fallback: string): Promise<RefApiError> {
  const text = await response.text().catch(() => '');
  let message = '';
  let taskId: string | null = null;
  try {
    const body = JSON.parse(text) as { error?: unknown; taskId?: unknown };
    if (typeof body.error === 'string') {
      message = body.error;
    }
    if (typeof body.taskId === 'string') {
      taskId = body.taskId;
    }
  } catch {
    // Not JSON, use the fallback
  }
  return new RefApiError(message || fallback, response.status, taskId);
}

const PENDING_PREFIX = 'pending-';

/** True while a ref is shown but the API has not stored it yet (it can't be removed yet). */
export function isPendingRef(ref: Pick<RefView, 'id'>): boolean {
  return ref.id.startsWith(PENDING_PREFIX);
}

export type AddedRef = RefView & { existing: boolean };

async function postRef(taskId: string, input: RefInput, token: string): Promise<AddedRef> {
  const response = await apiFetch(
    `${getWorkerApiBaseUrl()}/tasks/${encodeURIComponent(taskId)}/refs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    }
  );
  if (!response.ok) {
    throw await readRefError(response, 'Could not add that link');
  }
  return response.json();
}

async function deleteRef(taskId: string, refId: string, token: string): Promise<void> {
  const response = await apiFetch(
    `${getWorkerApiBaseUrl()}/tasks/${encodeURIComponent(taskId)}/refs/${encodeURIComponent(refId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    throw await readRefError(response, 'Could not remove that link');
  }
}

type RefChange = (refs: RefView[]) => RefView[];

/** Apply one idempotent ref change to TaskViews in legacy and board caches. */
async function patchRefs(
  queryClient: QueryClient,
  taskId: string,
  change: RefChange,
  cacheScope: TaskCacheScope
): Promise<void> {
  if (!isTaskCacheScopeCurrent(queryClient, cacheScope)) {
    return;
  }
  await Promise.all([
    queryClient.cancelQueries({ queryKey: projectKeys.all }),
    queryClient.cancelQueries({ queryKey: ['board-summary'] }),
    queryClient.cancelQueries({ queryKey: ['board-done-history'] }),
    queryClient.cancelQueries({ queryKey: ['board-full'] }),
  ]);
  if (!isTaskCacheScopeCurrent(queryClient, cacheScope)) {
    return;
  }
  patchTaskViews(
    queryClient,
    taskId,
    (task) => ({
      ...task,
      refs: sortRefs(change(task.refs || [])),
    }),
    cacheScope
  );
}

function settle(queryClient: QueryClient, cacheScope: TaskCacheScope) {
  if (!isTaskCacheScopeCurrent(queryClient, cacheScope)) {
    return;
  }
  // Only the last of several quick changes refetches, so earlier answers cannot undo later ones.
  if (queryClient.isMutating({ mutationKey: refMutationKey }) > 1) {
    return;
  }
  queryClient.invalidateQueries({ queryKey: projectKeys.all });
  queryClient.invalidateQueries({ queryKey: ['activity'] });
  queryClient.invalidateQueries({ queryKey: ['task-search'] });
  void invalidateBoardCaches(queryClient, cacheScope);
}

/**
 * Add a ref to a task (`POST /tasks/:id/refs`). It shows up at once, parsed with the same
 * parser the API uses. Errors are not toasted: the add form shows them next to the field,
 * and a source clash comes back as a {@link RefApiError} with the other task's id.
 */
export function useAddRef() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationKey: refMutationKey,
    mutationFn: ({ taskId, input }: { taskId: string; input: RefInput }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return postRef(taskId, input, session.accessToken);
    },
    onMutate: async ({ taskId, input }) => {
      const cacheScope = captureTaskCacheScope(queryClient, accountId);
      const parsed = parseRef(input.ref, input.kind);
      const role = normaliseRole(input.role);
      if (!parsed.ok || !role) {
        // The API will say what is wrong; nothing to show in the meantime
        return { tempId: null, cacheScope };
      }
      const tempId = `${PENDING_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { kind, ref, url, label } = parsed.value;
      const canonical = canonicalRef(parsed.value);
      const pending: RefView = {
        id: tempId,
        taskId,
        role,
        kind,
        ref,
        canonical,
        url: input.url || url,
        label: input.label || null,
        displayLabel: input.label || label,
        createdById: session?.user?.id ?? null,
        createdByName: session?.user?.name ?? null,
        createdAt: new Date().toISOString(),
        canDelete: true,
      };
      await patchRefs(
        queryClient,
        taskId,
        (refs) =>
          refs.some((ref) => ref.role === role && ref.canonical === canonical)
            ? refs
            : [...refs, pending],
        cacheScope
      );
      return { tempId, cacheScope };
    },
    onSuccess: async (added, { taskId }, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      const view: RefView = { ...added };
      delete (view as Partial<AddedRef>).existing;
      await patchRefs(
        queryClient,
        taskId,
        (refs) => {
          const others = refs.filter(
            (ref) =>
              ref.id !== context?.tempId &&
              ref.id !== view.id &&
              !(ref.role === view.role && ref.canonical === view.canonical)
          );
          return [...others, view];
        },
        context.cacheScope
      );
    },
    onError: async (_error, { taskId }, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      if (context?.tempId) {
        await patchRefs(
          queryClient,
          taskId,
          (refs) => refs.filter((ref) => ref.id !== context.tempId),
          context.cacheScope
        );
      }
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context) {
        settle(queryClient, context.cacheScope);
      }
    },
  });
}

/** Remove a ref by its id (`DELETE /tasks/:id/refs/:refId`). It disappears at once. */
export function useRemoveRef() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationKey: refMutationKey,
    mutationFn: ({ taskId, refId }: { taskId: string; refId: string }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return deleteRef(taskId, refId, session.accessToken);
    },
    onMutate: async ({ taskId, refId }) => {
      const cacheScope = captureTaskCacheScope(queryClient, accountId);
      const removedRefs: RefView[] = [];
      await patchRefs(
        queryClient,
        taskId,
        (refs) => {
          const removed = refs.find((ref) => ref.id === refId);
          if (removed && !removedRefs.some((ref) => ref.id === removed.id)) {
            removedRefs.push(removed);
          }
          return refs.filter((ref) => ref.id !== refId);
        },
        cacheScope
      );
      return { removedRef: removedRefs[0] || null, cacheScope };
    },
    onError: async (error, _variables, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      if (context?.removedRef) {
        const removedRef = context.removedRef;
        await patchRefs(
          queryClient,
          removedRef.taskId,
          (refs) => (refs.some((ref) => ref.id === removedRef.id) ? refs : [...refs, removedRef]),
          context.cacheScope
        );
      }
      notifyError('Could not remove link', error);
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context) {
        settle(queryClient, context.cacheScope);
      }
    },
  });
}
