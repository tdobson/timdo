'use client';

import { useEffect, useRef, useState } from 'react';
import { IconFlag, IconTarget } from '@tabler/icons-react';
import {
  Button,
  Group,
  Modal,
  Radio,
  ScrollArea,
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
import { notifyError } from '../../app/hooks/useProjectMutations';
import { useAddRef } from '../../app/hooks/useRefQueries';
import {
  useAddNoteInstead,
  useSimilarTasks,
  type SimilarTask,
} from '../../app/hooks/useSimilarTasks';
import { useWorkspaceProjects } from '../../app/hooks/useWorkspaces';
import type {
  ProjectCreateInput,
  ProjectSize,
  ProjectStatus,
  RefInput,
} from '../../app/types/project.types';
import { canonicalRef, parseRef, type ParseResult } from '../../workers/src/lib/refs';
import { AssigneePicker } from '../ProjectPicker/AssigneePicker';
import { buildEpicOptions, PRIVATE_GOAL_HINT, ProjectPicker } from '../ProjectPicker/ProjectPicker';
import { ProjectStars } from '../ProjectStars/ProjectStars';
import { RefKindIcon } from '../TaskDetail/refDisplay';
import { NoteInsteadForm } from './NoteInsteadForm';
import { SimilarTasksList, similarTaskWhere } from './SimilarTasksList';

/** The API takes at most this many refs with a new task. */
const MAX_LINKS = 20;

/**
 * The form scrolls inside a body of fixed height, so the similar tasks list (or a links
 * preview, or an error) appearing while someone types never moves the Create button.
 */
const FORM_BODY_HEIGHT = 720;
const FORM_BODY_MAX_HEIGHT = 'calc(100vh - 220px)';

interface LinkLine {
  line: number;
  text: string;
  result: ParseResult;
}

/** Each non-empty line of the Links field, parsed with the same parser the API uses. */
function parseLinkLines(text: string): LinkLine[] {
  return text
    .split('\n')
    .map((raw, i) => ({ line: i + 1, text: raw.trim() }))
    .filter((l) => l.text)
    .map((l) => ({ ...l, result: parseRef(l.text) }));
}

/** The refs to send: readable lines only, each once. */
function refsFromLines(lines: LinkLine[]): RefInput[] {
  const seen = new Set<string>();
  const refs: RefInput[] = [];
  lines.forEach(({ text, result }) => {
    if (result.ok && !seen.has(canonicalRef(result.value))) {
      seen.add(canonicalRef(result.value));
      refs.push({ ref: text });
    }
  });
  return refs;
}

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
  /** Links to outside things, one URL or kind:id per line */
  links: string;
}

