import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchBots } from '../lib/collaborationApi';
import type { SharingWorkspace } from '../types/collaboration.types';

export const botKeys = {
  all: ['bots'] as const,
  account: (accountId: string | null) => ['bots', accountId] as const,
  list: (accountId: string | null, orgId: string, access: 'manager' | 'read-only' = 'manager') =>
    [...botKeys.account(accountId), orgId, 'list', access] as const,
};

/** The manager-only bot list. Ordinary members see active bot identities via workspace members. */
export function useBotList(workspace: SharingWorkspace) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const canManageBots =
    !workspace.isPersonal && (workspace.role === 'owner' || workspace.role === 'admin');

  return useQuery({
    queryKey: botKeys.list(accountId, workspace.id, canManageBots ? 'manager' : 'read-only'),
    queryFn: ({ signal }) => fetchBots(workspace.id, token, signal),
    enabled: !!token && !!accountId && canManageBots,
    staleTime: 30 * 1000,
    gcTime: 0,
  });
}
