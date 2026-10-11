'use client';

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { SessionProvider, useSession } from 'next-auth/react';
import { setTaskCacheAccount } from '../app/lib/taskCache';

const useAccountEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Create a client with caching and sensible refetch policies to minimize API queries
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes fresh
      gcTime: 1000 * 60 * 30, // 30 minutes in cache
      refetchOnWindowFocus: false, // Don't refetch on tab switches
      refetchOnReconnect: false,
    },
  },
});

export function clearOnAccountChange(
  client: QueryClient,
  previousAccount: string | null | undefined,
  nextAccount: string | null
): string | null {
  if (previousAccount !== undefined && previousAccount !== nextAccount) {
    client.clear();
  }
  setTaskCacheAccount(client, nextAccount);
  return nextAccount;
}

function AccountCacheBoundary({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const client = useQueryClient();
  const previousAccount = useRef<string | null | undefined>(undefined);
  const account =
    status === 'loading'
      ? undefined
      : status === 'authenticated'
        ? session?.user?.id || session?.user?.email || null
        : null;

  useAccountEffect(() => {
    if (account !== undefined) {
      previousAccount.current = clearOnAccountChange(client, previousAccount.current, account);
    }
  }, [account, client]);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <AccountCacheBoundary>{children}</AccountCacheBoundary>
      </QueryClientProvider>
    </SessionProvider>
  );
}
