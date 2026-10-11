import type { Project, ProjectStatus } from '../types/project.types';

export type BoardGroupBy = 'none' | 'project' | 'epic' | 'assignee';

export interface BoardTaskGroup<T extends Project = Project> {
  id: string;
  label: string;
  isFallback: boolean;
  items: T[];
}

const GROUPING_VALUES = new Set<BoardGroupBy>(['none', 'project', 'epic', 'assignee']);

export function isBoardGroupBy(value: unknown): value is BoardGroupBy {
  return typeof value === 'string' && GROUPING_VALUES.has(value as BoardGroupBy);
}

/** An explicit invalid URL value means None; storage is only a fallback when the URL is absent. */
export function resolveBoardGrouping(
  urlValue: string | null | undefined,
  storedValue: string | null | undefined
): BoardGroupBy {
  if (urlValue !== null && urlValue !== undefined) {
    return isBoardGroupBy(urlValue) ? urlValue : 'none';
  }
  return isBoardGroupBy(storedValue) ? storedValue : 'none';
}

export function shouldExpandBoardSection(taskCount: number): boolean {
  return taskCount <= 15;
}

export function canDropBoardTask({
  project,
  targetStatus,
  targetProject,
  sourceGroupId,
  targetGroupId,
}: {
  project: Project;
  targetStatus: ProjectStatus;
  targetProject?: Project | null;
  sourceGroupId?: string | null;
  targetGroupId?: string | null;
}): boolean {
  if (project.canEdit === false || targetProject?.canEdit === false) {
    return false;
  }
  if (targetStatus === 'awaiting' && project.status !== 'awaiting') {
    return false;
  }
  if (targetProject && project.orgId !== targetProject.orgId) {
    return false;
  }
  if (sourceGroupId && targetGroupId && sourceGroupId !== targetGroupId) {
    return false;
  }
  return true;
}

export function updateBoardSearchParams(
  currentSearch: string,
  key: string,
  value: string | null
): string {
  const params = new URLSearchParams(
    currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch
  );
  if (value === null || value === '') {
    params.delete(key);
  } else {
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

interface RawGroup<T extends Project> {
  id: string;
  label: string;
  workspaceLabels: Set<string>;
  isFallback: boolean;
  items: T[];
}

function projectGroupId(task: Project): { id: string; label: string; isFallback: boolean } {
  if (task.projectId) {
    return {
      id: `project:${task.projectId}`,
      label: task.category || task.projectName || 'No project',
      isFallback: !task.category && !task.projectName,
    };
  }
  if (task.category || task.projectName) {
    const label = task.category || task.projectName || 'No project';
    return {
      id: `project-name:${task.orgId || 'personal'}:${label}`,
      label,
      isFallback: false,
    };
  }
  return { id: 'project:none', label: 'No project', isFallback: true };
}

function groupIdentity(
  task: Project,
  groupBy: BoardGroupBy,
  epicTitles: Record<string, string>
): { id: string; label: string; isFallback: boolean } {
  switch (groupBy) {
    case 'project':
      return projectGroupId(task);
    case 'epic':
      return task.epicId
        ? {
            id: `epic:${task.epicId}`,
            label: epicTitles[task.epicId] || `Epic ${task.epicId.slice(0, 8)}`,
            isFallback: false,
          }
        : { id: 'epic:none', label: 'No epic', isFallback: true };
    case 'assignee':
      return task.assigneeId
        ? {
            id: `assignee:${task.assigneeId}`,
            label: task.assigneeName || `Member ${task.assigneeId.slice(0, 8)}`,
            isFallback: false,
          }
        : { id: 'assignee:none', label: 'Unassigned', isFallback: true };
    default:
      return { id: 'all', label: 'All tasks', isFallback: false };
  }
}

/** Group a flat, already-filtered status section without changing task or cursor order. */
export function groupBoardTasks<T extends Project>(
  projects: T[],
  groupBy: BoardGroupBy,
  epicTitles: Record<string, string> = {}
): BoardTaskGroup<T>[] {
  const groups = new Map<string, RawGroup<T>>();
  for (const task of projects) {
    const identity = groupIdentity(task, groupBy, epicTitles);
    const group = groups.get(identity.id) || {
      ...identity,
      workspaceLabels: new Set<string>(),
      items: [],
    };
    const workspace = task.orgName?.trim();
    if (workspace) {
      group.workspaceLabels.add(workspace);
    }
    group.items.push(task);
    groups.set(identity.id, group);
  }

  const rows = Array.from(groups.values());
  const duplicateCounts = new Map<string, number>();
  const contextsByLabel = new Map<string, Set<string>>();
  rows.forEach((group) => {
    duplicateCounts.set(group.label, (duplicateCounts.get(group.label) || 0) + 1);
    const contexts = contextsByLabel.get(group.label) || new Set<string>();
    contexts.add(
      Array.from(group.workspaceLabels)
        .sort((a, b) => a.localeCompare(b))
        .join(', ')
    );
    contextsByLabel.set(group.label, contexts);
  });

  return rows
    .map((group) => {
      const duplicateCount = duplicateCounts.get(group.label) || 0;
      const duplicate = duplicateCount > 1;
      const contexts = Array.from(group.workspaceLabels).sort((a, b) => a.localeCompare(b));
      const context = contexts.join(', ');
      const uniqueWorkspaceContexts =
        (contextsByLabel.get(group.label)?.size || 0) === duplicateCount;
      const idSuffix = group.id.slice(group.id.lastIndexOf(':') + 1, group.id.lastIndexOf(':') + 9);
      let label = group.label;
      if (duplicate) {
        label =
          uniqueWorkspaceContexts && context
            ? `${label} (${context})`
            : `${label} (${context ? `${context}, ` : ''}${idSuffix})`;
      }
      return { ...group, label };
    })
    .sort(
      (a, b) =>
        Number(a.isFallback) - Number(b.isFallback) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id)
    )
    .map(({ workspaceLabels: _workspaceLabels, ...group }) => group);
}

/**
 * A small section is already bounded, so show all its groups. In a large grouped section only
 * the selected group is open; the caller raises `visibleLimit` explicitly with Show 50 more.
 */
export function getVisibleBoardTasks<T extends Project>(
  groups: BoardTaskGroup<T>[],
  sectionTaskCount: number,
  selectedGroupId: string | null,
  visibleLimit = 50
): T[] {
  if (sectionTaskCount <= 15) {
    return groups.flatMap((group) => group.items);
  }
  if (groups.length === 0) {
    return [];
  }
  const group = groups.find((candidate) => candidate.id === selectedGroupId) || groups[0];
  return group.items.slice(0, Math.max(0, visibleLimit));
}
