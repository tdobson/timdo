import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import { apiFetch, mergeProjects, readApiError } from '../lib/apiClient';
import { getWorkerApiBaseUrl } from '../lib/apiConfig';
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

/** Swap one task in the cached task list, leaving any non-list cache entries alone. */
function replaceInList(queryClient: QueryClient, updated: Project) {
  queryClient.setQueryData<Project[]>(projectKeys.all, (old) =>
    Array.isArray(old) ? old.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)) : old
  );
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

  return useMutation({
    mutationFn: (newProject: ProjectCreateInput) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return createProject(newProject, session.accessToken);
    },
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      queryClient.invalidateQueries({ queryKey: ['organisations'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
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
    onError: (error) => notifyError('Could not create task', error),
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

  return useMutation({
    mutationFn: (variables: { projectId: string; data: ProjectUpdateInput }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return updateProject(variables.projectId, variables.data, session.accessToken);
    },
    onSuccess: (updatedProject, variables) => {
      if (variables.data.isDeleted) {
        queryClient.setQueryData<Project[]>(projectKeys.all, (old) =>
          Array.isArray(old) ? old.filter((p) => p.id !== variables.projectId) : old
        );
      } else {
        replaceInList(queryClient, updatedProject);
        queryClient.setQueryData(projectKeys.detail(updatedProject.id), updatedProject);
      }
      queryClient.invalidateQueries({ queryKey: ['epics'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      notifications.show({
        title: variables.data.isDeleted ? 'Task deleted' : 'Task updated',
        message: variables.data.isDeleted
          ? `Deleted "${updatedProject.project}"`
          : `Saved "${updatedProject.project}"`,
        color: 'green',
      });
    },
    onError: (error) => {
      // Re-sync anything that was shown optimistically
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
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

  return useMutation({
    mutationFn: (updates: ProjectBatchUpdateInput) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return batchUpdateProjects(updates, session.accessToken);
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: projectKeys.all });
      const previousProjects = queryClient.getQueryData<Project[]>(projectKeys.all);

      queryClient.setQueryData<Project[]>(projectKeys.all, (old) => {
        if (!old) {
          return [];
        }
        const updatesMap = new Map(updates.map((u) => [u.id, u]));
        return old.map((p) => {
          const update = updatesMap.get(p.id);
          // The API skips rows I can't edit, so don't pretend they moved
          return update && p.canEdit !== false ? { ...p, ...update } : p;
        });
      });

      return { previousProjects };
    },
    onError: (error, _updates, context) => {
      if (context?.previousProjects) {
        queryClient.setQueryData(projectKeys.all, context.previousProjects);
      }
      notifyError('Could not save changes', error);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

// --- Merge Projects ---
export function useMergeProjects() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationFn: async ({ targetId, sourceId }: { targetId: string; sourceId: string }) => {
      return mergeProjects(targetId, sourceId, session?.accessToken);
    },
    onSuccess: (_, { targetId }) => {
      // ['projects'] also covers every cached single task
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['project-updates', targetId] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      notifications.show({
        title: 'Tasks Merged',
        message: 'The tasks were successfully combined.',
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Merge Failed',
        message: error.message || 'An error occurred while merging tasks.',
        color: 'red',
      });
    },
  });
}
