'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  IconArrowLeft,
  IconBrandGmail,
  IconCalendar,
  IconChevronRight,
  IconExternalLink,
  IconEye,
  IconFlag,
  IconGitMerge,
  IconTarget,
  IconTrash,
  IconUserCheck,
} from '@tabler/icons-react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Grid,
  Group,
  Paper,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useEpics } from '../../app/hooks/useEpicQueries';
import { useGoals } from '../../app/hooks/useGoalQueries';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { useOrganisationMembers } from '../../app/hooks/useOrganisationQueries';
import { useUpdateProject } from '../../app/hooks/useProjectMutations';
import { useProjects } from '../../app/hooks/useProjectQueries';
import { useAssignTask } from '../../app/hooks/useTaskMutations';
import { useWorkspaceLookup } from '../../app/hooks/useWorkspaces';
import type {
  Project,
  ProjectSize,
  ProjectStatus,
  ProjectUpdateInput,
} from '../../app/types/project.types';
import { ActivityFeed } from '../Activity/ActivityFeed';
import { ProjectUpdatesTimeline } from '../FeatureCard/ProjectUpdatesTimeline';
import { MarkdownEditor } from '../MarkdownViewer/MarkdownEditor';
import { MarkdownViewer } from '../MarkdownViewer/MarkdownViewer';
import { AssigneePicker } from '../ProjectPicker/AssigneePicker';
import { buildEpicOptions, PRIVATE_GOAL_HINT, ProjectPicker } from '../ProjectPicker/ProjectPicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';
import {
  absoluteTime,
  canEditItem,
  personLabel,
  relativeTime,
  TeamAvatar,
  ViewOnlyTooltip,
  WorkspaceBadge,
} from '../Team';
import { MergeTaskModal } from './MergeTaskModal';

interface TaskDetailViewProps {
  task: Project;
}

const statusOptions: { value: ProjectStatus; label: string }[] = [
  { value: 'do', label: 'Do' },
  { value: 'delay', label: 'Delay' },
  { value: 'awaiting', label: 'Awaiting' },
  { value: 'done', label: 'Done' },
  { value: 'delegate', label: 'Delegate' },
];

