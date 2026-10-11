import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import {
  acceptInvite,
  addWorkspaceProject,
  changeMemberRole,
  createWorkspace,
  deleteWorkspace,
  fetchMe,
  fetchSharingOverview,
  removeMember,
  renameWorkspace,
  revokeInvite,
  searchPeople,
  sharePerson,
  updateWorkspaceProject,
} from '../lib/collaborationApi';
import type {
  InviteRole,
  ProjectContainerUpdate,
  SharingWorkspace,
  WorkspaceRole,
} from '../types/collaboration.types';
import { activityKeys } from './useActivityQueries';

/**
 * Sharing data lives under ['organisations'] so anything that invalidates workspaces
 * (here or elsewhere in the app) also refreshes the sharing page.
 */
export const sharingKeys = {
  all: ['organisations'] as const,
  overview: () => ['organisations', 'sharing'] as const,
  search: (orgId: string, query: string) =>
    ['organisations', 'people-search', orgId, query] as const,
};

export const meKeys = {
  me: ['users', 'me'] as const,
};

/** Every cache that can change when people or projects move between workspaces. */
const SHARED_KEYS = [
  ['organisations'],
  ['projects'],
  ['project-updates'],
  ['board-summary'],
  ['board-counts'],
  ['board-done-history'],
  ['board-full'],
  ['epics'],
  ['tasks'],
  ['customers'],
  ['task-search'],
  ['poster'],
] as const;

export function invalidateAfterSharingChange(
  queryClient: QueryClient,
  _scope: 'people' | 'projects' = 'projects'
) {
  // Membership and workspace moves can revoke access. Clear cached payloads before active
  // queries refetch so a failed authorization check cannot leave old task bodies on screen.
  for (const key of SHARED_KEYS) {
    void queryClient.resetQueries({ queryKey: [...key] });
  }
  void queryClient.resetQueries({ queryKey: activityKeys.all });
}

function useToken() {
  const { data: session } = useSession();
  return session?.accessToken;
}

function showError(title: string) {
  return (error: Error) => {
    notifications.show({
      title,
      message: error.message || 'Something went wrong. Please try again.',
      color: 'red',
    });
  };
}

/* ------------------------------------------------------------------ queries */

/** The signed-in user: `{ id, email, name }`. Used to show "You" in activity. */
export function useMe() {
  const token = useToken();
  return useQuery({
    queryKey: meKeys.me,
    queryFn: () => fetchMe(token),
    enabled: !!token,
    staleTime: 30 * 60 * 1000,
  });
}

/** Everything the sharing page needs: workspaces, people, invites and projects. */
export function useSharingOverview() {
  const token = useToken();
  return useQuery({
    queryKey: sharingKeys.overview(),
    queryFn: () => fetchSharingOverview(token),
    enabled: !!token,
    staleTime: 30 * 1000,
  });
}

/** People to add to a workspace. Needs 2+ characters. */
export function usePeopleSearch(orgId: string, query: string) {
  const token = useToken();
  const q = query.trim();
  return useQuery({
    queryKey: sharingKeys.search(orgId, q),
    queryFn: () => searchPeople(orgId, q, token),
    enabled: !!token && !!orgId && q.length >= 2,
    staleTime: 60 * 1000,
  });
}

/* ------------------------------------------------------------------ workspaces */

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: (name: string) => createWorkspace(name, token),
    onSuccess: (org) => {
      invalidateAfterSharingChange(queryClient, 'people');
      notifications.show({
        title: 'Workspace created',
        message: `${org.name} is ready. Add people and projects to share them.`,
        color: 'green',
      });
    },
    onError: showError('Could not create the workspace'),
  });
}

export function useRenameWorkspace() {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: ({ orgId, name }: { orgId: string; name: string }) =>
      renameWorkspace(orgId, name, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'projects');
      notifications.show({ message: 'Workspace renamed', color: 'green' });
    },
    onError: showError('Could not rename the workspace'),
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: (orgId: string) => deleteWorkspace(orgId, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'people');
      notifications.show({ message: 'Workspace deleted', color: 'green' });
    },
    onError: showError('Could not delete the workspace'),
  });
}

