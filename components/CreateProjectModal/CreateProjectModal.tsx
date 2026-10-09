'use client';

import { IconFlag, IconTarget } from '@tabler/icons-react';
import {
  Button,
  Group,
  Modal,
  Radio,
  Select,
  Slider,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useEpics } from '../../app/hooks/useEpicQueries';
import { useGoals } from '../../app/hooks/useGoalQueries';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { useWorkspaceProjects } from '../../app/hooks/useWorkspaces';
import type { ProjectCreateInput, ProjectSize, ProjectStatus } from '../../app/types/project.types';
import { AssigneePicker } from '../ProjectPicker/AssigneePicker';
import { buildEpicOptions, PRIVATE_GOAL_HINT, ProjectPicker } from '../ProjectPicker/ProjectPicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';

interface CreateProjectModalProps {
  opened: boolean;
  onClose: () => void;
  onSave: (newProjectData: ProjectCreateInput) => void;
}

interface CreateTaskFormValues {
  project: string;
  reason: string;
  status: ProjectStatus;
  priority: number;
  size: ProjectSize;
  projectId: string | null;
  /** undefined = the default (me); null = deliberately unassigned */
  assigneeId?: string | null;
  epicId: string | null;
  goalId: string | null;
  notes: string;
  awaitUntil: string | null;
}

export function CreateProjectModal({ opened, onClose, onSave }: CreateProjectModalProps) {
  const { data: epics = [] } = useEpics();
  const { data: goals = [] } = useGoals();
  const { features } = useInstanceConfig();
  const { findProject } = useWorkspaceProjects();
  const { userId } = useCurrentUser();

  const goalOptions = goals.map((g) => ({
    value: g.id,
    label: `[${g.type.toUpperCase()}] ${g.title}`,
  }));

  const form = useForm<CreateTaskFormValues>({
    initialValues: {
      project: '',
      reason: '',
      status: 'do',
      priority: 5,
      size: '***',
      projectId: null,
      assigneeId: undefined,
      epicId: null,
      goalId: null,
      notes: '',
      awaitUntil: null,
    },
    validate: {
      project: (value) => (value && value.trim().length > 0 ? null : 'Task name is required'),
      reason: (value) => (value && value.trim().length > 0 ? null : 'Reason is required'),
      awaitUntil: (value, values) =>
        values.status === 'awaiting' && (!value || value.trim().length === 0)
          ? 'Return date is required for awaiting tasks'
          : null,
    },
  });

  const chosenProject = findProject(form.values.projectId);
  const isSharedProject = !!chosenProject?.isShared;
  const epicOptions = buildEpicOptions(epics, {
    orgId: chosenProject?.orgId,
    projectId: form.values.projectId,
  });

  const handleProjectChange = (projectId: string | null) => {
    const previousOrg = findProject(form.values.projectId)?.orgId;
    const nextOrg = findProject(projectId)?.orgId;
    form.setFieldValue('projectId', projectId);
    if (previousOrg !== nextOrg) {
      // Epics and assignees belong to a workspace, so start again in the new one
      form.setFieldValue('epicId', null);
      form.setFieldValue('assigneeId', undefined);
    }
  };

  const handleClose = () => {
    form.reset();
    onClose();
  };

  const handleSubmit = (values: CreateTaskFormValues) => {
    const data: ProjectCreateInput = {
      project: values.project,
      reason: values.reason,
      status: values.status,
      priority: values.priority,
      size: values.size,
      notes: values.notes,
      awaitUntil: values.status === 'awaiting' ? values.awaitUntil : null,
    };
    if (values.projectId) {
      data.projectId = values.projectId;
    }
    // Only shared workspaces have anyone else to assign to; elsewhere the server defaults to me
    if (isSharedProject && values.assigneeId !== undefined && values.assigneeId !== userId) {
      data.assigneeId = values.assigneeId;
    }
    if (values.epicId) {
      data.epicId = values.epicId;
    }
    if (values.goalId) {
      data.goalId = values.goalId;
    }
    onSave(data);
    form.reset();
    onClose();
  };

  return (
    <Modal opened={opened} onClose={handleClose} title="New task" centered>
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Task name"
            placeholder="What needs doing?"
            required
            data-autofocus
            {...form.getInputProps('project')}
          />
          <TextInput
            label="Why it matters (Reason)"
            placeholder="Why is this worth doing?"
            required
            {...form.getInputProps('reason')}
          />
          <ProjectPicker
            label="Project"
            placeholder="Pick a project"
            description={
              chosenProject
                ? isSharedProject
                  ? `Shared: everyone in ${chosenProject.orgLabel} will see this task`
                  : 'Personal: only you will see this task'
                : undefined
            }
            value={form.values.projectId}
            onChange={handleProjectChange}
            clearable
          />
          {isSharedProject && (
            <AssigneePicker
              orgId={chosenProject?.orgId}
              // New tasks are mine unless I pick someone else
              value={form.values.assigneeId === undefined ? userId : form.values.assigneeId}
              onChange={(id) => form.setFieldValue('assigneeId', id)}
            />
          )}
          <Group grow align="flex-start">
            <Select
              label="Linked Epic"
              placeholder={epicOptions.length ? 'Optional epic' : 'No epics yet'}
              data={epicOptions}
              searchable
              clearable
              leftSection={<IconFlag size={16} />}
              comboboxProps={{ withinPortal: true }}
              {...form.getInputProps('epicId')}
            />
            {features.goals && (
              <Select
                label="Life Goal"
                description={PRIVATE_GOAL_HINT}
                placeholder="Optional life goal"
                data={goalOptions}
                searchable
                clearable
                leftSection={<IconTarget size={16} />}
                comboboxProps={{ withinPortal: true }}
                {...form.getInputProps('goalId')}
              />
            )}
          </Group>
          <Radio.Group
            name="status"
            label="Status"
            withAsterisk
            {...form.getInputProps('status')}
            onChange={(value) => {
              form.setFieldValue('status', value as ProjectStatus);
              if (value !== 'awaiting') {
                form.setFieldValue('awaitUntil', null);
              }
            }}
          >
            <Group mt="xs">
              <Radio value="do" label="Do" />
              <Radio value="delay" label="Delay" />
              <Radio value="delegate" label="Delegate" />
              <Radio value="awaiting" label="Awaiting" />
            </Group>
          </Radio.Group>

          {form.values.status === 'awaiting' && (
            <DatePickerInput
              label="Return date"
              placeholder="Pick a return date"
              valueFormat="D MMM YYYY"
              minDate={new Date()}
              clearable={false}
              required
              value={form.values.awaitUntil ? new Date(form.values.awaitUntil) : null}
              onChange={(date) => {
                form.setFieldValue(
                  'awaitUntil',
                  date instanceof Date ? date.toISOString().split('T')[0] : null
                );
              }}
              error={form.errors.awaitUntil}
            />
          )}

          <Text size="sm" fw={500}>
            Priority
          </Text>
          <Slider
            min={1}
            max={10}
            step={1}
            label={(value) => value.toFixed(0)}
            marks={[
              { value: 1, label: '1' },
              { value: 5, label: '5' },
              { value: 10, label: '10' },
            ]}
            {...form.getInputProps('priority')}
          />

          <Group>
            <Text size="sm" fw={500}>
              Size
            </Text>
            <ProjectStars
              size={form.values.size}
              onUpdate={(size) => form.setFieldValue('size', size)}
            />
          </Group>

          <Textarea
            label="Notes / Next Step"
            placeholder="Any notes, or the very next step"
            autosize
            minRows={2}
            {...form.getInputProps('notes')}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit">Create task</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
