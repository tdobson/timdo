import { useLocalStorage } from '@mantine/hooks';
import type { Project } from '../types/project.types';

/** Which tasks to show: everything I can see, or only mine. */
export type AssigneeScope = 'everyone' | 'mine' | 'unassigned';

export const ASSIGNEE_SCOPE_STORAGE_KEY = 'timdo:assignee-scope';

/**
 * Mine / Everyone choice, remembered in localStorage. Defaults to Everyone.
 * Read in an effect so server and first client render match.
 */
export function useAssigneeScope() {
  return useLocalStorage<AssigneeScope>({
    key: ASSIGNEE_SCOPE_STORAGE_KEY,
    defaultValue: 'everyone',
    getInitialValueInEffect: true,
  });
}

/**
 * Client-side filter for the scope. "Mine" uses the API's `isMine` (assigned to me, or
 * unassigned and created by me). Older responses without `isMine` count as mine.
 */
export function filterByAssigneeScope<T extends Project>(tasks: T[], scope: AssigneeScope): T[] {
  if (scope === 'mine') {
    return tasks.filter((t) => t.isMine !== false);
  }
  if (scope === 'unassigned') {
    return tasks.filter((t) => !t.assigneeId);
  }
  return tasks;
}
