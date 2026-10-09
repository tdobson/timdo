'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  IconArrowLeft,
  IconEdit,
  IconEye,
  IconLayoutKanban,
  IconListCheck,
  IconPlus,
  IconPrinter,
  IconTarget,
  IconTrash,
} from '@tabler/icons-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Divider,
  Group,
  Modal,
  Paper,
  Progress,
  RingProgress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useDeleteEpic, useUpdateEpic } from '../../app/hooks/useEpicQueries';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { useCreateProject, useUpdateProject } from '../../app/hooks/useProjectMutations';
import type { Epic, EpicStatus, EpicUpdateInput } from '../../app/types/epic.types';
import type { Goal } from '../../app/types/goal.types';
import type {
  Project,
  ProjectCreateInput,
  ProjectSize,
  ProjectStatus,
} from '../../app/types/project.types';
import { ActivityFeed } from '../Activity/ActivityFeed';
import { AssigneePicker } from '../ProjectPicker/AssigneePicker';
import { PRIVATE_GOAL_HINT, ProjectPicker } from '../ProjectPicker/ProjectPicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';
import {
  absoluteTime,
  canEditItem,
  personLabel,
  relativeTime,
  TaskAssigneeAvatar,
  TeamAvatar,
  ViewOnlyTooltip,
  WorkspaceBadge,
} from '../Team';

interface EpicDetailViewProps {
  epic: Epic;
  tasks: Project[];
  goals: Goal[];
}

const epicStatusOptions: { value: EpicStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'on_hold', label: 'On Hold' },
];

