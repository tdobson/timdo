import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import Link from 'next/link';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconBrandGmail,
  IconEye,
  IconFlag,
  IconGripVertical,
  IconTarget,
  IconUsers,
} from '@tabler/icons-react';
import {
  Accordion,
  Badge,
  Button,
  Grid,
  Group,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useEpics } from '../../app/hooks/useEpicQueries';
import { useGoals } from '../../app/hooks/useGoalQueries';
import { useClaimTask } from '../../app/hooks/useTaskMutations';
import { markdownToPlainText } from '../../app/lib/plainText';
import type {
  Project,
  ProjectSize,
  ProjectStatus,
  ProjectUpdateInput,
} from '../../app/types/project.types';
import { ProjectUpdatesTimeline } from '../FeatureCard/ProjectUpdatesTimeline';
import { MarkdownEditor } from '../MarkdownViewer/MarkdownEditor';
import { MarkdownViewer } from '../MarkdownViewer/MarkdownViewer';
import { buildEpicOptions, PRIVATE_GOAL_HINT, ProjectPicker } from '../ProjectPicker/ProjectPicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';
import {
  absoluteTime,
  canEditItem,
  personLabel,
  relativeTime,
  TeamAvatar,
  ViewOnlyTooltip,
  workspaceLabel,
} from '../Team';
import classes from './ProjectCard.module.css';

interface ProjectEditFormValues {
  project: string;
  reason?: string;
  notes?: string;
  customer?: string;
  tags?: string;
  size: ProjectSize;
  status: ProjectStatus;
  priority: number;
  projectId?: string | null;
  epicId?: string | null;
  goalId?: string | null;
  awaitUntil?: string | null;
  gmailThreadId?: string | null;
}

interface ProjectCardProps {
  project: Project;
  onUpdate: (projectId: string, updates: ProjectUpdateInput) => void;
  onStatusChange: (projectId: string, newStatus: ProjectStatus) => void;
  disableCollapse?: boolean;
}

const statusOptions: { value: ProjectStatus; label: string }[] = [
  { value: 'do', label: 'Do' },
  { value: 'delay', label: 'Delay' },
  { value: 'done', label: 'Done' },
  { value: 'delegate', label: 'Delegate' },
  { value: 'awaiting', label: 'Awaiting' },
];

