import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import * as orgQueries from '../../app/hooks/useOrganisationQueries';
import * as projectMutations from '../../app/hooks/useProjectMutations';
import * as taskMutations from '../../app/hooks/useTaskMutations';
import type { Project } from '../../app/types/project.types';
import { theme } from '../../theme';
import { TaskDetailView } from './TaskDetailView';

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock hooks
jest.mock('../../app/hooks/useOrganisationQueries');
jest.mock('../../app/hooks/useTaskMutations');
jest.mock('../../app/hooks/useProjectMutations');
jest.mock('../../app/hooks/useProjectQueries', () => ({
  useProjects: () => ({ data: [] }),
}));
jest.mock('../../app/hooks/useEpicQueries', () => ({
  useEpics: () => ({ data: [{ id: 'epic-1', title: 'Epic 1', category: 'Acme Solar' }] }),
}));
jest.mock('../../app/hooks/useGoalQueries', () => ({
  useGoals: () => ({ data: [{ id: 'goal-1', title: 'Plan a community garden', type: 'focus' }] }),
}));
jest.mock('../../app/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { id: 'user-1', name: 'Casey Example', email: 'casey@example.com' },
    userId: 'user-1',
    isMe: (id?: string | null) => id === 'user-1',
  }),
}));
jest.mock('../../app/hooks/useWorkspaces', () => ({
  useWorkspaceLookup: () => (orgId: string | null) =>
    orgId === 'org-1'
      ? { label: 'Northstar Workshop', isPersonal: false }
      : { label: 'Personal', isPersonal: true },
  useWorkspaceProjects: () => ({
    editableProjectGroups: [
      { group: 'Northstar Workshop (shared)', items: [{ value: 'proj-1', label: 'Acme Solar' }] },
    ],
    findProject: () => null,
    isLoading: false,
  }),
}));
// The activity feed has its own tests; here we only check it's wired to the task
jest.mock('../Activity/ActivityFeed', () => ({
  ActivityFeed: ({ taskId }: { taskId?: string }) => (
    <div data-testid="activity-feed">activity for {taskId}</div>
  ),
}));
jest.mock('../FeatureCard/ProjectUpdatesTimeline', () => ({
  ProjectUpdatesTimeline: ({
    canEdit,
    projectGmailThreadId,
  }: {
    canEdit?: boolean;
    projectGmailThreadId?: string | null;
  }) => (
    <div data-testid="notes-timeline" data-thread={projectGmailThreadId ?? ''}>
      {canEdit ? 'editable notes' : 'read-only notes'}
    </div>
  ),
}));

