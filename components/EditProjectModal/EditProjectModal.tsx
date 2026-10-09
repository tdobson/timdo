import React from 'react';
import { IconBrandGmail } from '@tabler/icons-react';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import type { Project, ProjectSize, ProjectStatus } from '../../app/types/project.types';
import { ProjectUpdatesTimeline } from '../FeatureCard/ProjectUpdatesTimeline';

interface EditProjectModalProps {
  opened: boolean;
  onClose: () => void;
  project: Project;
  onSave: (updatedProject: Project) => void;
}

const statusOptions: { value: ProjectStatus; label: string }[] = [
  { value: 'do', label: 'Do' },
  { value: 'delay', label: 'Delay' },
  { value: 'done', label: 'Done' },
  { value: 'delegate', label: 'Delegate' },
  { value: 'awaiting', label: 'Awaiting' },
];

const sizeOptions: { value: ProjectSize; label: string }[] = [
  { value: '*', label: '* (Smallest)' },
  { value: '**', label: '**' },
  { value: '***', label: '***' },
  { value: '****', label: '****' },
  { value: '*****', label: '***** (Largest)' },
];

export function EditProjectModal({ opened, onClose, project, onSave }: EditProjectModalProps) {
  const { features } = useInstanceConfig();
  const form = useForm({
    initialValues: {
      project: project.project,
      reason: project.reason || '',
      notes: project.notes || '',
      status: project.status,
      priority: project.priority,
      size: project.size,
      awaitUntil: project.awaitUntil || null,
      gmailThreadId: project.gmailThreadId || '',
    },
    validate: {
      project: (value) => (value.trim().length > 0 ? null : 'Project name cannot be empty'),
      priority: (value) => (value >= 1 && value <= 10 ? null : 'Priority must be between 1 and 10'),
    },
  });

  const handleSubmit = (values: typeof form.values) => {
    const updatedProject: Project = {
      ...project,
      ...values,
      gmailThreadId: values.gmailThreadId ? values.gmailThreadId.trim() : null,
      // Update statusLastChangedOn if status changed
      statusLastChangedOn:
        values.status !== project.status ? new Date().toISOString() : project.statusLastChangedOn,
    };
    onSave(updatedProject);
    onClose();
  };

  // Reset form when modal opens with new project
  React.useEffect(() => {
    if (opened) {
      form.setValues({
        project: project.project,
        reason: project.reason || '',
        notes: project.notes || '',
        status: project.status,
        priority: project.priority,
        size: project.size,
        awaitUntil: project.awaitUntil || null,
        gmailThreadId: project.gmailThreadId || '',
      });
    }
  }, [opened, project]);

  return (
    <Modal opened={opened} onClose={onClose} title="Edit Project" centered size="lg">
      <form onSubmit={form.onSubmit(handleSubmit)}>
        <Stack>
          <TextInput
            label="Project Name"
            placeholder="Enter project name"
            required
            {...form.getInputProps('project')}
          />
          <TextInput
            label="Reason"
            placeholder="Why is this project important?"
            {...form.getInputProps('reason')}
          />
          <Select label="Status" data={statusOptions} {...form.getInputProps('status')} required />
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
          <NumberInput
            label="Priority"
            placeholder="1-10"
            min={1}
            max={10}
            required
            {...form.getInputProps('priority')}
          />
          <Select label="Size" data={sizeOptions} {...form.getInputProps('size')} required />
          <Textarea
            label="Notes"
            placeholder="Additional details or context"
            autosize
            minRows={3}
            {...form.getInputProps('notes')}
          />
          {features.gmail && (
            <TextInput
              label="Gmail Thread ID"
              placeholder="e.g. 18dfa72b3c4d5e6f"
              leftSection={<IconBrandGmail size={14} />}
              {...form.getInputProps('gmailThreadId')}
            />
          )}
          <ProjectUpdatesTimeline
            projectId={project.id}
            projectGmailThreadId={features.gmail ? project.gmailThreadId : null}
          />
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