export function EpicDetailView({ epic, tasks, goals }: EpicDetailViewProps) {
  const router = useRouter();
  const updateEpicMutation = useUpdateEpic();
  const deleteEpicMutation = useDeleteEpic();
  const updateProjectMutation = useUpdateProject();
  const createProjectMutation = useCreateProject();

  const { userId, isMe } = useCurrentUser();

  const { features } = useInstanceConfig();

  const [editModalOpened, { open: openEditModal, close: closeEditModal }] = useDisclosure();
  const [createTaskModalOpened, { open: openCreateTaskModal, close: closeCreateTaskModal }] =
    useDisclosure();

  const canEdit = canEditItem(epic);
  const isShared = !!epic.isShared;
  // Life goals are private: only the epic's creator sees (or sets) its goal
  const isCreator = epic.createdById ? isMe(epic.createdById) : true;

  // Filter tasks belonging to this epic
  const epicTasks = tasks.filter((t) => t.epicId === epic.id && !t.isDeleted);
  const doneTasks = epicTasks.filter((t) => t.status === 'done');
  const totalTasks = epicTasks.length;
  const doneCount = doneTasks.length;
  const progressPercentage = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  const linkedGoal = isCreator ? goals.find((g) => g.id === epic.goalId) : undefined;
  const [viewMode, setViewMode] = React.useState<'list' | 'board'>('list');

  // Edit Epic Form
  const editForm = useForm<EpicUpdateInput>({
    initialValues: {
      title: epic.title,
      description: epic.description || '',
      projectId: epic.projectId || null,
      goalId: epic.goalId || null,
      status: epic.status,
    },
    validate: {
      title: (val) => (val && val.trim().length > 0 ? null : 'Title is required'),
    },
  });

  // Create Task Form for this epic
  const taskForm = useForm<ProjectCreateInput>({
    initialValues: {
      project: '',
      reason: '',
      status: 'do' as ProjectStatus,
      priority: 5,
      size: '***' as ProjectSize,
      notes: '',
      category: epic.category || null,
      epicId: epic.id,
      goalId: epic.goalId || null,
      // undefined = the default (me); null = deliberately unassigned
      assigneeId: undefined as string | null | undefined,
      awaitUntil: null as string | null,
    },
    validate: {
      project: (val) => (val && val.trim().length > 0 ? null : 'Task name is required'),
      awaitUntil: (val, values) =>
        values.status === 'awaiting' && (!val || val.trim().length === 0)
          ? 'Return date is required for awaiting tasks'
          : null,
    },
  });

  const handleEditSubmit = ({ projectId, goalId, ...values }: typeof editForm.values) => {
    updateEpicMutation.mutate({
      epicId: epic.id,
      data: {
        ...values,
        ...(projectId && projectId !== epic.projectId ? { projectId } : {}),
        // Never send a goal for someone else's epic: it isn't theirs to see or change
        ...(isCreator ? { goalId } : {}),
      },
    });
    closeEditModal();
  };

  const handleCreateTaskSubmit = ({ assigneeId, ...values }: typeof taskForm.values) => {
    createProjectMutation.mutate({
      ...values,
      epicId: epic.id,
      ...(epic.projectId ? { projectId: epic.projectId } : {}),
      category: epic.category || values.category || null,
      goalId: (isCreator && epic.goalId) || null,
      ...(isShared && assigneeId !== undefined && assigneeId !== userId ? { assigneeId } : {}),
      awaitUntil: values.status === 'awaiting' ? values.awaitUntil : null,
    });
    taskForm.reset();
    closeCreateTaskModal();
  };

  const handleToggleTaskDone = (task: Project) => {
    if (!canEditItem(task)) {
      return;
    }
    const nextStatus: ProjectStatus = task.status === 'done' ? 'do' : 'done';
    updateProjectMutation.mutate({
      projectId: task.id,
      data: {
        status: nextStatus,
        statusLastChangedOn: new Date().toISOString(),
        awaitUntil: null,
      },
    });
  };

  const handleDeleteEpic = () => {
    deleteEpicMutation.mutate(epic.id, {
      onSuccess: () => {
        router.push('/epics');
      },
    });
  };

  const goalSelectData = goals.map((g) => ({
    value: g.id,
    label: `[${g.type.toUpperCase()}] ${g.title}`,
  }));

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        {/* Navigation & Actions */}
        <Group justify="space-between" align="center">
          <Button
            component={Link}
            href="/epics"
            variant="subtle"
            leftSection={<IconArrowLeft size={16} />}
            size="sm"
          >
            All Epics
          </Button>

          <Group gap="xs">
            <Button
              component={Link}
              href={`/epics/${epic.id}/poster`}
              variant="light"
              color="indigo"
              leftSection={<IconPrinter size={14} />}
              size="sm"
            >
              Printable Poster
            </Button>
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <Button
                variant="light"
                color="gray"
                leftSection={<IconEdit size={14} />}
                size="sm"
                onClick={openEditModal}
                disabled={!canEdit}
              >
                Edit Epic
              </Button>
            </ViewOnlyTooltip>
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <Button
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                size="sm"
                onClick={handleDeleteEpic}
                disabled={!canEdit}
              >
                Delete Epic
              </Button>
            </ViewOnlyTooltip>
          </Group>
        </Group>

        {/* Epic Main Card */}
        <Paper p="lg" radius="md" withBorder>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Stack gap="xs" style={{ flex: 1 }}>
                <Group gap="xs">
                  {isShared && (
                    <WorkspaceBadge name={epic.orgName} isShared isPersonal={false} size="sm" />
                  )}
                  {epic.category && (
                    <Badge
                      component={Link}
                      href={`/projects/${encodeURIComponent(epic.category)}`}
                      color="blue"
                      variant="light"
                      size="sm"
                      style={{ textTransform: 'none' }}
                    >
                      {epic.category}
                    </Badge>
                  )}
                  <Badge
                    color={
                      epic.status === 'completed'
                        ? 'green'
                        : epic.status === 'on_hold'
                          ? 'yellow'
                          : 'violet'
                    }
                    variant="dot"
                  >
                    {epic.status}
                  </Badge>
                  {features.goals && linkedGoal && (
                    <Badge
                      component={Link}
                      href="/goals"
                      color="indigo"
                      variant="outline"
                      leftSection={<IconTarget size={12} />}
                    >
                      {linkedGoal.title}
                    </Badge>
                  )}
                </Group>

                <Title order={1} fz="h2">
                  {epic.title}
                </Title>

                {epic.description && (
                  <Text size="sm" c="dimmed">
                    {epic.description}
                  </Text>
                )}

                {(epic.createdByName || epic.updatedByName) && (
                  <Group gap={6} wrap="wrap" data-testid="epic-attribution">
                    {epic.createdByName && (
                      <Group gap={4} wrap="nowrap">
                        <TeamAvatar name={epic.createdByName} seed={epic.createdById} size={18} />
                        <Tooltip label={absoluteTime(epic.createdAt)} withArrow openDelay={300}>
                          <Text size="xs" c="dimmed">
                            Created by{' '}
                            {personLabel(epic.createdByName, epic.createdById, userId, {
                              capitalise: false,
                            })}
                          </Text>
                        </Tooltip>
                      </Group>
                    )}
                    {epic.updatedByName && (
                      <Tooltip label={absoluteTime(epic.updatedAt)} withArrow openDelay={300}>
                        <Text size="xs" c="dimmed">
                          · Last updated by{' '}
                          {personLabel(epic.updatedByName, epic.updatedById, userId, {
                            capitalise: false,
                          })}
                          {epic.updatedAt ? `, ${relativeTime(epic.updatedAt)}` : ''}
                        </Text>
                      </Tooltip>
                    )}
                  </Group>
                )}
              </Stack>

              <RingProgress
                size={88}
                roundCaps
                thickness={8}
                sections={[{ value: progressPercentage, color: 'violet' }]}
                label={
                  <Text fw={700} ta="center" size="sm">
                    {progressPercentage}%
                  </Text>
                }
              />
            </Group>

            {/* Progress Bar with Counts */}
            <div>
              <Group justify="space-between" mb={4}>
                <Text size="xs" c="dimmed">
                  Overall Completion
                </Text>
                <Text size="xs" fw={600}>
                  {progressPercentage}% ({doneCount}/{totalTasks} tasks completed)
                </Text>
              </Group>
              <Progress
                value={progressPercentage}
                color="violet"
                radius="xl"
                size="md"
                aria-label="Epic completion progress"
              />
            </div>
          </Stack>
        </Paper>

        {!canEdit && (
          <Alert color="gray" variant="light" icon={<IconEye size={18} />} title="View only">
            You can see this epic and its tasks but not change them.
          </Alert>
        )}

        {/* Task List / Board with View Mode Toggle */}
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Group gap="sm">
              <Title order={2} size="h3">
                Tasks ({totalTasks})
              </Title>
              <SegmentedControl
                size="xs"
                value={viewMode}
                onChange={(val) => setViewMode(val as 'list' | 'board')}
                data={[
                  {
                    value: 'board',
                    label: (
                      <Group gap={4}>
                        <IconLayoutKanban size={13} />
                        <span>Board</span>
                      </Group>
                    ),
                  },
                  {
                    value: 'list',
                    label: (
                      <Group gap={4}>
                        <IconListCheck size={13} />
                        <span>List</span>
                      </Group>
                    ),
                  },
                ]}
              />
            </Group>
            <ViewOnlyTooltip viewOnly={!canEdit}>
              <Button
                size="xs"
                leftSection={<IconPlus size={14} />}
                color="violet"
                onClick={openCreateTaskModal}
                disabled={!canEdit}
              >
                Add Task to Epic
              </Button>
            </ViewOnlyTooltip>
          </Group>

          {epicTasks.length === 0 ? (
            <Card withBorder p="xl" radius="md">
              <Stack align="center" gap="xs">
                <Text c="dimmed">No tasks linked to this epic yet.</Text>
                {canEdit && (
                  <Button
                    size="xs"
                    variant="light"
                    color="violet"
                    leftSection={<IconPlus size={14} />}
                    onClick={openCreateTaskModal}
                  >
                    Create First Task
                  </Button>
                )}
              </Stack>
            </Card>
          ) : viewMode === 'board' ? (
            <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
              {/* DO Column */}
              <Paper withBorder p="xs" radius="md" bg="var(--mantine-color-default)">
                <Group justify="space-between" mb="xs">
                  <Text fw={700} size="sm" c="blue">
                    DO ({epicTasks.filter((t) => t.status === 'do').length})
                  </Text>
                </Group>
                <Stack gap="xs">
                  {epicTasks
                    .filter((t) => t.status === 'do')
                    .map((t) => (
                      <Card key={t.id} withBorder p="xs" radius="sm" shadow="xs">
                        <Stack gap={4}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text
                              component={Link}
                              href={`/tasks/${t.id}`}
                              size="xs"
                              fw={600}
                              truncate
                              style={{ flex: 1 }}
                            >
                              {t.project}
                            </Text>
                            <Checkbox
                              size="xs"
                              checked={false}
                              disabled={!canEditItem(t)}
                              onChange={() => handleToggleTaskDone(t)}
                              color="violet"
                              aria-label={`Complete ${t.project}`}
                            />
                          </Group>
                          {t.reason && (
                            <Text size="xs" c="dimmed" lineClamp={2}>
                              {t.reason}
                            </Text>
                          )}
                          <Group justify="space-between" mt={4}>
                            <ProjectStars size={t.size} />
                            <Group gap={4} wrap="nowrap">
                              <TaskAssigneeAvatar task={t} meId={userId} size={18} />
                              <Badge size="xs" variant="light">
                                P{t.priority}
                              </Badge>
                            </Group>
                          </Group>
                        </Stack>
                      </Card>
                    ))}
                </Stack>
              </Paper>

              {/* AWAITING Column */}
              <Paper withBorder p="xs" radius="md" bg="var(--mantine-color-default)">
                <Group justify="space-between" mb="xs">
                  <Text fw={700} size="sm" c="orange">
                    AWAITING ({epicTasks.filter((t) => t.status === 'awaiting').length})
                  </Text>
                </Group>
                <Stack gap="xs">
                  {epicTasks
                    .filter((t) => t.status === 'awaiting')
                    .map((t) => (
                      <Card key={t.id} withBorder p="xs" radius="sm" shadow="xs">
                        <Stack gap={4}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text
                              component={Link}
                              href={`/tasks/${t.id}`}
                              size="xs"
                              fw={600}
                              truncate
                              style={{ flex: 1 }}
                            >
                              {t.project}
                            </Text>
                            <Checkbox
                              size="xs"
                              checked={false}
                              disabled={!canEditItem(t)}
                              onChange={() => handleToggleTaskDone(t)}
                              color="violet"
                              aria-label={`Complete ${t.project}`}
                            />
                          </Group>
                          {t.awaitUntil && (
                            <Badge size="xs" color="orange" variant="light">
                              ⏳ Returns {t.awaitUntil}
                            </Badge>
                          )}
                          {t.reason && (
                            <Text size="xs" c="dimmed" lineClamp={2}>
                              {t.reason}
                            </Text>
                          )}
                          <Group justify="space-between" mt={4}>
                            <ProjectStars size={t.size} />
                            <Group gap={4} wrap="nowrap">
                              <TaskAssigneeAvatar task={t} meId={userId} size={18} />
                              <Badge size="xs" variant="light">
                                P{t.priority}
                              </Badge>
                            </Group>
                          </Group>
                        </Stack>
                      </Card>
                    ))}
                </Stack>
              </Paper>

              {/* DELAY Column */}
              <Paper withBorder p="xs" radius="md" bg="var(--mantine-color-default)">
                <Group justify="space-between" mb="xs">
                  <Text fw={700} size="sm" c="gray">
                    DELAY ({epicTasks.filter((t) => t.status === 'delay').length})
                  </Text>
                </Group>
                <Stack gap="xs">
                  {epicTasks
                    .filter((t) => t.status === 'delay')
                    .map((t) => (
                      <Card key={t.id} withBorder p="xs" radius="sm" shadow="xs">
                        <Stack gap={4}>
                          <Group justify="space-between" wrap="nowrap">
                            <Text
                              component={Link}
                              href={`/tasks/${t.id}`}
                              size="xs"
                              fw={600}
                              truncate
                              style={{ flex: 1 }}
                            >
                              {t.project}
                            </Text>
                            <Checkbox
                              size="xs"
                              checked={false}
                              disabled={!canEditItem(t)}
                              onChange={() => handleToggleTaskDone(t)}
                              color="violet"
                              aria-label={`Complete ${t.project}`}
                            />
                          </Group>
                          {t.reason && (
                            <Text size="xs" c="dimmed" lineClamp={2}>
                              {t.reason}
                            </Text>
                          )}
                          <Group justify="space-between" mt={4}>
                            <ProjectStars size={t.size} />
                            <Group gap={4} wrap="nowrap">
                              <TaskAssigneeAvatar task={t} meId={userId} size={18} />
                              <Badge size="xs" variant="light">
                                P{t.priority}
                              </Badge>
                            </Group>
                          </Group>
                        </Stack>
                      </Card>
                    ))}
                </Stack>
              </Paper>

              {/* DONE Column */}
              <Paper withBorder p="xs" radius="md" bg="var(--mantine-color-default)">
                <Group justify="space-between" mb="xs">
                  <Text fw={700} size="sm" c="green">
                    DONE ({doneCount})
                  </Text>
                </Group>
                <Stack gap="xs">
                  {doneTasks.map((t) => (
                    <Card
                      key={t.id}
                      withBorder
                      p="xs"
                      radius="sm"
                      shadow="xs"
                      style={{ opacity: 0.8 }}
                    >
                      <Stack gap={4}>
                        <Group justify="space-between" wrap="nowrap">
                          <Text
                            component={Link}
                            href={`/tasks/${t.id}`}
                            size="xs"
                            fw={500}
                            truncate
                            style={{
                              flex: 1,
                              textDecoration: 'line-through',
                              color: 'var(--mantine-color-dimmed)',
                            }}
                          >
                            {t.project}
                          </Text>
                          <Checkbox
                            size="xs"
                            checked
                            disabled={!canEditItem(t)}
                            onChange={() => handleToggleTaskDone(t)}
                            color="violet"
                            aria-label={`Unmark ${t.project}`}
                          />
                        </Group>
                        <Group justify="space-between" mt={4}>
                          <ProjectStars size={t.size} />
                          <Group gap={4} wrap="nowrap">
                            <TaskAssigneeAvatar task={t} meId={userId} size={18} />
                            <Badge size="xs" variant="light">
                              P{t.priority}
                            </Badge>
                          </Group>
                        </Group>
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              </Paper>
            </SimpleGrid>
          ) : (
            <Stack gap="xs">
              {epicTasks.map((t) => {
                const isDone = t.status === 'done';
                return (
                  <Paper
                    key={t.id}
                    p="sm"
                    radius="sm"
                    withBorder
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      opacity: isDone ? 0.75 : 1,
                      backgroundColor: isDone ? 'var(--mantine-color-gray-light)' : undefined,
                    }}
                  >
                    <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
                      <Checkbox
                        checked={isDone}
                        disabled={!canEditItem(t)}
                        onChange={() => handleToggleTaskDone(t)}
                        aria-label={`Mark "${t.project}" as done`}
                        color="violet"
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          component={Link}
                          href={`/tasks/${t.id}`}
                          size="sm"
                          fw={500}
                          style={{
                            textDecoration: isDone ? 'line-through' : 'none',
                            color: isDone ? 'var(--mantine-color-dimmed)' : 'inherit',
                          }}
                        >
                          {t.project}
                        </Text>
                        {t.reason && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {t.reason}
                          </Text>
                        )}
                      </div>
                    </Group>

                    <Group gap="xs">
                      {t.status === 'awaiting' && (
                        <Badge size="xs" color="orange" variant="light">
                          ⏳ Awaiting{t.awaitUntil ? ` (${t.awaitUntil})` : ''}
                        </Badge>
                      )}
                      {t.status === 'delay' && (
                        <Badge size="xs" color="gray" variant="light">
                          💤 Delay
                        </Badge>
                      )}
                      <ProjectStars size={t.size} />
                      <TaskAssigneeAvatar task={t} meId={userId} size={18} />
                      <Badge size="sm" variant="light">
                        P{t.priority}
                      </Badge>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>

        <Divider />

        {/* Who did what on this epic and its tasks */}
        <ActivityFeed epicId={epic.id} compact title="Activity" />
      </Stack>

      {/* Edit Epic Modal */}
      <Modal opened={editModalOpened} onClose={closeEditModal} title="Edit Epic" centered>
        <form onSubmit={editForm.onSubmit(handleEditSubmit)}>
          <Stack gap="sm">
            <TextInput
              label="Epic Title"
              required
              data-autofocus
              {...editForm.getInputProps('title')}
            />

            <Textarea
              label="Description"
              placeholder="What is this epic aiming to achieve?"
              autosize
              minRows={2}
              {...editForm.getInputProps('description')}
            />

            <ProjectPicker
              label="Project"
              value={editForm.values.projectId}
              currentLabel={epic.category}
              onChange={(id) => editForm.setFieldValue('projectId', id)}
              allowDeselect={false}
            />

            {isCreator && features.goals && (
              <Select
                label="Linked Goal"
                description={PRIVATE_GOAL_HINT}
                placeholder="Select Life Goal"
                data={goalSelectData}
                clearable
                comboboxProps={{ withinPortal: true }}
                {...editForm.getInputProps('goalId')}
              />
            )}

            <Select label="Status" data={epicStatusOptions} {...editForm.getInputProps('status')} />

            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={closeEditModal}>
                Cancel
              </Button>
              <Button type="submit">Save Changes</Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* Create Task Modal */}
      <Modal
        opened={createTaskModalOpened}
        onClose={closeCreateTaskModal}
        title={`Add Task to "${epic.title}"`}
        centered
      >
        <form onSubmit={taskForm.onSubmit(handleCreateTaskSubmit)}>
          <Stack gap="sm">
            <TextInput
              label="Task Name"
              placeholder="Task title"
              required
              data-autofocus
              {...taskForm.getInputProps('project')}
            />

            <TextInput
              label="Why it matters (Reason)"
              placeholder="Reason for task"
              {...taskForm.getInputProps('reason')}
            />

            {isShared && (
              <AssigneePicker
                orgId={epic.orgId}
                value={
                  taskForm.values.assigneeId === undefined ? userId : taskForm.values.assigneeId
                }
                onChange={(id) => taskForm.setFieldValue('assigneeId', id)}
              />
            )}

            <Select
              label="Status"
              data={[
                { value: 'do', label: 'Do' },
                { value: 'delay', label: 'Delay' },
                { value: 'awaiting', label: 'Awaiting' },
              ]}
              {...taskForm.getInputProps('status')}
              onChange={(value) => {
                taskForm.setFieldValue('status', (value as ProjectStatus) || 'do');
                if (value !== 'awaiting') {
                  taskForm.setFieldValue('awaitUntil', null);
                }
              }}
            />

            {taskForm.values.status === 'awaiting' && (
              <DatePickerInput
                label="Return Date (Await Until)"
                placeholder="Pick a return date"
                valueFormat="D MMM YYYY"
                minDate={new Date()}
                clearable={false}
                required
                value={taskForm.values.awaitUntil ? new Date(taskForm.values.awaitUntil) : null}
                onChange={(date) => {
                  taskForm.setFieldValue(
                    'awaitUntil',
                    date instanceof Date ? date.toISOString().split('T')[0] : null
                  );
                }}
              />
            )}

            <div>
              <Text size="sm" fw={500} mb={4}>
                Priority: {taskForm.values.priority}
              </Text>
              <Slider min={1} max={10} step={1} {...taskForm.getInputProps('priority')} />
            </div>

            <Group>
              <Text size="sm" fw={500}>
                Size
              </Text>
              <ProjectStars
                size={taskForm.values.size}
                onUpdate={(s) => taskForm.setFieldValue('size', s)}
              />
            </Group>

            <Textarea
              label="Notes"
              placeholder="Additional details..."
              autosize
              minRows={2}
              {...taskForm.getInputProps('notes')}
            />

            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={closeCreateTaskModal}>
                Cancel
              </Button>
              <Button type="submit">Create Task</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Container>
  );
}
