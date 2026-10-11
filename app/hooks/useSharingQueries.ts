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
  all: ['organisations', 'sharing'] as const,
  account: (accountId: string | null) => ['organisations', 'sharing', accountId] as const,
  overview: (accountId: string | null) => [...sharingKeys.account(accountId), 'overview'] as const,
  search: (accountId: string | null, orgId: string, query: string) =>
    [...sharingKeys.account(accountId), 'people-search', orgId, query] as const,
};

export const meKeys = {
  all: ['users', 'me'] as const,
  me: (accountId: string | null) => [...meKeys.all, accountId] as const,
};

/** Every cache that can change when people or projects move between workspaces. */
const SHARED_KEYS = [
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
  _scope: 'people' | 'projects' = 'projects',
  accountId: string | null = null
) {
  // Keep sharing, member and activity refreshes within the account that made the change.
  if (accountId) {
    void queryClient.resetQueries({ queryKey: sharingKeys.account(accountId) });
    void queryClient.resetQueries({ queryKey: ['organisations', accountId] });
    void queryClient.resetQueries({ queryKey: activityKeys.account(accountId) });
  } else {
    void queryClient.resetQueries({ queryKey: sharingKeys.all });
    void queryClient.resetQueries({ queryKey: activityKeys.all });
  }
  // Membership and workspace moves can revoke access. Clear cached payloads before active
  // queries refetch so a failed authorization check cannot leave old task bodies on screen.
  for (const key of SHARED_KEYS) {
    void queryClient.resetQueries({ queryKey: [...key] });
  }
}

function useIdentity() {
  const { data: session } = useSession();
  return {
    token: session?.accessToken,
    accountId: session?.user?.id || session?.user?.email || null,
  };
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
  const { token, accountId } = useIdentity();
  return useQuery({
    queryKey: meKeys.me(accountId),
    queryFn: ({ signal }) => fetchMe(token, signal),
    enabled: !!token && !!accountId,
    staleTime: 30 * 60 * 1000,
  });
}

/** Everything the sharing page needs: workspaces, people, invites and projects. */
export function useSharingOverview() {
  const { token, accountId } = useIdentity();
  return useQuery({
    queryKey: sharingKeys.overview(accountId),
    queryFn: ({ signal }) => fetchSharingOverview(token, signal),
    enabled: !!token && !!accountId,
    staleTime: 30 * 1000,
  });
}

/** People to add to a workspace. Needs 2+ characters. */
export function usePeopleSearch(orgId: string, query: string) {
  const { token, accountId } = useIdentity();
  const q = query.trim();
  return useQuery({
    queryKey: sharingKeys.search(accountId, orgId, q),
    queryFn: ({ signal }) => searchPeople(orgId, q, token, signal),
    enabled: !!token && !!accountId && !!orgId && q.length >= 2,
    staleTime: 60 * 1000,
  });
}

/* ------------------------------------------------------------------ workspaces */

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: (name: string) => createWorkspace(name, token),
    onSuccess: (org) => {
      invalidateAfterSharingChange(queryClient, 'people', accountId);
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
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: ({ orgId, name }: { orgId: string; name: string }) =>
      renameWorkspace(orgId, name, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'projects', accountId);
      notifications.show({ message: 'Workspace renamed', color: 'green' });
    },
    onError: showError('Could not rename the workspace'),
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: (orgId: string) => deleteWorkspace(orgId, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'people', accountId);
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
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: InviteRole }) =>
      sharePerson(orgId, email, role, token),
    onSuccess: (result) => {
      if (result.status !== 'already_member') {
        invalidateAfterSharingChange(queryClient, 'people', accountId);
      }
    },
    onError: showError('Could not share'),
  });
}

export function useRevokeInvite(orgId: string) {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: (inviteId: string) => revokeInvite(orgId, inviteId, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sharingKeys.account(accountId) });
      queryClient.invalidateQueries({ queryKey: activityKeys.account(accountId) });
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
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: WorkspaceRole }) =>
      changeMemberRole(orgId, userId, role, token),
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: sharingKeys.overview(accountId) });
      const previous = queryClient.getQueryData<SharingWorkspace[]>(
        sharingKeys.overview(accountId)
      );
      if (previous) {
        queryClient.setQueryData<SharingWorkspace[]>(
          sharingKeys.overview(accountId),
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
        queryClient.setQueryData(sharingKeys.overview(accountId), context.previous);
      }
      showError('Could not change the role')(error);
    },
    onSuccess: () => {
      notifications.show({ message: 'Role updated', color: 'green' });
    },
    onSettled: () => {
      invalidateAfterSharingChange(queryClient, 'people', accountId);
    },
  });
}

/** Remove someone, or leave yourself (pass your own id). */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: ({ userId }: { userId: string; leaving?: boolean; name?: string }) =>
      removeMember(orgId, userId, token),
    onSuccess: (_data, { leaving, name }) => {
      invalidateAfterSharingChange(queryClient, 'people', accountId);
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
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: (data: { name: string; description?: string | null }) =>
      addWorkspaceProject(orgId, data, token),
    onSuccess: (project) => {
      invalidateAfterSharingChange(queryClient, 'projects', accountId);
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
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: ({ projectId, data }: UpdateProjectVars) =>
      updateWorkspaceProject(orgId, projectId, data, token),
    onSuccess: (_result, { successMessage }) => {
      invalidateAfterSharingChange(queryClient, 'projects', accountId);
      notifications.show({ message: successMessage || 'Project updated', color: 'green' });
    },
    onError: showError('Could not update the project'),
  });
}

/* ------------------------------------------------------------------ invites */

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();
  return useMutation({
    mutationFn: (inviteToken: string) => acceptInvite(inviteToken, token),
    onSuccess: () => {
      invalidateAfterSharingChange(queryClient, 'projects', accountId);
    },
  });
}