const mockTask: Project = {
  id: 'task-123',
  userId: 'user-1',
  project: 'Collaborative Task',
  status: 'do',
  priority: 7,
  size: '***',
  category: 'Acme Solar',
  projectId: 'proj-1',
  orgId: 'org-1',
  orgName: 'Northstar Workshop',
  isShared: true,
  canEdit: true,
  reporterId: 'user-2',
  reporterName: 'Jordan Example',
  updatedById: 'user-2',
  updatedByName: 'Jordan Example',
  assigneeId: null,
  assigneeName: null,
  isDeleted: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('TaskDetailView', () => {
  let mockAssignTaskMutate: jest.Mock;
  let mockLinkTaskGoalMutate: jest.Mock;
  let mockUpdateProjectMutate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssignTaskMutate = jest.fn();
    mockLinkTaskGoalMutate = jest.fn();
    mockUpdateProjectMutate = jest.fn();

    (orgQueries.useOrganisations as jest.Mock).mockReturnValue({
      data: [{ id: 'org-1', name: 'Northstar Workshop' }],
    });
    (orgQueries.useOrganisationMembers as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'mem-1',
          userId: 'user-1',
          userName: 'Casey Example',
          userEmail: 'casey@example.com',
          role: 'owner',
        },
        {
          id: 'mem-2',
          userId: 'user-2',
          userName: 'Jordan Example',
          userEmail: 'jordan@example.com',
          role: 'member',
        },
      ],
    });
    (taskMutations.useAssignTask as jest.Mock).mockReturnValue({
      mutate: mockAssignTaskMutate,
    });
    (taskMutations.useLinkTaskGoal as jest.Mock).mockReturnValue({
      mutate: mockLinkTaskGoalMutate,
    });
    (projectMutations.useUpdateProject as jest.Mock).mockReturnValue({
      mutate: mockUpdateProjectMutate,
    });
    (projectMutations.useMergeProjects as jest.Mock).mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
    });
  });

  const renderComponent = (task: Project = mockTask) => {
    const queryClient = new QueryClient();
    return render(
      <QueryClientProvider client={queryClient}>
        <MantineProvider theme={theme}>
          <TaskDetailView task={task} />
        </MantineProvider>
      </QueryClientProvider>
    );
  };

  it('renders task details with title and assignee selector', () => {
    renderComponent();

    expect(screen.getByDisplayValue('Collaborative Task')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /assignee/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^project/i })).toHaveValue('Acme Solar');
    expect(screen.getByRole('textbox', { name: /linked life goal/i })).toBeInTheDocument();
    expect(screen.getByText('Only you can see your life goal links')).toBeInTheDocument();
  });

  it('shows the workspace, who created and last updated the task, and its activity', () => {
    renderComponent();

    expect(screen.getByText('Northstar Workshop')).toBeInTheDocument();
    const attribution = screen.getByTestId('task-attribution');
    expect(attribution).toHaveTextContent('Created by Jordan Example');
    expect(attribution).toHaveTextContent('Unassigned');
    expect(attribution).toHaveTextContent('Last updated by Jordan Example');
    expect(screen.getByTestId('activity-feed')).toHaveTextContent('activity for task-123');
  });

  it('marks bot task authors and updaters without inferring markers for old records', () => {
    renderComponent({
      ...mockTask,
      reporterName: 'Forum watcher',
      reporterKind: 'bot',
      updatedByName: 'Forum watcher',
      updatedByKind: 'bot',
    } as Project);

    const attribution = screen.getByTestId('task-attribution');
    expect(attribution).toHaveTextContent('Created by Forum watcher');
    expect(attribution).toHaveTextContent('Last updated by Forum watcher');
    expect(within(attribution).getAllByLabelText('Bot identity')).toHaveLength(2);
  });

  it('says "you" for things I did', () => {
    renderComponent({ ...mockTask, reporterId: 'user-1', reporterName: 'Casey Example' });

    expect(screen.getByTestId('task-attribution')).toHaveTextContent('Created by you');
  });

  it('assigns the task to me with one click', async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByRole('button', { name: /assign to me/i }));

    expect(mockAssignTaskMutate).toHaveBeenCalledWith({
      taskId: 'task-123',
      assigneeId: 'user-1',
      assigneeName: 'Casey Example',
    });
  });

  it('is read-only for viewers', () => {
    renderComponent({ ...mockTask, canEdit: false, myRole: 'viewer' });

    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Collaborative Task')).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /assignee/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete task/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /assign to me/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('notes-timeline')).toHaveTextContent('read-only notes');
  });

  it('shows links to outside things under the reason, read-only for viewers', () => {
    const refs: Project['refs'] = [
      {
        id: 'ref-1',
        taskId: 'task-123',
        role: 'source',
        kind: 'forum.post',
        ref: 'example-1',
        canonical: 'forum.post:example-1',
        url: null,
        label: null,
        displayLabel: 'forum.post:example-1',
        createdById: 'user-2',
        createdByName: 'Jordan Example',
        createdAt: '2026-09-01T00:00:00.000Z',
        canDelete: false,
      },
    ];
    renderComponent({ ...mockTask, canEdit: false, myRole: 'viewer', refs });

    const section = screen.getByTestId('task-refs');
    expect(section).toHaveTextContent('Links');
    expect(section).toHaveTextContent('forum.post:example-1');
    expect(screen.queryByRole('button', { name: 'Add a link' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('ref-remove')).not.toBeInTheDocument();
  });

  it('picks up a Gmail thread added under Links, so a blur on the field does not undo it', async () => {
    const user = userEvent.setup();
    const { rerender } = renderComponent();
    const field = screen.getByRole('textbox', { name: /gmail thread id/i });
    expect(field).toHaveValue('');

    // The refs mutation refetched the task: the server mirrored the new thread into the column
    const gmailRef: NonNullable<Project['refs']>[number] = {
      id: 'ref-g',
      taskId: 'task-123',
      role: 'link',
      kind: 'gmail.thread',
      ref: 'thread-example-1',
      canonical: 'gmail.thread:thread-example-1',
      url: 'https://mail.google.com/mail/u/0/#all/thread-example-1',
      label: null,
      displayLabel: 'Gmail thread',
      createdById: 'user-1',
      createdByName: 'Casey Example',
      createdAt: '2026-10-09T00:00:00.000Z',
      canDelete: true,
    };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider theme={theme}>
          <TaskDetailView
            task={{ ...mockTask, gmailThreadId: 'thread-example-1', refs: [gmailRef] }}
          />
        </MantineProvider>
      </QueryClientProvider>
    );
    expect(field).toHaveValue('thread-example-1');

    await user.click(field);
    await user.tab();
    expect(mockUpdateProjectMutate).not.toHaveBeenCalled();
    // The chip under Links is the way to open it; no second "Open in Gmail", nor a notes badge
    expect(screen.queryByText('Open in Gmail')).not.toBeInTheDocument();
    expect(screen.getByTestId('notes-timeline')).toHaveAttribute('data-thread', '');
  });

  it('still shows a thread that is not a link, in the field and the notes', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MantineProvider theme={theme}>
          <TaskDetailView task={{ ...mockTask, gmailThreadId: 'thread-example-1', refs: [] }} />
        </MantineProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText('Open in Gmail')).toBeInTheDocument();
    expect(screen.getByTestId('notes-timeline')).toHaveAttribute('data-thread', 'thread-example-1');
  });

  it('offers "Add a link" on a task without links when I can edit it', () => {
    renderComponent();

    expect(screen.getByRole('button', { name: 'Add a link' })).toBeInTheDocument();
    expect(screen.getByTestId('task-refs')).not.toHaveTextContent(/^Links/);
  });

  it('triggers assignTask mutation when selecting an assignee', async () => {
    const user = userEvent.setup();
    renderComponent();

    const assigneeInput = screen.getByRole('textbox', { name: /assignee/i });
    await user.click(assigneeInput);

    const option = await screen.findByRole('option', { name: /jordan example/i });
    await user.click(option);

    expect(mockAssignTaskMutate).toHaveBeenCalledWith({
      taskId: 'task-123',
      assigneeId: 'user-2',
      assigneeName: 'Jordan Example',
    });
  });

  it('saves my private life goal link on the task when selecting a goal', async () => {
    const user = userEvent.setup();
    renderComponent();

    const goalInput = screen.getByRole('textbox', { name: /linked life goal/i });
    await user.click(goalInput);

    const option = await screen.findByRole('option', {
      name: /\[FOCUS\] Plan a community garden/i,
    });
    await user.click(option);

    expect(mockUpdateProjectMutate).toHaveBeenCalledWith({
      projectId: 'task-123',
      data: { goalId: 'goal-1' },
    });
  });
});
