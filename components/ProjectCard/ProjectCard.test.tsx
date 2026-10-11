import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Accordion } from '@mantine/core';
import { useBoardProjectDetail } from '../../app/hooks/useBoardQueries';
import type { Project, ProjectSummary, RefView } from '../../app/types/project.types';
import { TestWrapper } from '../../test-utils/render';
import { ProjectCard, ProjectCardPreview } from './ProjectCard';
import classes from './ProjectCard.module.css';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('category=Old&customer=Old&group=epic&tab=updates'),
}));

jest.mock('../../app/hooks/useBoardQueries', () => ({
  ...jest.requireActual('../../app/hooks/useBoardQueries'),
  useBoardProjectDetail: jest.fn(),
}));

const useBoardProjectDetailMock = useBoardProjectDetail as jest.Mock;

const mockProject: Project = {
  id: '1',
  project: 'Test Project',
  reason: 'To test things',
  notes: 'Some notes here',
  status: 'do',
  priority: 10,
  size: '***',
  userId: 'user-123',
  isDeleted: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  statusLastChangedOn: '2024-01-01T00:00:00.000Z',
};

describe('ProjectCard', () => {
  it.each([0, 1, 3])('uses the right note label for %i in cards and previews', (noteCount) => {
    const project = { ...mockProject, noteCount };
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard
            project={project}
            expanded={false}
            onUpdate={jest.fn()}
            onStatusChange={jest.fn()}
          />
        </Accordion>
        <ProjectCardPreview project={project} />
      </TestWrapper>
    );

    expect(screen.getAllByText(`${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`)).toHaveLength(
      2
    );
  });

  it('identifies the task title for a narrow responsive header', () => {
    const sharedTask: Project = {
      ...mockProject,
      id: 'responsive-header-task',
      isShared: true,
      canEdit: true,
      assigneeId: null,
      assigneeName: null,
      customer: 'Fictional customer',
      category: 'Fictional project',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={sharedTask} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.getByText(sharedTask.project)).toHaveClass(classes.taskTitle);
    expect(screen.getByTestId('claim-task-btn')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fictional customer' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fictional project' })).toBeInTheDocument();
  });

  it('renders in view mode by default and shows buttons when expanded', async () => {
    // Arrange
    const user = userEvent.setup();
    const onUpdate = jest.fn();
    const onStatusChange = jest.fn();

    // Act
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={mockProject} onUpdate={onUpdate} onStatusChange={onStatusChange} />
        </Accordion>
      </TestWrapper>
    );

    // Assert initial state
    expect(screen.getByText('Test Project')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();

    // Act: Open the accordion by clicking the specific control button
    const controlButton = screen.getByTestId(`project-card-control-${mockProject.id}`);
    await user.click(controlButton);

    // Assert: Buttons are now visible
    expect(await screen.findByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /mark as done/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('switches to edit mode when edit button is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={mockProject} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    // Act
    const controlButton = screen.getByTestId(`project-card-control-${mockProject.id}`);
    await user.click(controlButton); // Open accordion
    await user.click(await screen.findByRole('button', { name: /edit/i }));

    // Assert
    expect(screen.getByDisplayValue('Test Project')).toBeInTheDocument();
    expect(screen.getByLabelText(/reason/i)).toBeInTheDocument();
    // Check for interactive stars in the panel
    expect(await screen.findByRole('button', { name: /set rating to 1/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('calls onUpdate with new values when save is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    const onUpdate = jest.fn();
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={mockProject} onUpdate={onUpdate} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    // Act
    const controlButton = screen.getByTestId(`project-card-control-${mockProject.id}`);
    await user.click(controlButton); // Open accordion
    await user.click(await screen.findByRole('button', { name: /edit/i }));
    const nameInput = screen.getByDisplayValue('Test Project');
    await user.clear(nameInput);
    await user.paste('Updated Project Name');
    // Click the 5th star to change the size
    await user.click(await screen.findByRole('button', { name: /set rating to 5/i }));
    await user.click(await screen.findByRole('button', { name: /save/i }));

    // Assert
    expect(onUpdate).toHaveBeenCalledWith(
      mockProject.id,
      expect.objectContaining({
        project: 'Updated Project Name',
        size: '*****',
      })
    );
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('reverts to view mode and does not call onUpdate when cancel is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    const onUpdate = jest.fn();
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={mockProject} onUpdate={onUpdate} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    // Act
    const controlButton = screen.getByTestId(`project-card-control-${mockProject.id}`);
    await user.click(controlButton); // Open accordion
    await user.click(await screen.findByRole('button', { name: /edit/i }));
    const nameInput = screen.getByDisplayValue('Test Project');
    await user.clear(nameInput);
    await user.paste('A change that will be reverted');
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    // Assert
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByText('Test Project')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A change that will be reverted')).not.toBeInTheDocument();
  });

  it('shows an assignee avatar with a tooltip label in shared workspaces', () => {
    const sharedTask: Project = {
      ...mockProject,
      id: '2',
      projectKey: 'ACM-12',
      isShared: true,
      orgName: 'Acme',
      assigneeId: 'user-456',
      assigneeName: 'Sarah Jenkins',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={sharedTask} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.getByRole('img', { name: 'Assigned to Sarah Jenkins' })).toHaveTextContent('SJ');
    expect(screen.queryByTestId('claim-task-btn')).not.toBeInTheDocument();
  });

  it('keeps personal tasks uncluttered: no assignee avatar outside shared workspaces', () => {
    const personalTask: Project = {
      ...mockProject,
      id: '3',
      isShared: false,
      assigneeId: 'user-123',
      assigneeName: 'Alex Morgan',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={personalTask} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.queryByRole('img', { name: /assigned to/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Alex Morgan')).not.toBeInTheDocument();
  });

  it('offers "Assign to me" on unassigned tasks in a shared workspace', () => {
    const unassignedProject: Project = {
      ...mockProject,
      id: 'task-unassigned',
      projectKey: 'ACM-05',
      isShared: true,
      canEdit: true,
      assigneeId: null,
      assigneeName: null,
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard
            project={unassignedProject}
            onUpdate={jest.fn()}
            onStatusChange={jest.fn()}
          />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.getByTestId('claim-task-btn')).toHaveTextContent('Assign to me');
  });

  it('shows who last updated a shared task when it was someone else', async () => {
    const user = userEvent.setup();
    const task: Project = {
      ...mockProject,
      id: 'task-updated',
      isShared: true,
      assigneeId: 'user-456',
      assigneeName: 'Robin Fairweather',
      updatedById: 'user-456',
      updatedByName: 'Robin Fairweather',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={task} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    await user.click(screen.getByTestId('project-card-control-task-updated'));
    expect(await screen.findByTestId('updated-by')).toHaveTextContent(
      'Last updated by Robin Fairweather'
    );
  });

  it('is view only when canEdit is false: no edit, delete or status changes', async () => {
    const user = userEvent.setup();
    const onStatusChange = jest.fn();
    const viewOnly: Project = {
      ...mockProject,
      id: 'task-view-only',
      isShared: true,
      canEdit: false,
      myRole: 'viewer',
      assigneeId: 'user-456',
      assigneeName: 'Robin Fairweather',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={viewOnly} onUpdate={jest.fn()} onStatusChange={onStatusChange} />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.getByText('View only')).toBeInTheDocument();
    await user.click(screen.getByTestId('project-card-control-task-view-only'));

    expect(await screen.findByRole('button', { name: /^edit$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /mark as done/i })).toBeDisabled();
    expect(screen.getAllByTestId('view-only-wrapper').length).toBeGreaterThan(0);
  });

  it('preserves a long full body through editing and saving', async () => {
    const fullBody = Array.from(
      { length: 18 },
      (_, index) => `Long body section ${index + 1}`
    ).join('\n');
    const onUpdate = jest.fn();
    const user = userEvent.setup();
    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard
            project={{ ...mockProject, notes: fullBody }}
            onUpdate={onUpdate}
            onStatusChange={jest.fn()}
          />
        </Accordion>
      </TestWrapper>
    );

    await user.click(screen.getByTestId(`project-card-control-${mockProject.id}`));
    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    const bodyInput = screen.getByPlaceholderText(
      'Additional details, checklists, specifications...'
    );
    expect(bodyInput).toHaveValue(fullBody);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onUpdate).toHaveBeenCalledWith(
      mockProject.id,
      expect.objectContaining({ notes: fullBody })
    );
  });

  it('keeps hydrated summary bodies intact when the user edits and saves them', async () => {
    const fullBody = Array.from(
      { length: 18 },
      (_, index) => `Hydrated body section ${index + 1}`
    ).join('\n');
    const { notes: _notes, ...summaryFields } = mockProject;
    const boardSummary: ProjectSummary = {
      ...summaryFields,
      id: 'summary-task',
      noteCount: 3,
      lastNoteAt: '2026-10-02T00:00:00.000Z',
    };
    useBoardProjectDetailMock.mockReturnValue({
      data: { ...mockProject, id: boardSummary.id, notes: fullBody },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: jest.fn(),
    });
    const onUpdate = jest.fn();
    const user = userEvent.setup();

    render(
      <TestWrapper>
        <Accordion multiple value={[boardSummary.id]} onChange={() => {}} transitionDuration={0}>
          <ProjectCard
            project={boardSummary}
            expanded
            onUpdate={onUpdate}
            onStatusChange={jest.fn()}
          />
        </Accordion>
      </TestWrapper>
    );

    expect(boardSummary).not.toHaveProperty('notes');
    expect(useBoardProjectDetailMock).toHaveBeenCalledWith(boardSummary.id, true);
    expect(await screen.findByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const bodyInput = screen.getByPlaceholderText(
      'Additional details, checklists, specifications...'
    );
    expect(bodyInput).toHaveValue(fullBody);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onUpdate).toHaveBeenCalledWith(
      boardSummary.id,
      expect.objectContaining({ notes: fullBody })
    );
  });

  it('keeps the editor closed and offers Retry when detail hydration fails', async () => {
    const { notes: _notes, ...summaryFields } = mockProject;
    const boardSummary: ProjectSummary = {
      ...summaryFields,
      id: 'summary-error',
      noteCount: 2,
      lastNoteAt: null,
    };
    const refetch = jest.fn();
    useBoardProjectDetailMock.mockReturnValue({
      data: null,
      isLoading: false,
      isFetching: false,
      isError: true,
      refetch,
    });
    const user = userEvent.setup();

    render(
      <TestWrapper>
        <Accordion multiple value={[boardSummary.id]} onChange={() => {}} transitionDuration={0}>
          <ProjectCard
            project={boardSummary}
            expanded
            onUpdate={jest.fn()}
            onStatusChange={jest.fn()}
          />
        </Accordion>
      </TestWrapper>
    );

    expect(await screen.findByText('Retry to load the task before editing.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('preserves unrelated board filters when following customer and category badges', () => {
    const filteredTask: Project = {
      ...mockProject,
      customer: 'Northstar Workshop',
      category: 'Acme Solar',
    };

    render(
      <TestWrapper>
        <Accordion transitionDuration={0}>
          <ProjectCard project={filteredTask} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
        </Accordion>
      </TestWrapper>
    );

    expect(screen.getByRole('link', { name: 'Northstar Workshop' })).toHaveAttribute(
      'href',
      '/board?category=Old&customer=Northstar+Workshop&group=epic&tab=updates'
    );
    expect(screen.getByRole('link', { name: 'Acme Solar' })).toHaveAttribute(
      'href',
      '/board?category=Acme+Solar&customer=Old&group=epic&tab=updates'
    );
  });

  describe('saving the Gmail thread', () => {
    const editAndSave = async (project: Project, thread?: string) => {
      const user = userEvent.setup();
      const onUpdate = jest.fn();
      render(
        <TestWrapper>
          <Accordion transitionDuration={0}>
            <ProjectCard project={project} onUpdate={onUpdate} onStatusChange={jest.fn()} />
          </Accordion>
        </TestWrapper>
      );
      await user.click(screen.getByTestId(`project-card-control-${project.id}`));
      await user.click(await screen.findByRole('button', { name: /^edit$/i }));
      if (thread !== undefined) {
        const input = screen.getByLabelText('Gmail Thread ID');
        await user.clear(input);
        if (thread) {
          await user.type(input, thread);
        }
      }
      await user.click(screen.getByRole('button', { name: /save/i }));
      return onUpdate.mock.calls[0][1];
    };

    it('leaves the thread out when it was not edited, so a stale copy never undoes a link', async () => {
      const sent = await editAndSave({ ...mockProject, gmailThreadId: 'a111111111111111' });
      expect(sent).not.toHaveProperty('gmailThreadId');
      expect(sent).not.toHaveProperty('refs');
    });

    it('sends the thread when it was changed', async () => {
      expect(
        await editAndSave({ ...mockProject, gmailThreadId: 'a111111111111111' }, 'b222222222222222')
      ).toMatchObject({ gmailThreadId: 'b222222222222222' });
    });

    it('sends null when the thread was cleared', async () => {
      expect(
        await editAndSave({ ...mockProject, id: 'clear', gmailThreadId: 'a111111111111111' }, '')
      ).toMatchObject({ gmailThreadId: null });
    });
  });

  describe('links line', () => {
    const ref = (id: string, overrides: Partial<RefView>): RefView => ({
      id,
      taskId: '1',
      role: 'link',
      kind: 'url',
      ref: id,
      canonical: `url:${id}`,
      url: null,
      label: null,
      displayLabel: id,
      createdById: null,
      createdByName: null,
      createdAt: '2026-10-09T00:00:00.000Z',
      canDelete: true,
      ...overrides,
    });
    const refs: RefView[] = [
      ref('r-issue', {
        kind: 'github.issue',
        ref: 'acme/widgets#12',
        url: 'https://github.com/acme/widgets/issues/12',
        displayLabel: 'GitHub issue acme/widgets#12',
      }),
      ref('r-pr', {
        kind: 'github.pr',
        ref: 'acme/widgets#7',
        url: 'https://github.com/acme/widgets/pull/7',
        displayLabel: 'GitHub PR acme/widgets#7',
      }),
      ref('r-source', {
        role: 'source',
        kind: 'forum.post',
        ref: '4411',
        displayLabel: 'forum.post:4411',
      }),
      ref('r-member', {
        role: 'reported_by',
        kind: 'acme.member',
        ref: '123456',
        displayLabel: 'acme.member:123456',
      }),
    ];

    const renderCard = (project: Project) =>
      render(
        <TestWrapper>
          <Accordion transitionDuration={0}>
            <ProjectCard project={project} onUpdate={jest.fn()} onStatusChange={jest.fn()} />
          </Accordion>
        </TestWrapper>
      );

    it('shows up to three short refs, Source first, and +N for the rest', () => {
      renderCard({ ...mockProject, refs });

      const line = screen.getByTestId('task-card-refs');
      const shown = within(line).getAllByTestId('task-card-ref');
      expect(shown.map((el) => el.textContent)).toEqual(['4411', '123456', '#12']);
      expect(within(line).getByTestId('task-card-refs-more')).toHaveTextContent('+1');
      expect(
        within(line).getByRole('link', { name: /link: github issue acme\/widgets#12/i })
      ).toHaveAttribute('href', 'https://github.com/acme/widgets/issues/12');
    });

    it('opening a link does not toggle the card', async () => {
      const user = userEvent.setup();
      renderCard({ ...mockProject, refs: [refs[0]] });

      await user.click(screen.getByRole('link', { name: /github issue/i }));

      expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    });

    it('gives chips without a URL an accessible name with their role', () => {
      renderCard({ ...mockProject, refs });
      const line = screen.getByTestId('task-card-refs');
      expect(within(line).getByRole('img', { name: 'Source: forum.post:4411' })).toHaveTextContent(
        '4411'
      );
      expect(
        within(line).getByRole('img', { name: 'Reported by: acme.member:123456' })
      ).toBeTruthy();
    });

    describe('Gmail thread', () => {
      const thread = 'a111111111111111';
      const gmailRef = ref('r-gmail', {
        kind: 'gmail.thread',
        ref: thread,
        url: `https://mail.google.com/mail/u/0/#all/${thread}`,
        displayLabel: 'Gmail thread',
      });

      it('shows a backfilled thread once, on the links line, not again in the panel', async () => {
        const user = userEvent.setup();
        renderCard({ ...mockProject, gmailThreadId: thread, refs: [gmailRef] });
        expect(screen.getByTestId('task-card-ref')).toHaveTextContent('Gmail');

        await user.click(screen.getByTestId(`project-card-control-${mockProject.id}`));
        await screen.findByRole('button', { name: /^edit$/i });
        expect(screen.queryByText('Gmail Thread')).not.toBeInTheDocument();
        expect(screen.queryByText('Open Project Email Thread')).not.toBeInTheDocument();
      });

      it('keeps the old panel link, and no links line, when the thread is not a ref', async () => {
        const user = userEvent.setup();
        renderCard({ ...mockProject, gmailThreadId: thread, refs: [] });
        expect(screen.queryByTestId('task-card-refs')).not.toBeInTheDocument();

        await user.click(screen.getByTestId(`project-card-control-${mockProject.id}`));
        expect(await screen.findByText('Open Project Email Thread')).toBeInTheDocument();
      });
    });

    it('adds nothing to cards without refs', () => {
      renderCard({ ...mockProject, refs: [] });
      expect(screen.queryByTestId('task-card-refs')).not.toBeInTheDocument();

      renderCard({ ...mockProject, id: 'no-refs-field' });
      expect(screen.queryByTestId('task-card-refs')).not.toBeInTheDocument();
    });
  });
});
