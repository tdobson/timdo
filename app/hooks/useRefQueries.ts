import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { canonicalRef, normaliseRole, parseRef } from '../../workers/src/lib/refs';
import { ApiError, apiFetch } from '../lib/apiClient';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';
import type { Project, RefInput, RefRole, RefView } from '../types/project.types';
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

type Snapshot = Array<[readonly unknown[], unknown]>;

/**
 * Apply `change` to the refs of one task wherever it is cached (the task list and its detail
 * entry). Returns a snapshot for rollback.
 */
async function patchRefs(
  queryClient: QueryClient,
  taskId: string,
  change: (refs: RefView[]) => RefView[]
): Promise<Snapshot> {
  await queryClient.cancelQueries({ queryKey: projectKeys.all });
  const snapshot: Snapshot = queryClient.getQueriesData({ queryKey: projectKeys.all });

  const patchOne = (task: Project) =>
    task.id === taskId ? { ...task, refs: sortRefs(change(task.refs || [])) } : task;
  queryClient.setQueriesData({ queryKey: projectKeys.all }, (old: unknown) => {
    if (Array.isArray(old)) {
      return (old as Project[]).map(patchOne);
    }
    if (old && typeof old === 'object' && (old as Project).id === taskId) {
      return patchOne(old as Project);
    }
    return old;
  });
  return snapshot;
}

function rollback(queryClient: QueryClient, snapshot?: Snapshot) {
  snapshot?.forEach(([key, data]) => queryClient.setQueryData(key, data));
}

function settle(queryClient: QueryClient) {
  // Only the last of several quick changes refetches, so earlier answers can't undo later ones
  if (queryClient.isMutating({ mutationKey: refMutationKey }) > 1) {
    return;
  }
  queryClient.invalidateQueries({ queryKey: projectKeys.all });
  queryClient.invalidateQueries({ queryKey: ['activity'] });
  queryClient.invalidateQueries({ queryKey: ['task-search'] });
}

/**
 * Add a ref to a task (`POST /tasks/:id/refs`). It shows up at once, parsed with the same
 * parser the API uses. Errors are not toasted: the add form shows them next to the field,
 * and a source clash comes back as a {@link RefApiError} with the other task's id.
 */
export function useAddRef() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationKey: refMutationKey,
    mutationFn: ({ taskId, input }: { taskId: string; input: RefInput }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return postRef(taskId, input, session.accessToken);
    },
    onMutate: async ({ taskId, input }) => {
      const parsed = parseRef(input.ref, input.kind);
      const role = normaliseRole(input.role);
      if (!parsed.ok || !role) {
        // The API will say what is wrong; nothing to show in the meantime
        return { snapshot: undefined, tempId: null };
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
      const snapshot = await patchRefs(queryClient, taskId, (refs) =>
        // Adding the same thing twice is a no-op on the server, so show it once
        refs.some((r) => r.role === role && r.canonical === canonical) ? refs : [...refs, pending]
      );
      return { snapshot, tempId };
    },
    onSuccess: (added, { taskId }, context) => {
      const view: RefView = { ...added };
      delete (view as Partial<AddedRef>).existing;
      void patchRefs(queryClient, taskId, (refs) => {
        const others = refs.filter((r) => r.id !== context?.tempId && r.id !== view.id);
        return [...others, view];
      });
    },
    onError: (_error, _variables, context) => {
      rollback(queryClient, context?.snapshot);
    },
    onSettled: () => settle(queryClient),
  });
}

/** Remove a ref by its id (`DELETE /tasks/:id/refs/:refId`). It disappears at once. */
export function useRemoveRef() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationKey: refMutationKey,
    mutationFn: ({ taskId, refId }: { taskId: string; refId: string }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return deleteRef(taskId, refId, session.accessToken);
    },
    onMutate: async ({ taskId, refId }) => {
      const snapshot = await patchRefs(queryClient, taskId, (refs) =>
        refs.filter((r) => r.id !== refId)
      );
      return { snapshot };
    },
    onError: (error, _variables, context) => {
      rollback(queryClient, context?.snapshot);
      notifyError('Could not remove link', error);
    },
    onSettled: () => settle(queryClient),
  });
}
