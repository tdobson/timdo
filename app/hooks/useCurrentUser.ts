import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchCurrentUser } from '../lib/apiClient';
import type { CurrentUser } from '../types/project.types';

export const currentUserKeys = {
  all: ['users', 'me'] as const,
  me: (accountId: string | null) => [...currentUserKeys.all, accountId] as const,
};

/**
 * The signed-in user from `GET /users/me`, so the UI can tell "me" from collaborators.
 * Until the request lands it falls back to the session (the Auth0 id is the API user id).
 */
export function useCurrentUser() {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;

  const query = useQuery<CurrentUser>({
    queryKey: currentUserKeys.me(accountId),
    queryFn: ({ signal }) => fetchCurrentUser(token, signal),
    enabled: !!token && !!accountId,
    staleTime: 10 * 60 * 1000,
  });

  const fallback: CurrentUser | null = session?.user?.id
    ? { id: session.user.id, email: session.user.email || '', name: session.user.name }
    : null;
  const user = query.data ?? fallback;
  const userId = user?.id ?? null;

  const isMe = useCallback(
    (id: string | null | undefined) => !!id && !!userId && id === userId,
    [userId]
  );

  return {
    user,
    userId,
    isMe,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
