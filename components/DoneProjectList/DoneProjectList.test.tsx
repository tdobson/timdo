import React from 'react';
import { screen } from '@testing-library/react';
import type { Project } from '../../app/types/project.types';
import { render } from '../../test-utils/render';
import { DoneProjectList } from './DoneProjectList';

const task = (id: string): Project => ({
  id,
  project: `Completed ${id}`,
  status: 'done',
  priority: 5,
  size: '**',
  userId: 'user-a',
  isDeleted: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

describe('DoneProjectList', () => {
  it('mounts at most 50 recent Done rows in a large section', () => {
    const ControlledDoneList = DoneProjectList as unknown as React.ComponentType<
      Record<string, unknown>
    >;
    const projects = Array.from({ length: 80 }, (_, index) => task(`task-${index}`));

    render(
      <ControlledDoneList
        title="Done"
        projects={projects}
        totalCount={80}
        expanded
        groupBy="none"
        visibleLimit={50}
        onToggle={jest.fn()}
        onShowMore={jest.fn()}
      />
    );

    expect(screen.getAllByTestId('done-project-item')).toHaveLength(50);
  });

  it('shares the render budget between recent and loaded older tasks', () => {
    const ControlledDoneList = DoneProjectList as unknown as React.ComponentType<
      Record<string, unknown>
    >;
    const recent = Array.from({ length: 10 }, (_, index) => task(`recent-${index}`));
    const older = Array.from({ length: 50 }, (_, index) => ({
      ...task(`older-${index}`),
      status: 'done' as const,
      noteCount: 0,
      lastNoteAt: null,
    }));

    render(
      <ControlledDoneList
        title="Done"
        projects={recent}
        historyItems={older}
        historyOpen
        totalCount={60}
        expanded
        groupBy="none"
        visibleLimit={50}
        onToggle={jest.fn()}
        onShowMore={jest.fn()}
        onLoadMoreOlder={jest.fn()}
      />
    );

    expect(screen.getAllByTestId('done-project-item')).toHaveLength(50);
    expect(screen.getByRole('button', { name: 'Show 50 more' })).toBeInTheDocument();
  });

  it('disables Load older while the next history page is fetching', () => {
    const ControlledDoneList = DoneProjectList as unknown as React.ComponentType<
      Record<string, unknown>
    >;

    render(
      <ControlledDoneList
        title="Done"
        projects={[task('recent')]}
        historyItems={[task('older')]}
        historyOpen
        historyHasNext
        historyLoadingMore
        totalCount={3}
        expanded
        onToggle={jest.fn()}
        onShowOlder={jest.fn()}
        onLoadMoreOlder={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Load older 50' })).toBeDisabled();
  });

  it('keeps the older-history action available when recent Done is empty', () => {
    const ControlledDoneList = DoneProjectList as unknown as React.ComponentType<
      Record<string, unknown>
    >;

    render(
      <ControlledDoneList
        title="Done"
        projects={[]}
        totalCount={18}
        expanded
        groupBy="none"
        visibleLimit={50}
        historyOpen={false}
        onToggle={jest.fn()}
        onShowOlder={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /show older tasks/i })).toBeInTheDocument();
  });
});
