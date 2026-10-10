import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { notifications } from '@mantine/notifications';
import { addProjectUpdate, findSimilarTasks } from '../lib/apiClient';
import { notifyError } from './useProjectMutations';
import { projectKeys } from './useProjectQueries';

/** An open task that looks like a title being typed (`GET /tasks/similar`). */
export interface SimilarTask {
  id: string;
  shortId: string;
  title: string;
  status: string;
  projectId: string;
  projectName: string;
  orgId: string;
  orgName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** 0.5 to 1: the share of the title's useful words the task matches */
  score: number;
  /** Whether the current user can add a note or otherwise edit the task. */
  canEdit: boolean;
  matchedRef: boolean;
}

/** Wait this long after the last keystroke before asking. */
export const SIMILAR_DEBOUNCE_MS = 400;

/** Rows shown under the title. */
export const SIMILAR_LIMIT = 3;
export const MAX_SIMILAR_TITLE_LENGTH = 500;

export const similarKeys = {
  all: ['task-similar'] as const,
  query: (title: string, projectId: string | null, userId: string | null) =>
    [...similarKeys.all, userId, title, projectId] as const,
};

// The server uses this same fixed list before counting title words.
const STOP_WORDS = new Set(
  (
    'the and for with from that this these those into onto about above after again against ' +
    'are was were will would can could should shall may might must has have had having ' +
    'not but nor our ours your yours their theirs its his her hers him she they them you ' +
    'all any some each every both few more most other such only own same than then too ' +
    'very just also there here what when where which who whom whose why how been being ' +
    'does did doing done get got gets via per out off over under until while because ' +
    'need needs please one two lot lots thing things stuff etc'
  ).split(' ')
);
// Anything that isn't a letter or digit splits words, as on the server. Built with RegExp
// because the frontend's TypeScript target predates the u flag in regex literals.
const NOT_A_WORD = new RegExp('[^\\p{L}\\p{N}]+', 'u');

/** True when a title has at least two distinct significant words, as the API sees them. */
export function worthCheckingTitle(title: string): boolean {
  if (title.length > MAX_SIMILAR_TITLE_LENGTH) {
    return false;
  }
  const words = title
    .toLowerCase()
    .split(NOT_A_WORD)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return new Set(words).size >= 2;
}

/**
 * Open tasks that look like `title`, for a "did you mean" list while a task is being typed.
 * Waits for a pause in typing, drops a stale request when the title changes, and keeps the
 * last list on screen while the next one loads so it doesn't flicker. Scoped to the chosen
 * project's workspace, or every workspace when no project is picked yet.
 */
export function useSimilarTasks(
  title: string,
  { projectId = null, enabled = true }: { projectId?: string | null; enabled?: boolean } = {}
) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const userId = session?.user?.id ?? null;
  const typed = title.trim();
  // The title as it was when typing last paused; empty while switched off, so switching back
  // on waits for a fresh pause rather than asking about an old title
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    if (!enabled) {
      setDebounced('');
      return undefined;
    }
    const timer = setTimeout(() => setDebounced(typed), SIMILAR_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed, enabled]);

  // A title cut back to one word hides the list at once rather than after the pause
  const active =
    enabled && !!token && !!userId && worthCheckingTitle(typed) && worthCheckingTitle(debounced);

  const query = useQuery<SimilarTask[]>({
    queryKey: similarKeys.query(debounced, projectId, userId),
    queryFn: ({ signal }) =>
      findSimilarTasks<SimilarTask>(
        { title: debounced, projectId, limit: SIMILAR_LIMIT },
        token,
        signal
      ),
    enabled: active,
    staleTime: 30 * 1000,
    placeholderData: keepPreviousData,
  });

  const currentResults = active && typed === debounced && !query.isPlaceholderData;

  return {
    // Keep the layout responsive, but never let a previous title or project remain actionable.
    similar: currentResults ? (query.data ?? []) : [],
    isFetching: active && query.isFetching,
  };
}

/**
 * Add a note to an existing task instead of creating a near duplicate of it
 * (`POST /projects/:id/updates`). Toasts on success and failure.
 */
export function useAddNoteInstead() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  return useMutation({
    mutationFn: ({ task, note }: { task: SimilarTask; note: string }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return addProjectUpdate(task.id, { note }, session.accessToken);
    },
    onSuccess: (_update, { task }) => {
      queryClient.invalidateQueries({ queryKey: ['project-updates', task.id] });
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      queryClient.invalidateQueries({ queryKey: similarKeys.all });
      notifications.show({
        title: 'Note added',
        message: `Added to #${task.shortId} "${task.title}"`,
        color: 'green',
      });
    },
    onError: (error) => notifyError('Could not add note', error),
  });
}
