import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { searchTasks } from '../lib/apiClient';

export interface SearchResult {
  id: string;
  shortId: string;
  title: string;
  reason?: string | null;
  status: string;
  priority: number;
  customer?: string | null;
  tags?: string | null;
  snippet?: string;
  score: number;
  projectId?: string | null;
  orgId?: string | null;
  assigneeId?: string | null;
  /** Project and workspace the task lives in, and who it's assigned to */
  projectName?: string | null;
  orgName?: string | null;
  assigneeName?: string | null;
  /** The query was a link or kind:id and this task carries it exactly (listed first) */
  matchedRef?: true;
}

/**
 * Full-text search over every task I can see, across all my workspaces.
 */
export function useTaskSearch(query: string, includeDone: boolean = false) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const trimmed = query.trim();

  return useQuery<SearchResult[]>({
    queryKey: ['task-search', trimmed, includeDone],
    queryFn: () => {
      if (trimmed.length < 2) {
        return Promise.resolve([]);
      }
      return searchTasks<SearchResult>(trimmed, includeDone, token);
    },
    enabled: !!token && trimmed.length >= 2,
    staleTime: 30 * 1000,
  });
}
