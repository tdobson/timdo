import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import {
  createOrganisation,
  fetchOrganisation,
  fetchOrganisationInvites,
  fetchOrganisationMembers,
  fetchOrganisations,
  inviteUser,
  removeMember,
  searchUsers,
  updateMemberRole,
} from '../lib/apiClient';
import type { InviteMemberInput, OrganisationCreateInput } from '../types/organisation.types';

// Query keys
export const organisationKeys = {
  all: ['organisations'] as const,
  account: (accountId: string | null) => ['organisations', accountId] as const,
  lists: (accountId: string | null) => [...organisationKeys.account(accountId), 'list'] as const,
  detail: (id: string, accountId: string | null) =>
    [...organisationKeys.account(accountId), 'detail', id] as const,
  members: (id: string, accountId: string | null) =>
    [...organisationKeys.account(accountId), 'members', id] as const,
  invites: (id: string, accountId: string | null) =>
    [...organisationKeys.account(accountId), 'invites', id] as const,
  userSearch: (id: string, query: string, accountId: string | null) =>
    [...organisationKeys.account(accountId), 'search', id, query] as const,
};

function useIdentity() {
  const { data: session } = useSession();
  return {
    token: session?.accessToken,
    accountId: session?.user?.id || session?.user?.email || null,
  };
}

/**
 * Fetch all organisations for current user
 */
export function useOrganisations() {
  const { token, accountId } = useIdentity();

  return useQuery({
    queryKey: organisationKeys.lists(accountId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return fetchOrganisations(token, signal);
    },
    enabled: !!token && !!accountId,
  });
}

/**
 * Fetch single organisation details
 */
export function useOrganisation(id: string) {
  const { token, accountId } = useIdentity();

  return useQuery({
    queryKey: organisationKeys.detail(id, accountId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return fetchOrganisation(id, token, signal);
    },
    enabled: !!token && !!accountId && !!id,
  });
}

/**
 * Fetch members of an organisation
 */
export function useOrganisationMembers(orgId: string) {
  const { token, accountId } = useIdentity();

  return useQuery({
    queryKey: organisationKeys.members(orgId, accountId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return fetchOrganisationMembers(orgId, token, signal);
    },
    enabled: !!token && !!accountId && !!orgId,
  });
}

/**
 * Fetch pending invites of an organisation
 */
export function useOrganisationInvites(orgId: string) {
  const { token, accountId } = useIdentity();

  return useQuery({
    queryKey: organisationKeys.invites(orgId, accountId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return fetchOrganisationInvites(orgId, token, signal);
    },
    enabled: !!token && !!accountId && !!orgId,
  });
}

/**
 * Search users for autocomplete
 */
export function useSearchUsers(orgId: string, query: string) {
  const { token, accountId } = useIdentity();

  return useQuery({
    queryKey: organisationKeys.userSearch(orgId, query, accountId),
    queryFn: ({ signal }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return searchUsers(orgId, query, token, signal);
    },
    enabled: !!token && !!accountId && !!orgId && query.trim().length > 0,
  });
}

/**
 * Create a new organisation
 */
export function useCreateOrganisation() {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();

  return useMutation({
    mutationFn: (data: OrganisationCreateInput) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return createOrganisation(data, token);
    },
    onSuccess: (newOrg) => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.account(accountId) });
      notifications.show({
        title: 'Organisation Created',
        message: `Successfully created "${newOrg.name}"`,
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Error',
        message: error.message || 'Failed to create organisation',
        color: 'red',
      });
    },
  });
}

/**
 * Invite a member to organisation
 */
export function useInviteMember(orgId: string) {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();

  return useMutation({
    mutationFn: (data: InviteMemberInput) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return inviteUser(orgId, data, token);
    },
    onSuccess: (invite) => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.invites(orgId, accountId) });
      notifications.show({
        title: 'Invitation Sent',
        message: `Invitation sent to ${invite.email}`,
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Invite Failed',
        message: error.message || 'Failed to send invitation',
        color: 'red',
      });
    },
  });
}

/**
 * Update member role
 */
export function useUpdateMemberRole(orgId: string) {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();

  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'member' }) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return updateMemberRole(orgId, userId, role, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.members(orgId, accountId) });
      notifications.show({
        title: 'Role Updated',
        message: 'Member role updated successfully',
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Update Failed',
        message: error.message || 'Failed to update member role',
        color: 'red',
      });
    },
  });
}

/**
 * Remove member
 */
export function useRemoveMember(orgId: string) {
  const queryClient = useQueryClient();
  const { token, accountId } = useIdentity();

  return useMutation({
    mutationFn: (userId: string) => {
      if (!token) {
        throw new Error('Not authenticated');
      }
      return removeMember(orgId, userId, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.members(orgId, accountId) });
      notifications.show({
        title: 'Member Removed',
        message: 'Member removed successfully',
        color: 'green',
      });
    },
    onError: (error: Error) => {
      notifications.show({
        title: 'Removal Failed',
        message: error.message || 'Failed to remove member',
        color: 'red',
      });
    },
  });
}
