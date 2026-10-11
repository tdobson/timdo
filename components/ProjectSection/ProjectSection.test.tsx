import React from 'react';
import { DndContext } from '@dnd-kit/core';
import type { Project } from '../../app/types/project.types';
import { render, screen, within } from '../../test-utils';
import { ProjectSection } from './ProjectSection';

const awaitingProject: Project = {
  id: 'awaiting-1',
  userId: 'user-123',
  project: 'Awaiting Project',
  reason: 'Wait until later',
  status: 'awaiting',
  priority: 5,
  size: '***',
  notes: '',
  awaitUntil: '2026-08-03',
  isDeleted: false,
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  statusLastChangedOn: '2026-07-10T00:00:00.000Z',
};

const renderSection = (ui: React.ReactNode) => render(<DndContext>{ui}</DndContext>);

describe('ProjectSection awaiting rendering', () => {
  it('renders awaiting project cards with their project names visible', () => {
    renderSection(
      <ProjectSection
        id="awaiting"
        title="⏳ Awaiting (1)"
        projects={[awaitingProject]}
        defaultOpen={false}
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    const awaitingSection = screen.getByTestId('section-awaiting');

    expect(within(awaitingSection).getByRole('heading', { name: /awaiting/i })).toBeInTheDocument();
    // ProjectSection renders card controls even when panels are closed;
    // section-level collapse is handled at the board page level.
    expect(within(awaitingSection).getByText('Awaiting Project')).toBeInTheDocument();
  });

  it('mounts no more than 50 cards across an expanded large section', () => {
    const tasks = Array.from({ length: 80 }, (_, index) => ({
      ...awaitingProject,
      id: `scale-${index}`,
      project: `Task ${index}`,
      status: 'do' as const,
    }));
    const ControlledSection = ProjectSection as unknown as React.ComponentType<
      Record<string, unknown>
    >;

    renderSection(
      <ControlledSection
        id="do"
        title="Do"
        projects={tasks}
        taskCount={80}
        sectionExpanded
        groupBy="none"
        visibleLimit={50}
        expandedTaskIds={[]}
        onExpandedTaskIdsChange={jest.fn()}
        onToggleSection={jest.fn()}
        onShowMore={jest.fn()}
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    expect(screen.getAllByTestId(/project-card-control-/)).toHaveLength(50);
  });

  it('unmounts all card content when a controlled section collapses', () => {
    const ControlledSection = ProjectSection as unknown as React.ComponentType<
      Record<string, unknown>
    >;

    renderSection(
      <ControlledSection
        id="awaiting"
        title="Awaiting"
        projects={[awaitingProject]}
        taskCount={1}
        sectionExpanded={false}
        groupBy="none"
        visibleLimit={50}
        expandedTaskIds={[awaitingProject.id]}
        onExpandedTaskIdsChange={jest.fn()}
        onToggleSection={jest.fn()}
        onShowMore={jest.fn()}
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Expand Awaiting section' })).toBeInTheDocument();
    expect(screen.queryByTestId('project-card-control-awaiting-1')).not.toBeInTheDocument();
  });

  it('limits a large grouped section to one open group at a time', () => {
    const tasks = Array.from({ length: 80 }, (_, index) => ({
      ...awaitingProject,
      id: `grouped-${index}`,
      project: `Task ${index}`,
      projectId: `project-${index}`,
      category: `Project ${index}`,
      status: 'do' as const,
    }));
    const ControlledSection = ProjectSection as unknown as React.ComponentType<
      Record<string, unknown>
    >;

    renderSection(
      <ControlledSection
        id="do"
        title="Do"
        projects={tasks}
        taskCount={80}
        sectionExpanded
        groupBy="project"
        visibleLimit={50}
        expandedTaskIds={[]}
        onExpandedTaskIdsChange={jest.fn()}
        onToggleSection={jest.fn()}
        onShowMore={jest.fn()}
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    expect(screen.getAllByTestId(/project-card-control-/)).toHaveLength(1);
  });

  it('renders nothing when projects array is empty', () => {
    renderSection(
      <ProjectSection
        id="awaiting"
        title="⏳ Awaiting (0)"
        projects={[]}
        defaultOpen={false}
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    expect(screen.queryByTestId('section-awaiting')).not.toBeInTheDocument();
  });

  it('expands accordion panels when alwaysExpanded is true', () => {
    renderSection(
      <ProjectSection
        id="awaiting"
        title="⏳ Awaiting (1)"
        projects={[awaitingProject]}
        alwaysExpanded
        onUpdateProject={jest.fn()}
        onStatusChange={jest.fn()}
      />
    );

    // Panel content should be visible when alwaysExpanded
    expect(screen.getByText('Wait until later')).toBeInTheDocument();
  });
});
