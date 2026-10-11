import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import { apiFetch, mergeProjects, readApiError } from '../lib/apiClient';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';
import {
  applyOptimisticTaskPatch,
  captureTaskCacheScope,
  invalidateBoardCaches,
  isTaskCacheScopeCurrent,
  patchTaskCaches,
  removeTaskCaches,
} from '../lib/taskCache';
import type {
  Project,
  ProjectBatchUpdateInput,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '../types/project.types';
import { projectKeys } from './useProjectQueries';

/** Shows an API failure (e.g. `You do not have access to this shared project`) as a red toast. */
export function notifyError(title: string, error: unknown, fallback = 'Something went wrong.') {
  notifications.show({
    title,
    message: error instanceof Error && error.message ? error.message : fallback,
    color: 'red',
  });
}

// --- Create Project ---
async function createProject(projectData: ProjectCreateInput, token: string): Promise<Project> {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(projectData),
  });
  if (!response.ok) {
    throw await readApiError(response, 'Failed to create task');
  }
  return response.json();
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationFn: (newProject: ProjectCreateInput) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return createProject(newProject, session.accessToken);
    },
    onMutate: () => ({ cacheScope: captureTaskCacheScope(queryClient, accountId) }),
    onSuccess: (newProject, _variables, context) => {
      if (!isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      queryClient.invalidateQueries({ queryKey: ['organisations'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      void invalidateBoardCaches(queryClient, context.cacheScope);
      const where = newProject.category ? ` in ${newProject.category}` : '';
      const who =
        newProject.isShared && newProject.assigneeName && newProject.isMine === false
          ? `, assigned to ${newProject.assigneeName}`
          : '';
      notifications.show({
        title: 'Task created',
        message: `Added "${newProject.project}"${where}${who}`,
        color: 'green',
      });
    },
    onError: (error, _variables, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      notifyError('Could not create task', error);
    },
  });
}

async function updateProject(
  projectId: string,
  data: ProjectUpdateInput,
  token: string
): Promise<Project> {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/projects/${projectId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw await readApiError(response, 'Failed to update task');
  }
  return response.json();
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationFn: (variables: { projectId: string; data: ProjectUpdateInput }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return updateProject(variables.projectId, variables.data, session.accessToken);
    },
    onMutate: () => ({ cacheScope: captureTaskCacheScope(queryClient, accountId) }),
    onSuccess: (updatedProject, variables, context) => {
      if (!isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      if (variables.data.isDeleted) {
        removeTaskCaches(queryClient, variables.projectId, context.cacheScope);
      } else {
        patchTaskCaches(queryClient, updatedProject, context.cacheScope);
      }
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      void invalidateBoardCaches(queryClient, context.cacheScope, updatedProject.id);
      notifications.show({
        title: variables.data.isDeleted ? 'Task deleted' : 'Task updated',
        message: variables.data.isDeleted
          ? `Deleted "${updatedProject.project}"`
          : `Saved "${updatedProject.project}"`,
        color: 'green',
      });
    },
    onError: (error, _variables, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      void invalidateBoardCaches(queryClient, context?.cacheScope ?? accountId);
      notifyError('Could not save', error);
    },
  });
}

// --- Batch Update Projects ---
async function batchUpdateProjects(updates: ProjectBatchUpdateInput, token: string): Promise<void> {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/projects/batch-update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw await readApiError(response, 'Failed to save order');
  }
}

export function useBatchUpdateProjects() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationFn: (updates: ProjectBatchUpdateInput) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return batchUpdateProjects(updates, session.accessToken);
    },
    onMutate: async (updates) => {
      const cacheScope = captureTaskCacheScope(queryClient, accountId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: projectKeys.all }),
        queryClient.cancelQueries({ queryKey: ['board-summary'] }),
        queryClient.cancelQueries({ queryKey: ['board-done-history'] }),
        queryClient.cancelQueries({ queryKey: ['board-full'] }),
      ]);
      const rollbacks = updates.map((update) =>
        applyOptimisticTaskPatch(
          queryClient,
          update.id,
          { priority: update.priority, status: update.status },
          cacheScope
        )
      );
      return { rollbacks, cacheScope };
    },
    onError: (error, _updates, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      context?.rollbacks
        ?.slice()
        .reverse()
        .forEach((rollback) => rollback());
      notifyError('Could not save changes', error);
    },
    onSettled: (_data, _error, _updates, context) => {
      if (!context || !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      void invalidateBoardCaches(queryClient, context.cacheScope);
    },
  });
}

// --- Merge Projects ---
export function useMergeProjects() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;

  return useMutation({
    mutationFn: async ({ targetId, sourceId }: { targetId: string; sourceId: string }) => {
      return mergeProjects(targetId, sourceId, session?.accessToken);
    },
    onMutate: () => ({ cacheScope: captureTaskCacheScope(queryClient, accountId) }),
    onSuccess: (mergedProject, { targetId, sourceId }, context) => {
      if (!isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      patchTaskCaches(queryClient, mergedProject, context.cacheScope);
      removeTaskCaches(queryClient, sourceId, context.cacheScope);
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['project-updates', targetId] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      void invalidateBoardCaches(queryClient, context.cacheScope, targetId);
      notifications.show({
        title: 'Tasks Merged',
        message: 'The tasks were successfully combined.',
        color: 'green',
      });
    },
    onError: (error: Error, _variables, context) => {
      if (context && !isTaskCacheScopeCurrent(queryClient, context.cacheScope)) {
        return;
      }
      void invalidateBoardCaches(queryClient, context?.cacheScope ?? accountId);
      notifications.show({
        title: 'Merge Failed',
        message: error.message || 'An error occurred while merging tasks.',
        color: 'red',
      });
    },
  });
}