/* ------------------------------------------------------------------ people */

/**
 * Share a workspace with someone by email. The caller shows the result, because each of
 * the three outcomes (added, already_member, invited) needs different feedback.
 */
export function useSharePerson(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: InviteRole }) =>
      sharePerson(orgId, email, role, token),
    onSuccess: (result) => {
      if (result.status !== 'already_member') {
        invalidateAfterSharingChange(queryClient, 'people');
      }
    },
    onError: showError('Could not share'),
  });
}

export function useRevokeInvite(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: (inviteId: string) => revokeInvite(orgId, inviteId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharingKeys.all });
      queryClient.invalidateQueries({ queryKey: activityKeys.all });
      notifications.show({
        message: 'Invite cancelled. The link no longer works.',
        color: 'green',
      });
    },
    onError: showError('Could not cancel the invite'),
  });
}

/** Change someone's role. Updates the page straight away and rolls back if the server says no. */
export function useChangeRole(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      changeMemberRole(orgId, userId, role, token),
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: sharingKeys.overview() });
      const previous = queryClient.getQueryData<SharingWorkspace[]>(sharingKeys.overview());
      if (previous) {
        queryClient.setQueryData<SharingWorkspace[]>(
          sharingKeys.overview(),
          previous.map((ws) =>
            ws.id !== orgId
              ? ws
              : {
                  ...ws,
                  role: ws.members.some((m) => m.isMe && m.userId === userId) ? role : ws.role,
                  members: ws.members.map((m) => (m.userId === userId ? { ...m, role } : m)),
                }
          )
        );
      }
      return { previous };
    },
    onError: (error: Error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(sharingKeys.overview(), context.previous);
      }
      showError('Could not change the role')(error);
    },
    onSuccess: () => {
      notifications.show({ message: 'Role updated', color: 'green' });
    },
    onSettled: () => {
      invalidateAfterSharingChange(queryClient, 'people');
    },
  });
}

/** Remove someone, or leave yourself (pass your own id). */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: ({ userId }: { userId: string; leaving?: boolean; name?: string }) =>
      removeMember(orgId, userId, token),
    onSuccess: (_data, { leaving, name }) => {
      invalidateAfterSharingChange(queryClient, 'people');
      notifications.show({
        message: leaving
          ? 'You have left the workspace'
          : `${name || 'They'} can no longer see this workspace`,
        color: 'green',
      });
    },
    onError: (error: Error, { leaving }) =>
      showError(leaving ? 'Could not leave the workspace' : 'Could not remove them')(error),
  });
}

/* ------------------------------------------------------------------ projects */

export function useAddWorkspaceProject(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: (data: { name: string; description?: string | null }) =>
      addWorkspaceProject(orgId, data, token),
    onSuccess: (project) => {
      invalidateAfterSharingChange(queryClient, 'projects');
      notifications.show({ message: `Added the ${project.name} project`, color: 'green' });
    },
    onError: showError('Could not add the project'),
  });
}

export interface UpdateProjectVars {
  projectId: string;
  data: ProjectContainerUpdate;
  /** Shown in the success message */
  successMessage?: string;
}

/** Rename, archive/unarchive, or move a project to another workspace (`data.orgId`). */
export function useUpdateWorkspaceProject(orgId: string) {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: ({ projectId, data }: UpdateProjectVars) =>
      updateWorkspaceProject(orgId, projectId, data, token),
    onSuccess: (_result, { successMessage }) => {
      invalidateAfterSharingChange(queryClient, 'projects');
      notifications.show({ message: successMessage || 'Project updated', color: 'green' });
    },
    onError: showError('Could not update the project'),
  });
}

/* ------------------------------------------------------------------ invites */

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  const token = useToken();
  return useMutation({
    mutationFn: (inviteToken: string) => acceptInvite(inviteToken, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'projects');
    },
  });
}