export function ProjectCard({
  project,
  onUpdate,
  onStatusChange,
  disableCollapse = false,
}: ProjectCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const { data: epics } = useEpics();
  const { data: goals } = useGoals();
  const { userId, isMe } = useCurrentUser();
  const claimTaskMutation = useClaimTask();
  const linkedEpic = epics?.find((e) => e.id === project.epicId);
  const linkedGoal = goals?.find((g) => g.id === project.goalId);
  const canEdit = canEditItem(project);
  const isShared = !!project.isShared;
  const assigneeLabel = project.assigneeId
    ? personLabel(project.assigneeName, project.assigneeId, userId, { capitalise: false })
    : null;
  const updatedByOther =
    isShared && !!project.updatedById && !isMe(project.updatedById) && !!project.updatedByName;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    setActivatorNodeRef,
  } = useSortable({
    id: project.id,
    data: { type: 'Project', project },
    // View-only tasks can't be reordered or moved between statuses
    disabled: !canEdit,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const form = useForm<ProjectEditFormValues>({
    initialValues: {
      project: project.project,
      reason: project.reason || '',
      notes: project.notes || '',
      customer: project.customer || '',
      tags: Array.isArray(project.tags) ? project.tags.join(', ') : project.tags || '',
      size: project.size,
      status: project.status,
      priority: project.priority,
      projectId: project.projectId || null,
      epicId: project.epicId || null,
      goalId: project.goalId || null,
      awaitUntil: project.awaitUntil || null,
      gmailThreadId: project.gmailThreadId || null,
    },
    validate: {
      project: (value) => (value.trim().length > 0 ? null : 'Project name cannot be empty'),
      priority: (value) => (value >= 1 && value <= 10 ? null : 'Priority must be between 1 and 10'),
    },
  });

  const handleEditClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    form.setValues({
      project: project.project,
      reason: project.reason || '',
      notes: project.notes || '',
      customer: project.customer || '',
      tags: Array.isArray(project.tags) ? project.tags.join(', ') : project.tags || '',
      size: project.size,
      status: project.status,
      priority: project.priority,
      projectId: project.projectId || null,
      epicId: project.epicId || '',
      goalId: project.goalId || '',
      awaitUntil: project.awaitUntil || '',
      gmailThreadId: project.gmailThreadId || '',
    });
    setIsEditing(true);
  };

  const handleCancelClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    form.reset();
    setIsEditing(false);
  };

  const handleSaveClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    form.onSubmit(({ projectId, ...values }) => {
      // Empty form fields mean "none"
      const orNull = (v: string | null | undefined) => (v && v.trim() ? v : null);
      const updates: ProjectUpdateInput = {
        ...values,
        epicId: orNull(values.epicId),
        goalId: orNull(values.goalId),
        gmailThreadId: orNull(values.gmailThreadId),
        customer: orNull(values.customer),
        tags: orNull(values.tags),
        // Only send the project when it changed: moving is checked against both workspaces
        ...(projectId && projectId !== project.projectId ? { projectId } : {}),
        // Update statusLastChangedOn if status changed
        statusLastChangedOn:
          values.status !== project.status ? new Date().toISOString() : project.statusLastChangedOn,
        // Preserve awaitUntil unless explicitly changed, the user might flip back to awaiting
        awaitUntil:
          values.awaitUntil !== undefined ? orNull(values.awaitUntil) : project.awaitUntil,
      };
      onUpdate(project.id, updates);
      setIsEditing(false);
    })();
  };

  const getStatusButton = () => {
    switch (project.status) {
      case 'do':
        return (
          <Button
            size="xs"
            variant="light"
            disabled={!canEdit}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(project.id, 'done');
            }}
          >
            Mark as Done
          </Button>
        );
      case 'delay':
        return (
          <Button
            size="xs"
            variant="light"
            disabled={!canEdit}
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange(project.id, 'do');
            }}
          >
            Move to Do
          </Button>
        );
      case 'awaiting':
        return (
          <Button
            size="xs"
            variant="light"
            disabled={!canEdit}
            onClick={(e) => {
              e.stopPropagation();
              onUpdate(project.id, { status: 'do', awaitUntil: null });
            }}
          >
            Move to Do
          </Button>
        );
      default:
        return null;
    }
  };

  const statusButton = getStatusButton();

  const epicSelectData = buildEpicOptions(epics, {
    orgId: project.orgId,
    projectId: form.values.projectId,
  });

  const goalSelectData = (goals || []).map((g) => ({
    value: g.id,
    label: `[${g.type.toUpperCase()}] ${g.title}`,
  }));

  return (
    <Accordion.Item
      ref={setNodeRef}
      style={style}
      value={project.id}
      className={`${classes.card} ${isEditing ? classes.editing : ''}`}
      {...attributes}
      {...(!isEditing ? listeners : {})}
    >
      <Accordion.Control
        className={classes.control}
        data-testid={`project-card-control-${project.id}`}
        chevron={disableCollapse ? null : undefined}
        ref={!isEditing ? setActivatorNodeRef : undefined}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          {/* Drag handle - only visible and draggable when editing */}
          {isEditing && (
            <span
              ref={setActivatorNodeRef}
              {...listeners}
              className={classes.dragHandle}
              aria-label="Drag to reorder"
              style={{ display: 'inline-flex', cursor: 'grab', color: 'gray' }}
            >
              <IconGripVertical size={24} />
            </span>
          )}

          {isEditing ? (
            <TextInput
              className={classes.fullWidth}
              data-autofocus
              {...form.getInputProps('project')}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              {/* projectKey is the project's key (e.g. MIG), already shown by the category badge */}
              <Text fz="lg" fw={500} truncate style={{ flex: 1 }}>
                {project.project}
              </Text>
              {!canEdit && (
                <Tooltip label="View only: you can see this task but not change it" withArrow>
                  <Badge
                    size="xs"
                    variant="light"
                    color="gray"
                    leftSection={<IconEye size={10} />}
                    style={{ flexShrink: 0 }}
                  >
                    View only
                  </Badge>
                </Tooltip>
              )}
              {/* Who's on it: only in shared workspaces, so personal focus stays uncluttered */}
              {isShared && project.assigneeId && (
                <TeamAvatar
                  name={project.assigneeName}
                  seed={project.assigneeId}
                  size={22}
                  tooltip={`Assigned to ${assigneeLabel}`}
                  style={{ flexShrink: 0 }}
                />
              )}
              {isShared && !project.assigneeId && canEdit && (
                <Tooltip label="Unassigned. Take it on yourself" withArrow>
                  <UnstyledButton
                    component="span"
                    role="button"
                    tabIndex={0}
                    data-testid="claim-task-btn"
                    aria-label="Assign to me"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '2px 8px',
                      fontSize: 11,
                      fontWeight: 600,
                      borderRadius: 4,
                      whiteSpace: 'nowrap',
                      backgroundColor: 'var(--mantine-color-blue-light)',
                      color: 'var(--mantine-color-blue-light-color)',
                      flexShrink: 0,
                    }}
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      claimTaskMutation.mutate(project.id);
                    }}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        claimTaskMutation.mutate(project.id);
                      }
                    }}
                  >
                    Assign to me
                  </UnstyledButton>
                </Tooltip>
              )}
              {isShared && !project.assigneeId && !canEdit && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  Unassigned
                </Text>
              )}
              {project.customer && (
                <Badge
                  component={Link}
                  href={`/board?customer=${encodeURIComponent(project.customer)}`}
                  size="xs"
                  variant="filled"
                  color="teal"
                  onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                >
                  {project.customer}
                </Badge>
              )}
              {project.linkedTasks && project.linkedTasks.length > 0 && (
                <Badge
                  size="xs"
                  variant="light"
                  color="indigo"
                  title={project.linkedTasks.map((lt) => `#${lt.shortId}: ${lt.title}`).join(', ')}
                >
                  🔗 {project.linkedTasks.length}
                </Badge>
              )}
              {project.category && (
                <Tooltip
                  label={
                    isShared
                      ? `${project.category}, in the shared ${workspaceLabel({ name: project.orgName })} workspace`
                      : `Show only ${project.category}`
                  }
                  withArrow
                  openDelay={300}
                >
                  <Badge
                    component={Link}
                    href={`/board?category=${encodeURIComponent(project.category)}`}
                    size="xs"
                    variant="outline"
                    color={isShared ? 'grape' : 'blue'}
                    leftSection={isShared ? <IconUsers size={10} /> : undefined}
                    style={{ flexShrink: 0 }}
                    onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                  >
                    {project.category}
                  </Badge>
                </Tooltip>
              )}
              {linkedEpic && (
                <Badge
                  component={Link}
                  href={`/epics/${linkedEpic.id}`}
                  size="xs"
                  variant="light"
                  color="violet"
                  leftSection={<IconFlag size={10} />}
                  onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                >
                  {linkedEpic.title}
                </Badge>
              )}
              {linkedGoal && (
                <Badge
                  size="xs"
                  variant="light"
                  color="teal"
                  leftSection={<IconTarget size={10} />}
                >
                  {linkedGoal.title}
                </Badge>
              )}
              {project.status === 'awaiting' && project.awaitUntil && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  ⏳ Returns{' '}
                  {new Date(project.awaitUntil).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: '2-digit',
                  })}
                </Text>
              )}
            </Group>
          )}
          {/* NON-INTERACTIVE stars in the header */}
          <ProjectStars size={isEditing ? form.values.size : project.size} />
        </Group>
      </Accordion.Control>
      <Accordion.Panel className={classes.panel}>
        {isEditing ? (
          <Stack gap="xs">
            <TextInput
              label="Reason"
              placeholder="Why is this project important?"
              {...form.getInputProps('reason')}
            />
            <Grid gutter="xs">
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Status"
                  data={statusOptions}
                  {...form.getInputProps('status')}
                  required
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Customer / Client"
                  placeholder="e.g. Eco2Solar, Acme Solar"
                  {...form.getInputProps('customer')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <TextInput
                  label="Tags (comma-separated)"
                  placeholder="e.g. inverter, warranty"
                  {...form.getInputProps('tags')}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <ProjectPicker
                  value={form.values.projectId}
                  currentLabel={project.category}
                  onChange={(val) => form.setFieldValue('projectId', val)}
                  allowDeselect={false}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Linked Epic"
                  placeholder="Select Epic"
                  data={epicSelectData}
                  clearable
                  leftSection={<IconFlag size={14} />}
                  value={form.values.epicId}
                  onChange={(val) => form.setFieldValue('epicId', val)}
                />
              </Grid.Col>
              <Grid.Col span={{ base: 12, sm: 6 }}>
                <Select
                  label="Linked Life Goal"
                  description={PRIVATE_GOAL_HINT}
                  placeholder="Select Goal"
                  data={goalSelectData}
                  clearable
                  leftSection={<IconTarget size={14} />}
                  value={form.values.goalId}
                  onChange={(val) => form.setFieldValue('goalId', val)}
                />
              </Grid.Col>
            </Grid>
            {form.values.status === 'awaiting' && (
              <DatePickerInput
                label="Return date"
                placeholder="Pick a date"
                valueFormat="D MMM YYYY"
                minDate={new Date()}
                clearable={false}
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
              <Text size="sm" fw={500} mb="xs">
                Priority: {form.values.priority}
              </Text>
              <Slider
                min={1}
                max={10}
                step={1}
                marks={[
                  { value: 1, label: '1' },
                  { value: 5, label: '5' },
                  { value: 10, label: '10' },
                ]}
                {...form.getInputProps('priority')}
              />
            </div>
            <MarkdownEditor
              label="Description & Notes (Markdown)"
              placeholder="Additional details, checklists, specifications..."
              value={form.values.notes || ''}
              onChange={(val) => form.setFieldValue('notes', val)}
              minRows={4}
              maxRows={12}
            />
            <TextInput
              label="Gmail Thread ID"
              placeholder="e.g. 18dfa72b3c4d5e6f"
              leftSection={<IconBrandGmail size={14} />}
              {...form.getInputProps('gmailThreadId')}
            />
            {/* INTERACTIVE stars in the edit form */}
            <Group>
              <Text size="sm" fw={500}>
                Size
              </Text>
              <ProjectStars
                size={form.values.size}
                onUpdate={(size) => form.setFieldValue('size', size)}
              />
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs">
            {updatedByOther && (
              <Tooltip label={absoluteTime(project.updatedAt)} withArrow openDelay={300}>
                <Text size="xs" c="dimmed" w="fit-content" data-testid="updated-by">
                  Last updated by {project.updatedByName}
                  {project.updatedAt ? ` · ${relativeTime(project.updatedAt)}` : ''}
                </Text>
              </Tooltip>
            )}
            {project.reason && (
              <Text c="dimmed">
                <Text component="span" fw={700}>
                  Reason:
                </Text>{' '}
                {markdownToPlainText(project.reason)}
              </Text>
            )}
            {project.notes && (
              <div>
                <Text fw={700} size="sm" mb={4}>
                  Description:
                </Text>
                <MarkdownViewer content={project.notes} />
              </div>
            )}
            <ProjectUpdatesTimeline
              projectId={project.id}
              projectGmailThreadId={project.gmailThreadId}
              canEdit={canEdit}
            />
          </Stack>
        )}
        <Group justify="flex-end" className={classes.actionButtons}>
          {isEditing ? (
            <>
              <Button variant="default" size="xs" onClick={handleCancelClick}>
                Cancel
              </Button>
              <Button size="xs" onClick={handleSaveClick}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button
                component={Link}
                href={`/tasks/${project.id}`}
                size="xs"
                variant="light"
                color="gray"
                onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
              >
                View Details
              </Button>
              {statusButton && (
                <ViewOnlyTooltip viewOnly={!canEdit}>{statusButton}</ViewOnlyTooltip>
              )}
              <ViewOnlyTooltip viewOnly={!canEdit}>
                <Button size="xs" variant="default" onClick={handleEditClick} disabled={!canEdit}>
                  Edit
                </Button>
              </ViewOnlyTooltip>
              <ViewOnlyTooltip viewOnly={!canEdit}>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  disabled={!canEdit}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate(project.id, { isDeleted: true });
                  }}
                >
                  Delete
                </Button>
              </ViewOnlyTooltip>
            </>
          )}
        </Group>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