export function CreateProjectModal({ opened, onClose, onSave }: CreateProjectModalProps) {
  const { data: epics = [] } = useEpics();
  const { data: goals = [] } = useGoals();
  const { findProject, workspaces } = useWorkspaceProjects();
  const { userId } = useCurrentUser();
  const addNote = useAddNoteInstead();
  const addRef = useAddRef();
  /** The existing task a note is being added to instead, or null while creating. */
  const [noteTarget, setNoteTarget] = useState<SimilarTask | null>(null);
  /** Non-null after a saved note has links left to retry, without posting the note again. */
  const [pendingNoteRefs, setPendingNoteRefs] = useState<RefInput[] | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const backToForm = useRef(false);

  // Coming back from the note form, carry on where the new task was being typed
  useEffect(() => {
    if (!noteTarget && backToForm.current) {
      backToForm.current = false;
      titleRef.current?.focus();
    }
  }, [noteTarget]);

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
      links: '',
    },
    validate: {
      project: (value) => (value && value.trim().length > 0 ? null : 'Task name is required'),
      reason: (value) => (value && value.trim().length > 0 ? null : 'Reason is required'),
      awaitUntil: (value, values) =>
        values.status === 'awaiting' && (!value || value.trim().length === 0)
          ? 'Return date is required for awaiting tasks'
          : null,
      links: (value) => {
        const lines = parseLinkLines(value);
        if (lines.some((l) => !l.result.ok)) {
          return 'Fix or remove the lines marked in red';
        }
        return refsFromLines(lines).length > MAX_LINKS
          ? `A new task can have at most ${MAX_LINKS} links`
          : null;
      },
    },
  });

  const linkLines = parseLinkLines(form.values.links);
  const { similar } = useSimilarTasks(form.values.project, {
    projectId: form.values.projectId,
    enabled: opened && !noteTarget,
  });

  /** Hide the action for viewers; the API resolves editability with each result. */
  const canAddNote = (task: SimilarTask) => task.canEdit;
  const isSharedTask = (task: SimilarTask) =>
    findProject(task.projectId)?.isShared ??
    workspaces.find((ws) => ws.org.id === task.orgId)?.isShared ??
    false;
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
    setNoteTarget(null);
    setPendingNoteRefs(null);
    onClose();
  };

  // Opening a similar task leaves an unsaved draft in place, in case it is needed after all
  const handleOpenSimilar = () => {
    if (pendingNoteRefs !== null) {
      handleClose();
      return;
    }
    setNoteTarget(null);
    onClose();
  };

  /** The typed title, reason and notes, one per line, as the note for the existing task. */
  const draftNote = () =>
    [form.values.project, form.values.reason, form.values.notes]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n');

  const handleAddNote = async (task: SimilarTask, note: string) => {
    const refs = pendingNoteRefs ?? refsFromLines(parseLinkLines(form.values.links));
    setSavingNote(true);
    if (pendingNoteRefs === null) {
      try {
        await addNote.mutateAsync({ task, note });
      } catch {
        // Toasted by the hook; stay on the note form so it can be tried again
        setSavingNote(false);
        return;
      }
    }
    // Ref additions are idempotent. Keep only failures, so a retry never repeats the saved note.
    const failed: RefInput[] = [];
    for (const input of refs) {
      try {
        await addRef.mutateAsync({ taskId: task.id, input });
      } catch (error) {
        failed.push(input);
        notifyError(`Could not add ${input.ref}`, error);
      }
    }
    setSavingNote(false);
    if (failed.length > 0) {
      setPendingNoteRefs(failed);
      return;
    }
    handleClose();
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
    const refs = refsFromLines(parseLinkLines(values.links));
    if (refs.length > 0) {
      data.refs = refs;
    }
    onSave(data);
    form.reset();
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={noteTarget ? 'Add a note instead' : 'New task'}
      centered
      closeOnEscape={!savingNote}
      closeOnClickOutside={!savingNote}
      closeButtonProps={{ disabled: savingNote }}
    >
      {noteTarget ? (
        <NoteInsteadForm
          key={noteTarget.id}
          task={noteTarget}
          initialNote={draftNote()}
          linkCount={refsFromLines(linkLines).length}
          where={similarTaskWhere(noteTarget, userId, isSharedTask(noteTarget))}
          saving={savingNote}
          saved={pendingNoteRefs !== null}
          failedLinks={pendingNoteRefs?.map((input) => input.ref) ?? []}
          onBack={() => {
            if (pendingNoteRefs !== null) {
              handleClose();
              return;
            }
            backToForm.current = true;
            setNoteTarget(null);
          }}
          onOpen={handleOpenSimilar}
          onSubmit={(note) => handleAddNote(noteTarget, note)}
        />
      ) : (
        <form onSubmit={form.onSubmit(handleSubmit)}>
          <ScrollArea
            style={{ height: FORM_BODY_HEIGHT, maxHeight: FORM_BODY_MAX_HEIGHT }}
            type="auto"
            offsetScrollbars="y"
            data-testid="create-form-body"
          >
            <Stack>
              <TextInput
                label="Task name"
                placeholder="What needs doing?"
                required
                data-autofocus
                ref={titleRef}
                {...form.getInputProps('project')}
              />
              <SimilarTasksList
                tasks={similar}
                meId={userId}
                canAddNote={canAddNote}
                isShared={isSharedTask}
                onOpen={handleOpenSimilar}
                onAddNote={setNoteTarget}
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

              <Stack gap={4}>
                <Textarea
                  label="Links"
                  description="Optional. One per line: a web address, or kind:id such as acme.member:123456"
                  placeholder="https://github.com/acme/widgets/issues/12"
                  autosize
                  minRows={1}
                  maxRows={6}
                  data-testid="create-links-input"
                  {...form.getInputProps('links')}
                />
                {linkLines.length > 0 && (
                  <Stack gap={2} aria-live="polite" data-testid="create-links-preview">
                    {linkLines.map(({ line, result }) =>
                      result.ok ? (
                        <Group key={line} gap={6} wrap="nowrap">
                          <RefKindIcon kind={result.value.kind} size={12} />
                          <Text size="xs" c="dimmed" truncate>
                            {result.value.label}
                          </Text>
                        </Group>
                      ) : (
                        <Text key={line} size="xs" c="red">
                          Line {line}: {result.error}
                        </Text>
                      )
                    )}
                  </Stack>
                )}
              </Stack>
            </Stack>
          </ScrollArea>

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit">Create task</Button>
          </Group>
        </form>
      )}
    </Modal>
  );
}
