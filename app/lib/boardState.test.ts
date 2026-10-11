import type { Project } from '../types/project.types';
import {
  canDropBoardTask,
  getVisibleBoardTasks,
  groupBoardTasks,
  resolveBoardGrouping,
  shouldExpandBoardSection,
  updateBoardSearchParams,
  type BoardGroupBy,
} from './boardState';

const task = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  project: `Task ${id}`,
  status: 'do',
  priority: 5,
  size: '**',
  userId: 'user-a',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('board state', () => {
  it('blocks viewer, cross-workspace, cross-group and invalid Awaiting drops', () => {
    const source = task('source', { orgId: 'workspace-a', status: 'do' });
    const viewer = task('viewer', { canEdit: false });
    const otherWorkspace = task('other', { orgId: 'workspace-b' });

    expect(canDropBoardTask({ project: viewer, targetStatus: 'done' })).toBe(false);
    expect(canDropBoardTask({ project: source, targetStatus: 'awaiting' })).toBe(false);
    expect(
      canDropBoardTask({ project: source, targetStatus: 'do', targetProject: otherWorkspace })
    ).toBe(false);
    expect(
      canDropBoardTask({
        project: source,
        targetStatus: 'do',
        sourceGroupId: 'project:one',
        targetGroupId: 'project:two',
      })
    ).toBe(false);
  });

  it('allows same-workspace drops and moving an Awaiting task out of Awaiting', () => {
    const source = task('source', { orgId: 'workspace-a', status: 'awaiting' });
    const target = task('target', { orgId: 'workspace-a', status: 'do' });

    expect(
      canDropBoardTask({
        project: source,
        targetStatus: 'do',
        targetProject: target,
        sourceGroupId: 'project:one',
        targetGroupId: 'project:one',
      })
    ).toBe(true);
  });

  it('uses the 15-task default threshold across the whole section', () => {
    expect(shouldExpandBoardSection(15)).toBe(true);
    expect(shouldExpandBoardSection(16)).toBe(false);
  });

  it('prefers a valid URL grouping and treats an invalid explicit URL value as None', () => {
    expect(resolveBoardGrouping('epic', 'assignee')).toBe('epic');
    expect(resolveBoardGrouping('unknown', 'assignee')).toBe('none');
    expect(resolveBoardGrouping(null, 'project')).toBe('project');
    expect(resolveBoardGrouping(null, 'unknown')).toBe('none');
  });

  it('keeps unrelated URL filters when changing grouping', () => {
    expect(updateBoardSearchParams('?customer=Northstar&tab=activity', 'group', 'epic')).toBe(
      '?customer=Northstar&tab=activity&group=epic'
    );
  });

  it('groups by stable ids, qualifies duplicate project labels and puts missing groups last', () => {
    const groups = groupBoardTasks(
      [
        task('p1', {
          projectId: 'project-a',
          category: 'Build',
          orgId: 'org-a',
          orgName: 'Personal',
        }),
        task('p2', {
          projectId: 'project-b',
          category: 'Build',
          orgId: 'org-b',
          orgName: 'Workshop',
        }),
        task('p3', { category: null }),
      ],
      'project'
    );

    expect(groups.map(({ id, label }) => [id, label])).toEqual([
      ['project:project-a', 'Build (Personal)'],
      ['project:project-b', 'Build (Workshop)'],
      ['project:none', 'No project'],
    ]);
  });

  it('keeps No epic and Unassigned at the end of their stable-id groups', () => {
    const tasks = [
      task('unassigned', { assigneeId: null, assigneeName: null }),
      task('assigned', { assigneeId: 'user-a', assigneeName: 'Member A' }),
      task('no-epic', { epicId: null }),
      task('epic', { epicId: 'epic-a' }),
    ];

    expect(
      groupBoardTasks(tasks.slice(2), 'epic', { 'epic-a': 'Delivery' }).map((g) => g.label)
    ).toEqual(['Delivery', 'No epic']);
    expect(groupBoardTasks(tasks.slice(0, 2), 'assignee').map((g) => g.label)).toEqual([
      'Member A',
      'Unassigned',
    ]);
  });

  it('disambiguates identical group names inside the same workspace by stable id', () => {
    const groups = groupBoardTasks(
      [
        task('assigned-a', {
          assigneeId: 'user-one',
          assigneeName: 'Member A',
          orgName: 'Workspace One',
        }),
        task('assigned-b', {
          assigneeId: 'user-two',
          assigneeName: 'Member A',
          orgName: 'Workspace One',
        }),
      ],
      'assignee'
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Member A (Workspace One, user-one)',
      'Member A (Workspace One, user-two)',
    ]);
  });

  it('enforces one 50-task budget across groups and opens one large group at a time', () => {
    const tasks = Array.from({ length: 80 }, (_, index) =>
      task(`task-${index}`, {
        projectId: `project-${index}`,
        category: `Project ${index}`,
      })
    );
    const groups = groupBoardTasks(tasks, 'project');

    expect(getVisibleBoardTasks(groups, 80, null, 50)).toHaveLength(1);
    expect(
      getVisibleBoardTasks(
        groups,
        80,
        groups.find((group) => group.id === 'project:project-4')!.id,
        50
      ).map((item) => item.id)
    ).toEqual(['task-4']);
    expect(getVisibleBoardTasks(groups, 80, null, 100)).toHaveLength(1);
  });

  it('shows every task and group when the whole section is small', () => {
    const groups = groupBoardTasks(
      Array.from({ length: 15 }, (_, index) =>
        task(`task-${index}`, { projectId: `project-${index}`, category: `Project ${index}` })
      ),
      'project'
    );

    expect(getVisibleBoardTasks(groups, 15, null, 50)).toHaveLength(15);
  });
});

const _groupByTypeCheck: BoardGroupBy = 'none';
void _groupByTypeCheck;