export function TaskDetailView({ task }: TaskDetailViewProps) {
  const router = useRouter();
  const updateProjectMutation = useUpdateProject();
  const assignTaskMutation = useAssignTask();
  const { user, userId } = useCurrentUser();

  const { data: members = [] } = useOrganisationMembers(task.orgId || '');
  const { data: epics } = useEpics();
  const { data: goals } = useGoals();
  const { features } = useInstanceConfig();
  const { data: allTasks = [] } = useProjects();
  const [mergeModalOpened, setMergeModalOpened] = useState(false);

  const canEdit = canEditItem(task);
  const isShared = !!task.isShared;
  const workspace = useWorkspaceLookup()(task.orgId, task);

  const [title, setTitle] = useState(task.project);
  const [reason, setReason] = useState(task.reason || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [status, setStatus] = useState<ProjectStatus>(task.status);
  const [priority, setPriority] = useState(task.priority);
  const [size, setSize] = useState<ProjectSize>(task.size);
  const [projectId, setProjectId] = useState<string | null>(task.projectId || null);
  const [epicId, setEpicId] = useState<string | null>(task.epicId || null);
  const [goalId, setGoalId] = useState<string | null>(task.goalId || null);
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assigneeId || null);
  const [awaitUntil, setAwaitUntil] = useState<string | null>(task.awaitUntil || null);
  const [gmailThreadId, setGmailThreadId] = useState(task.gmailThreadId || '');

  // Someone else (or another tab) changed the task: pick up the server values for the fields
  // that aren't free text, so pickers never show stale state.
  useEffect(() => {
    setStatus(task.status);
    setPriority(task.priority);
    setSize(task.size);
    setProjectId(task.projectId || null);
    setEpicId(task.epicId || null);
    setGoalId(task.goalId || null);
    setAssigneeId(task.assigneeId || null);
    setAwaitUntil(task.awaitUntil || null);
  }, [
    task.status,
    task.priority,
    task.size,
    task.projectId,
    task.epicId,
    task.goalId,
    task.assigneeId,
    task.awaitUntil,
  ]);

  const handleUpdate = (updates: ProjectUpdateInput) => {
    if (!canEdit) {
      return;
    }
    updateProjectMutation.mutate({
      projectId: task.id,
      data: updates,
    });
  };

  const handleTitleBlur = () => {
    if (title.trim() && title !== task.project) {
      handleUpdate({ project: title.trim() });
    }
  };

  const handleReasonBlur = () => {
    if (reason !== (task.reason || '')) {
      handleUpdate({ reason: reason.trim() });
    }
  };

  const handleNotesBlur = () => {
    if (notes !== (task.notes || '')) {
      handleUpdate({ notes: notes.trim() });
    }
  };

  const handleGmailThreadIdBlur = () => {
    if (gmailThreadId !== (task.gmailThreadId || '')) {
      handleUpdate({ gmailThreadId: gmailThreadId.trim() || null });
    }
  };

  const handleStatusChange = (value: string | null) => {
    if (!value) {
      return;
    }
    const newStatus = value as ProjectStatus;
    setStatus(newStatus);
    const updates: ProjectUpdateInput = {
      status: newStatus,
      statusLastChangedOn: new Date().toISOString(),
    };
    if (newStatus !== 'awaiting') {
      updates.awaitUntil = null;
      setAwaitUntil(null);
    }
    handleUpdate(updates);
  };

  const handleProjectChange = (newProjectId: string | null) => {
    if (!newProjectId || newProjectId === task.projectId) {
      return;
    }
    setProjectId(newProjectId);
    handleUpdate({ projectId: newProjectId });
  };

  const handleEpicChange = (newEpicId: string | null) => {
    setEpicId(newEpicId);
    handleUpdate({ epicId: newEpicId });
  };

  const handleGoalChange = (newGoalId: string | null) => {
    setGoalId(newGoalId);
    // goalId on a task is the caller's own private link
    handleUpdate({ goalId: newGoalId });
  };

  const handleAssigneeChange = (newAssigneeId: string | null, newAssigneeName: string | null) => {
    if (!canEdit || newAssigneeId === (task.assigneeId || null)) {
      return;
    }
    setAssigneeId(newAssigneeId);
    assignTaskMutation.mutate({
      taskId: task.id,
      assigneeId: newAssigneeId,
      assigneeName: newAssigneeName,
    });
  };

  const handlePriorityChange = (newPriority: number) => {
    setPriority(newPriority);
    handleUpdate({ priority: newPriority });
  };

  const handleSizeChange = (newSize: ProjectSize) => {
    if (!canEdit) {
      return;
    }
    setSize(newSize);
    handleUpdate({ size: newSize });
  };

  const handleAwaitUntilChange = (date: Date | null) => {
    const formatted = date ? date.toISOString().split('T')[0] : null;
    setAwaitUntil(formatted);
    handleUpdate({ awaitUntil: formatted });
  };

  const handleDelete = () => {
    if (!canEdit) {
      return;
    }
    updateProjectMutation.mutate(
      { projectId: task.id, data: { isDeleted: true } },
      { onSuccess: () => router.push('/board') }
    );
  };

  const epicSelectData = buildEpicOptions(epics, { orgId: task.orgId, projectId });
  const linkedEpic = epics?.find((e) => e.id === task.epicId);

  const goalSelectData = (goals || []).map((g) => ({
    value: g.id,
    label: `[${g.type.toUpperCase()}] ${g.title}`,
  }));

  // Merging only makes sense within one workspace, between tasks I can change
  const mergeCandidates = allTasks.filter(
    (t) => canEditItem(t) && (!task.orgId || !t.orgId || t.orgId === task.orgId)
  );

  const otherMembers = members
    .filter((m) => m.userId !== userId)
    .map((m) => m.userName || m.userEmail);
  const isAssignedToMe = !!assigneeId && assigneeId === userId;

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        {/* Navigation & Header */}
        <Group justify="space-between" align="center">
          <Button
            component={Link}
            href="/board"
            variant="subtle"
            leftSection={<IconArrowLeft size={16} />}
            size="sm"
          >
            Back to Board
          </Button>
          <Group gap="xs">
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <Button
                variant="subtle"
                color="blue"
                size="xs"
                leftSection={<IconGitMerge size={14} />}
                onClick={() => setMergeModalOpened(true)}
                disabled={!canEdit}
              >
                Merge
              </Button>
            </ViewOnlyTooltip>
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconTrash size={14} />}
                onClick={handleDelete}
                disabled={!canEdit}
                loading={
                  updateProjectMutation.isPending &&
                  !!updateProjectMutation.variables?.data.isDeleted
                }
              >
                Delete Task
              </Button>
            </ViewOnlyTooltip>
          </Group>
        </Group>

        {/* Where this task lives: workspace > project > epic */}
        <Stack gap={6}>
          <Group gap={6} wrap="wrap" aria-label="Task location">
            <WorkspaceBadge
              name={task.orgName}
              isPersonal={workspace.isPersonal}
              isShared={isShared}
              sharedWith={otherMembers}
              size="sm"
            />
            {task.category && (
              <>
                <IconChevronRight size={14} color="var(--mantine-color-dimmed)" />
                <Badge
                  component={Link}
                  href={`/projects/${encodeURIComponent(task.category)}`}
                  variant="light"
                  color="blue"
                  size="sm"
                  style={{ cursor: 'pointer', textTransform: 'none' }}
                >
                  {task.projectKey ? `${task.projectKey} · ` : ''}
                  {task.category}
                </Badge>
              </>
            )}
            {linkedEpic && (
              <>
                <IconChevronRight size={14} color="var(--mantine-color-dimmed)" />
                <Badge
                  component={Link}
                  href={`/epics/${linkedEpic.id}`}
                  variant="light"
                  color="violet"
                  size="sm"
                  leftSection={<IconFlag size={10} />}
                  style={{ cursor: 'pointer', textTransform: 'none' }}
                >
                  {linkedEpic.title}
                </Badge>
              </>
            )}
          </Group>
          <Attribution task={task} meId={userId} />
        </Stack>

        {!canEdit && (
          <Alert color="gray" variant="light" icon={<IconEye size={18} />} title="View only">
            You can see this task but not change it. Ask an owner or admin of{' '}
            {task.orgName || 'this workspace'} if you need edit access.
          </Alert>
        )}

        {/* Main Card */}
        <Card shadow="sm" padding="lg" radius="md" withBorder>
          <Stack gap="md">
            {/* Title / Project input */}
            <TextInput
              label="Task Title"
              size="lg"
              fw={600}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              onBlur={handleTitleBlur}
              placeholder="Task name"
              readOnly={!canEdit}
              data-autofocus
            />

            <Grid gutter="md">
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Status"
                  data={statusOptions}
                  value={status}
                  onChange={handleStatusChange}
                  allowDeselect={false}
                  disabled={!canEdit}
                />
              </Grid.Col>

              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Stack gap={4}>
                  <AssigneePicker
                    orgId={task.orgId}
                    value={assigneeId}
                    currentName={task.assigneeName}
                    onChange={handleAssigneeChange}
                    disabled={!canEdit}
                  />
                  {canEdit && !isAssignedToMe && user?.id && (
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      leftSection={<IconUserCheck size={14} />}
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => handleAssigneeChange(user.id, user.name || null)}
                    >
                      Assign to me
                    </Button>
                  )}
                </Stack>
              </Grid.Col>

              <Grid.Col span={{ base: 12, sm: 6 }}>
                <ProjectPicker
                  label="Project"
                  description={
                    isShared && task.orgName ? `In the shared ${task.orgName} workspace` : undefined
                  }
                  value={projectId}
                  currentLabel={task.category}
                  onChange={handleProjectChange}
                  allowDeselect={false}
                  disabled={!canEdit}
                />
              </Grid.Col>

              {status === 'awaiting' && (
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <DatePickerInput
                    label="Return Date (Await Until)"
                    placeholder="Pick a return date"
                    valueFormat="D MMM YYYY"
                    minDate={new Date()}
                    value={awaitUntil ? new Date(awaitUntil) : null}
                    onChange={handleAwaitUntilChange}
                    leftSection={<IconCalendar size={16} />}
                    disabled={!canEdit}
                  />
                </Grid.Col>
              )}

              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Linked Epic"
                  placeholder={epicSelectData.length ? 'Select Epic' : 'No epics in this workspace'}
                  data={epicSelectData}
                  value={epicId}
                  onChange={handleEpicChange}
                  clearable
                  searchable
                  leftSection={<IconFlag size={16} />}
                  disabled={!canEdit}
                />
              </Grid.Col>

              {features.goals && (
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Select
                    label="Linked Life Goal"
                    description={PRIVATE_GOAL_HINT}
                    placeholder="Select Goal (Aim, Focus, Value, Habit)"
                    data={goalSelectData}
                    value={goalId}
                    onChange={handleGoalChange}
                    clearable
                    leftSection={<IconTarget size={16} />}
                    disabled={!canEdit}
                  />
                </Grid.Col>
              )}
            </Grid>

            {/* Sizing and Priority */}
            <Paper p="sm" withBorder radius="sm">
              <Grid align="center">
                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Stack gap="xs">
                    <Text size="sm" fw={500}>
                      Effort Size: {size}
                    </Text>
                    <ProjectStars size={size} onUpdate={canEdit ? handleSizeChange : undefined} />
                  </Stack>
                </Grid.Col>

                <Grid.Col span={{ base: 12, sm: 6 }}>
                  <Stack gap="xs">
                    <Text size="sm" fw={500}>
                      Priority: {priority} / 10
                    </Text>
                    <Slider
                      min={1}
                      max={10}
                      step={1}
                      value={priority}
                      onChange={setPriority}
                      onChangeEnd={handlePriorityChange}
                      disabled={!canEdit}
                      marks={[
                        { value: 1, label: '1' },
                        { value: 5, label: '5' },
                        { value: 10, label: '10' },
                      ]}
                    />
                  </Stack>
                </Grid.Col>
              </Grid>
            </Paper>

            {/* Reason & Markdown Description */}
            <TextInput
              label="Why it matters (Reason)"
              placeholder="Why is this important?"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              onBlur={handleReasonBlur}
              readOnly={!canEdit}
            />

            {canEdit ? (
              <MarkdownEditor
                label="Task Description & Notes (Markdown)"
                placeholder="Write detailed specifications, background context, sub-tasks (- [ ]), links, notes..."
                value={notes}
                onChange={setNotes}
                onBlur={handleNotesBlur}
                minRows={6}
                maxRows={20}
              />
            ) : (
              <Stack gap={4}>
                <Text size="sm" fw={500}>
                  Task Description & Notes
                </Text>
                <Paper withBorder radius="sm" p="sm">
                  {notes ? (
                    <MarkdownViewer content={notes} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      No description yet.
                    </Text>
                  )}
                </Paper>
              </Stack>
            )}

            {/* Gmail integration */}
            {features.gmail && (
              <>
                <Stack gap="xs">
                  <TextInput
                    label="Gmail Thread ID"
                    placeholder="e.g. 18dfa72b3c4d5e6f"
                    value={gmailThreadId}
                    onChange={(e) => setGmailThreadId(e.currentTarget.value)}
                    onBlur={handleGmailThreadIdBlur}
                    leftSection={<IconBrandGmail size={16} />}
                    readOnly={!canEdit}
                  />
                  {task.gmailThreadId && (
                    <Group gap="xs">
                      <Anchor
                        href={`https://mail.google.com/mail/u/0/#inbox/${task.gmailThreadId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        size="sm"
                        c="blue"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <IconBrandGmail size={16} color="#EA4335" />
                        Open in Gmail
                        <IconExternalLink size={14} />
                      </Anchor>
                    </Group>
                  )}
                </Stack>

                <Divider my="sm" />
              </>
            )}

            {/* Notes */}
            <div>
              <Title order={3} size="h4" mb="sm">
                Updates & Notes
              </Title>
              <ProjectUpdatesTimeline
                projectId={task.id}
                projectGmailThreadId={task.gmailThreadId}
                canEdit={canEdit}
              />
            </div>
          </Stack>
        </Card>

        {/* Who did what */}
        <Card padding="lg" radius="md" withBorder>
          <ActivityFeed taskId={task.id} compact title="Activity" />
        </Card>
      </Stack>

      <MergeTaskModal
        opened={mergeModalOpened}
        onClose={() => setMergeModalOpened(false)}
        currentTask={task}
        allTasks={mergeCandidates}
      />
    </Container>
  );
}

/**
 * "Created by Tim Dobson · Assigned to you · Last updated by Robin Fairweather, 2h ago"
 */
function Attribution({ task, meId }: { task: Project; meId: string | null }) {
  const parts: React.ReactNode[] = [];

  if (task.reporterName || task.reporterId) {
    parts.push(
      <Tooltip key="created" label={absoluteTime(task.createdAt)} withArrow openDelay={300}>
        <span>
          Created by {personLabel(task.reporterName, task.reporterId, meId, { capitalise: false })}
        </span>
      </Tooltip>
    );
  }

  if (task.isShared) {
    parts.push(
      <Group
        key="assignee"
        gap={4}
        wrap="nowrap"
        component="span"
        style={{ display: 'inline-flex' }}
      >
        {task.assigneeId && (
          <TeamAvatar name={task.assigneeName} seed={task.assigneeId} size={16} />
        )}
        <span>
          {task.assigneeId
            ? `Assigned to ${personLabel(task.assigneeName, task.assigneeId, meId, { capitalise: false })}`
            : 'Unassigned'}
        </span>
      </Group>
    );
  }

  if (task.updatedByName || task.updatedById) {
    const when = relativeTime(task.updatedAt);
    parts.push(
      <Tooltip key="updated" label={absoluteTime(task.updatedAt)} withArrow openDelay={300}>
        <span>
          Last updated by{' '}
          {personLabel(task.updatedByName, task.updatedById, meId, { capitalise: false })}
          {when ? `, ${when}` : ''}
        </span>
      </Tooltip>
    );
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <Text size="sm" c="dimmed" component="div" data-testid="task-attribution">
      <Group gap={6} wrap="wrap">
        {parts.map((part, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span aria-hidden>·</span>}
            {part}
          </React.Fragment>
        ))}
      </Group>
    </Text>
  );
}
