'use client';

import React from 'react';
import Link from 'next/link';
import {
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconEye,
  IconFlag,
  IconFolder,
  IconPlus,
} from '@tabler/icons-react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Modal,
  Paper,
  Progress,
  RingProgress,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useOrganisationMembers } from '../../app/hooks/useOrganisationQueries';
import { useCreateProject, useUpdateProject } from '../../app/hooks/useProjectMutations';
import { useWorkspaceLookup, useWorkspaceProjects } from '../../app/hooks/useWorkspaces';
import { markdownToPlainText } from '../../app/lib/plainText';
import type { Epic } from '../../app/types/epic.types';
import type {
  Project,
  ProjectCreateInput,
  ProjectSize,
  ProjectStatus,
} from '../../app/types/project.types';
import { AssigneePicker } from '../ProjectPicker/AssigneePicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';
import {
  canEditItem,
  joinNames,
  TaskAssigneeAvatar,
  ViewOnlyTooltip,
  WorkspaceBadge,
} from '../Team';

interface CategoryDetailViewProps {
  categoryName: string;
  tasks: Project[];
  epics: Epic[];
}

export function CategoryDetailView({ categoryName, tasks, epics }: CategoryDetailViewProps) {
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure();
  const createProjectMutation = useCreateProject();
  const updateProjectMutation = useUpdateProject();
  const { userId } = useCurrentUser();
  const { projectOptions } = useWorkspaceProjects();
  const lookupWorkspace = useWorkspaceLookup();

  const categoryTasks = tasks.filter(
    (t) => (t.category || '').toLowerCase() === categoryName.toLowerCase()
  );

  // Which project (and workspace) this page is about: from its tasks, or the workspace list
  const sample = categoryTasks.find((t) => t.projectId) || categoryTasks[0];
  const container =
    projectOptions.find((p) => p.value === sample?.projectId) ||
    projectOptions.find((p) => p.projectName.toLowerCase() === categoryName.toLowerCase()) ||
    null;
  const projectId = sample?.projectId || container?.value || null;
  const orgId = sample?.orgId || container?.orgId || null;
  const isShared = sample ? !!sample.isShared : !!container?.isShared;
  const orgName = sample?.orgName || container?.orgLabel || null;
  const canEdit = sample ? canEditItem(sample) : (container?.canEdit ?? true);
  const workspace = lookupWorkspace(orgId, { orgName, isShared });

  const { data: members = [] } = useOrganisationMembers(isShared ? orgId || '' : '');
  const otherMembers = members
    .filter((m) => m.userId !== userId)
    .map((m) => m.userName || m.userEmail);
  const categoryEpics = epics.filter(
    (e) => (e.category || '').toLowerCase() === categoryName.toLowerCase()
  );

  const doTasks = categoryTasks.filter((t) => t.status === 'do');
  const awaitingTasks = categoryTasks.filter((t) => t.status === 'awaiting');
  const doneTasks = categoryTasks.filter((t) => t.status === 'done');
  const delayTasks = categoryTasks.filter((t) => t.status === 'delay');

  const totalCount = categoryTasks.length;
  const doneCount = doneTasks.length;
  const progressPercent = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  // New task form inside category
  const form = useForm<ProjectCreateInput>({
    initialValues: {
      project: '',
      reason: '',
      status: 'do' as ProjectStatus,
      priority: 5,
      size: '***' as ProjectSize,
      notes: '',
      category: categoryName,
      epicId: null as string | null,
      // undefined = the default (me); null = deliberately unassigned
      assigneeId: undefined as string | null | undefined,
      awaitUntil: null as string | null,
    },
    validate: {
      project: (val) => (val && val.trim().length > 0 ? null : 'Task name is required'),
    },
  });

  const handleCreateSubmit = ({ assigneeId, ...values }: typeof form.values) => {
    createProjectMutation.mutate({
      ...values,
      category: categoryName,
      ...(projectId ? { projectId } : {}),
      ...(isShared && assigneeId !== undefined && assigneeId !== userId ? { assigneeId } : {}),
      awaitUntil: values.status === 'awaiting' ? values.awaitUntil : null,
    });
    form.reset();
    closeCreateModal();
  };

  const handleQuickStatusChange = (task: Project, newStatus: ProjectStatus) => {
    if (!canEditItem(task)) {
      return;
    }
    updateProjectMutation.mutate({
      projectId: task.id,
      data: {
        status: newStatus,
        statusLastChangedOn: new Date().toISOString(),
        awaitUntil: newStatus === 'awaiting' ? task.awaitUntil : null,
      },
    });
  };

  const epicSelectData = categoryEpics.map((e) => ({
    value: e.id,
    label: e.title,
  }));

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        {/* Navigation & Header */}
        <Group justify="space-between" align="center">
          <Button
            component={Link}
            href="/projects"
            variant="subtle"
            leftSection={<IconArrowLeft size={16} />}
            size="sm"
          >
            All Projects
          </Button>

          <ViewOnlyTooltip viewOnly={!canEdit}>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={openCreateModal}
              color="blue"
              disabled={!canEdit}
            >
              New Task in {categoryName}
            </Button>
          </ViewOnlyTooltip>
        </Group>

        {/* Project Header Banner */}
        <Paper p="lg" radius="md" withBorder>
          <Group justify="space-between" align="center">
            <Group gap="md">
              <ThemeIcon size={48} radius="md" color="blue" variant="light">
                <IconFolder size={28} />
              </ThemeIcon>
              <div>
                <Group gap="xs" mb={4}>
                  <WorkspaceBadge
                    name={orgName}
                    isPersonal={workspace.isPersonal}
                    isShared={isShared}
                    sharedWith={otherMembers}
                  />
                  {isShared && otherMembers.length > 0 && (
                    <Text size="xs" c="dimmed">
                      Shared with {joinNames(otherMembers, 3)}
                    </Text>
                  )}
                </Group>
                <Title order={1} fz="h2">
                  {categoryName}
                </Title>
                <Text size="sm" c="dimmed">
                  {categoryTasks.length} tasks total · {categoryEpics.length}{' '}
                  {categoryEpics.length === 1 ? 'epic' : 'epics'}
                </Text>
              </div>
            </Group>

            <Group gap="lg">
              <RingProgress
                size={80}
                roundCaps
                thickness={8}
                sections={[{ value: progressPercent, color: 'blue' }]}
                label={
                  <Text fw={700} ta="center" size="sm">
                    {progressPercent}%
                  </Text>
                }
              />
            </Group>
          </Group>
        </Paper>

        {!canEdit && (
          <Alert color="gray" variant="light" icon={<IconEye size={18} />} title="View only">
            You can see this project but not change it.
          </Alert>
        )}

        {/* Active Epics Section */}
        {categoryEpics.length > 0 && (
          <Stack gap="md">
            <Title order={2} size="h3">
              Active Epics
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
              {categoryEpics.map((epic) => {
                const epicTasks = categoryTasks.filter((t) => t.epicId === epic.id);
                const epicDone = epicTasks.filter((t) => t.status === 'done').length;
                const epicTotal = epicTasks.length || (epic.totalTasks ?? 0);
                const pct =
                  epicTotal > 0
                    ? Math.round((epicDone / epicTotal) * 100)
                    : (epic.progressPercentage ?? 0);

                return (
                  <Card
                    key={epic.id}
                    component={Link}
                    href={`/epics/${epic.id}`}
                    shadow="sm"
                    padding="md"
                    radius="md"
                    withBorder
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Stack justify="space-between" h="100%" gap="sm">
                      <div>
                        <Group justify="space-between" mb="xs">
                          <Badge
                            color="violet"
                            variant="light"
                            leftSection={<IconFlag size={12} />}
                          >
                            Epic
                          </Badge>
                          <Badge
                            color={epic.status === 'completed' ? 'green' : 'blue'}
                            variant="dot"
                          >
                            {epic.status}
                          </Badge>
                        </Group>
                        <Text fw={600} fz="md" lineClamp={1}>
                          {epic.title}
                        </Text>
                        {epic.description && (
                          <Text size="xs" c="dimmed" lineClamp={2} mt={4}>
                            {epic.description}
                          </Text>
                        )}
                      </div>

                      <div>
                        <Group justify="space-between" mb={4}>
                          <Text size="xs" c="dimmed">
                            Progress
                          </Text>
                          <Text size="xs" fw={600}>
                            {pct}% ({epicDone}/{epicTotal} tasks)
                          </Text>
                        </Group>
                        <Progress value={pct} color="violet" radius="xl" size="sm" />
                      </div>
                    </Stack>
                  </Card>
                );
              })}
            </SimpleGrid>
          </Stack>
        )}

        {/* Tasks Section Grouped by Status */}
        <Stack gap="lg">
          <Title order={2} size="h3">
            Tasks in {categoryName}
          </Title>

          {/* DO TASKS */}
          <div>
            <Group justify="space-between" mb="xs">
              <Text fw={600} fz="md" c="blue">
                🔥 Do Now ({doTasks.length})
              </Text>
            </Group>
            {doTasks.length === 0 ? (
              <Text size="sm" c="dimmed" fs="italic">
                No active tasks in DO for {categoryName}.
              </Text>
            ) : (
              <Stack gap="xs">
                {doTasks.map((t) => (
                  <Paper
                    key={t.id}
                    p="sm"
                    radius="sm"
                    withBorder
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label="Mark as done"
                        disabled={!canEditItem(t)}
                        onClick={() => handleQuickStatusChange(t, 'done')}
                      >
                        <IconCheck size={18} />
                      </ActionIcon>
                      <div>
                        <AnchorTaskLink task={t} />
                        {t.reason && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {markdownToPlainText(t.reason)}
                          </Text>
                        )}
                      </div>
                    </Group>
                    <Group gap="xs">
                      <TaskAssigneeAvatar task={t} meId={userId} size={20} />
                      <ProjectStars size={t.size} />
                      <Badge size="sm" variant="light">
                        P{t.priority}
                      </Badge>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </div>

          <Divider />

          {/* AWAITING TASKS */}
          {awaitingTasks.length > 0 && (
            <div>
              <Text fw={600} fz="md" c="orange" mb="xs">
                ⏳ Awaiting ({awaitingTasks.length})
              </Text>
              <Stack gap="xs">
                {awaitingTasks.map((t) => (
                  <Paper
                    key={t.id}
                    p="sm"
                    radius="sm"
                    withBorder
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
                      <ThemeIcon color="orange" variant="light" size="sm">
                        <IconClock size={14} />
                      </ThemeIcon>
                      <div>
                        <AnchorTaskLink task={t} />
                        {t.awaitUntil && (
                          <Text size="xs" c="dimmed">
                            Returns {t.awaitUntil}
                          </Text>
                        )}
                      </div>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <TaskAssigneeAvatar task={t} meId={userId} size={20} />
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        disabled={!canEditItem(t)}
                        onClick={() => handleQuickStatusChange(t, 'do')}
                      >
                        Move to Do
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </div>
          )}

          {/* DELAY TASKS */}
          {delayTasks.length > 0 && (
            <div>
              <Text fw={600} fz="md" c="dimmed" mb="xs">
                💤 Delay ({delayTasks.length})
              </Text>
              <Stack gap="xs">
                {delayTasks.map((t) => (
                  <Paper
                    key={t.id}
                    p="sm"
                    radius="sm"
                    withBorder
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <AnchorTaskLink task={t} />
                    </div>
                    <Group gap="xs" wrap="nowrap">
                      <TaskAssigneeAvatar task={t} meId={userId} size={20} />
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        disabled={!canEditItem(t)}
                        onClick={() => handleQuickStatusChange(t, 'do')}
                      >
                        Move to Do
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </div>
          )}

          {/* DONE TASKS */}
          {doneTasks.length > 0 && (
            <div>
              <Text fw={600} fz="md" c="green" mb="xs">
                ✅ Done ({doneTasks.length})
              </Text>
              <Stack gap="xs">
                {doneTasks.map((t) => (
                  <Paper
                    key={t.id}
                    p="sm"
                    radius="sm"
                    withBorder
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Group gap="sm">
                      <ThemeIcon color="green" variant="light" size="sm">
                        <IconCheck size={14} />
                      </ThemeIcon>
                      <Text size="sm" style={{ textDecoration: 'line-through' }} c="dimmed">
                        {t.project}
                      </Text>
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      <TaskAssigneeAvatar task={t} meId={userId} size={20} />
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        disabled={!canEditItem(t)}
                        onClick={() => handleQuickStatusChange(t, 'do')}
                      >
                        Reopen
                      </Button>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </div>
          )}
        </Stack>
      </Stack>

      {/* Quick Add Modal */}
      <Modal
        opened={createModalOpened}
        onClose={closeCreateModal}
        title={`New Task in ${categoryName}`}
        centered
      >
        <form onSubmit={form.onSubmit(handleCreateSubmit)}>
          <Stack gap="sm">
            <TextInput
              label="Task Name"
              placeholder="What needs doing?"
              data-autofocus
              required
              {...form.getInputProps('project')}
            />

            <TextInput
              label="Reason (Why it matters)"
              placeholder="Why is this important?"
              {...form.getInputProps('reason')}
            />

            {isShared && (
              <AssigneePicker
                orgId={orgId}
                value={form.values.assigneeId === undefined ? userId : form.values.assigneeId}
                onChange={(id) => form.setFieldValue('assigneeId', id)}
              />
            )}

            {epicSelectData.length > 0 && (
              <Select
                label="Epic"
                placeholder="Assign to Epic (optional)"
                data={epicSelectData}
                clearable
                {...form.getInputProps('epicId')}
              />
            )}

            <Select
              label="Status"
              data={[
                { value: 'do', label: 'Do' },
                { value: 'delay', label: 'Delay' },
                { value: 'awaiting', label: 'Awaiting' },
              ]}
              {...form.getInputProps('status')}
            />

            {form.values.status === 'awaiting' && (
              <DatePickerInput
                label="Return Date"
                placeholder="Pick return date"
                valueFormat="D MMM YYYY"
                minDate={new Date()}
                value={form.values.awaitUntil ? new Date(form.values.awaitUntil) : null}
                onChange={(date) => {
                  form.setFieldValue(
                    'awaitUntil',
                    date instanceof Date ? date.toISOString().split('T')[0] : null
                  );
                }}
              />
            )}

            <div>
              <Text size="sm" fw={500} mb={4}>
                Priority: {form.values.priority}
              </Text>
              <Slider min={1} max={10} step={1} {...form.getInputProps('priority')} />
            </div>

            <Group>
              <Text size="sm" fw={500}>
                Effort Size
              </Text>
              <ProjectStars
                size={form.values.size}
                onUpdate={(s) => form.setFieldValue('size', s)}
              />
            </Group>

            <Textarea
              label="Notes"
              placeholder="Additional details..."
              autosize
              minRows={2}
              {...form.getInputProps('notes')}
            />

            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={closeCreateModal}>
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

function AnchorTaskLink({ task }: { task: Project }) {
  return (
    <Text
      component={Link}
      href={`/tasks/${task.id}`}
      size="sm"
      fw={500}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      {task.project}
    </Text>
  );
}
