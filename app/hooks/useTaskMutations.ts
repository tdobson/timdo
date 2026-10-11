import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import { assignTask, fetchTasks, linkTaskGoal, type TaskFiltersClient } from '../lib/apiClient';
import {
  applyOptimisticTaskPatch,
  captureTaskCacheScope,
  invalidateBoardCaches,
  isTaskCacheScopeCurrent,
  patchTaskCaches,
  type TaskCacheScope,
} from '../lib/taskCache';
import type { Project } from '../types/project.types';
import { useCurrentUser } from './useCurrentUser';
import { projectKeys } from './useProjectQueries';

export const taskKeys = {
  all: ['tasks'] as const,
  lists: () => [...taskKeys.all, 'list'] as const,
  list: (filters?: TaskFiltersClient) => [...taskKeys.lists(), filters ?? {}] as const,
  detail: (id: string) => [...taskKeys.all, 'detail', id] as const,
};

/**
 * Fetch tasks query
 */
export function useTasks(filters?: TaskFiltersClient) {
  const { data: session } = useSession();

  return useQuery({
    queryKey: taskKeys.list(filters),
    queryFn: () => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return fetchTasks(filters, session.accessToken);
    },
    enabled: !!session?.accessToken,
  });
}

/** Optimistically update only TaskView caches and return an overlap-safe rollback. */
async function applyAssignee(
  queryClient: QueryClient,
  taskId: string,
  patch: Pick<Project, 'assigneeId' | 'assigneeName' | 'isMine'>,
  cacheScope: TaskCacheScope
): Promise<() => void> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: projectKeys.all }),
    queryClient.cancelQueries({ queryKey: taskKeys.all }),
    queryClient.cancelQueries({ queryKey: ['board-summary'] }),
    queryClient.cancelQueries({ queryKey: ['board-done-history'] }),
    queryClient.cancelQueries({ queryKey: ['board-full'] }),
  ]);
  return applyOptimisticTaskPatch(queryClient, taskId, patch, cacheScope);
}

function settle(
  queryClient: QueryClient,
  updated: Project | undefined,
  cacheScope: TaskCacheScope
) {
  if (!isTaskCacheScopeCurrent(queryClient, cacheScope)) {
    return;
  }
  if (updated) {
    patchTaskCaches(queryClient, updated, cacheScope);
  }
  queryClient.invalidateQueries({ queryKey: projectKeys.all });
  queryClient.invalidateQueries({ queryKey: taskKeys.all });
  queryClient.invalidateQueries({ queryKey: ['activity'] });
  void invalidateBoardCaches(queryClient, cacheScope, updated?.id);
}

/**
 * 1-click "Assign to me" with a snappy optimistic update
 */
export function useClaimTask() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;
  const { user } = useCurrentUser();

  return useMutation({
    mutationFn: (taskId: string) => {
      if (!session?.accessToken || !user?.id) {
        throw new Error('Not authenticated');
      }
      return assignTask(taskId, user.id, session.accessToken);
    },
    onMutate: async (taskId: string) => {
      const cacheScope = captureTaskCacheScope(queryClient, accountId);
      const rollback = await applyAssignee(
        queryClient,
        taskId,
        {
          assigneeId: user?.id ?? null,
          assigneeName: user?.name || 'You',
          isMine: true,
        },
        cacheScope
      );
      return { rollback, cacheScope };
    },
    onError: (err, _taskId, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      context?.rollback?.();
      void invalidateBoardCaches(queryClient, context?.cacheScope ?? accountId);
      notifications.show({
        title: 'Could not assign',
        message: err.message || 'Could not assign the task to you',
        color: 'red',
      });
    },
    onSuccess: (updatedTask, _variables, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      settle(queryClient, updatedTask, context.cacheScope);
      notifications.show({
        title: 'Assigned to you',
        message: `"${updatedTask.title || updatedTask.project || 'Task'}" is now yours`,
        color: 'green',
      });
    },
  });
}

/**
 * Assign a task to a workspace member (or null to unassign), with an optimistic update.
 * Pass `assigneeName` so cards update straight away.
 */
export function useAssignTask() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;
  const { userId } = useCurrentUser();

  return useMutation({
    mutationFn: ({
      taskId,
      assigneeId,
    }: {
      taskId: string;
      assigneeId: string | null;
      assigneeName?: string | null;
    }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return assignTask(taskId, assigneeId, session.accessToken);
    },
    onMutate: async ({ taskId, assigneeId, assigneeName }) => {
      const cacheScope = captureTaskCacheScope(queryClient, accountId);
      const rollback = await applyAssignee(
        queryClient,
        taskId,
        {
          assigneeId,
          assigneeName: assigneeId ? (assigneeName ?? null) : null,
          isMine: !!assigneeId && assigneeId === userId,
        },
        cacheScope
      );
      return { rollback, cacheScope };
    },
    onError: (err, _variables, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      context?.rollback?.();
      void invalidateBoardCaches(queryClient, context?.cacheScope ?? accountId);
      notifications.show({
        title: 'Could not reassign',
        message: err.message || 'Failed to reassign task',
        color: 'red',
      });
    },
    onSuccess: (updatedTask, _variables, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      settle(queryClient, updatedTask, context.cacheScope);
      notifications.show({
        title: 'Assignee updated',
        message: updatedTask.assigneeId
          ? `"${updatedTask.project}" is assigned to ${
              updatedTask.assigneeId === userId ? 'you' : updatedTask.assigneeName || 'them'
            }`
          : `"${updatedTask.project}" is now unassigned`,
        color: 'green',
      });
    },
  });
}

/**
 * Link Task to Personal Goal Mutation
 */
export function useLinkTaskGoal() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationFn: ({ taskId, goalId }: { taskId: string; goalId: string }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return linkTaskGoal(taskId, goalId, session.accessToken);
    },
    onMutate: () => ({ cacheScope: captureTaskCacheScope(queryClient, accountId) }),
    onSuccess: (_data, _variables, context) => {
      if (!isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: taskKeys.all });
      void invalidateBoardCaches(queryClient, context.cacheScope);
      notifications.show({
        title: 'Goal Linked',
        message: 'Personal life goal successfully linked to task',
        color: 'green',
      });
    },
    onError: (err: Error, _variables, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      notifications.show({
        title: 'Link Failed',
        message: err.message || 'Failed to link personal goal',
        color: 'red',
      });
    },
  });
}
