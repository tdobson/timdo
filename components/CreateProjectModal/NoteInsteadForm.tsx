'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { IconArrowLeft } from '@tabler/icons-react';
import { Anchor, Badge, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import type { SimilarTask } from '../../app/hooks/useSimilarTasks';

interface NoteInsteadFormProps {
  task: SimilarTask;
  /** What was typed into the new task form, ready to edit */
  initialNote: string;
  /** How many links from the new task form will be added to this task as well */
  linkCount: number;
  /** Shown under the task, e.g. "Installation · Robin Fairweather" */
  where: string;
  saving: boolean;
  saved: boolean;
  failedLinks: string[];
  onBack: () => void;
  onOpen: () => void;
  onSubmit: (note: string) => void;
}

/**
 * The create modal turned into "add a note to that task": the typed title and reason become
 * the note, which can be edited before it is added. Back returns to the unsaved new task form.
 * After saving, only missing links can be retried, or Done closes the form.
 */
export function NoteInsteadForm({
  task,
  initialNote,
  linkCount,
  where,
  saving,
  saved,
  failedLinks,
  onBack,
  onOpen,
  onSubmit,
}: NoteInsteadFormProps) {
  const [note, setNote] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // This form replaces the one that had focus, so move focus here, at the end of the note
  useEffect(() => {
    const field = noteRef.current;
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) {
          return;
        }
        if (!saved && !note.trim()) {
          setError('Write the note to add');
          return;
        }
        onSubmit(note.trim());
      }}
    >
      <Stack data-testid="note-instead-form">
        <Stack gap={2}>
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
              #{task.shortId}
            </Badge>
            <Anchor
              component={Link}
              href={`/tasks/${task.id}`}
              size="sm"
              fw={600}
              truncate
              onClick={(event) => {
                if (saving) {
                  event.preventDefault();
                  return;
                }
                onOpen();
              }}
              aria-disabled={saving}
              title={task.title}
            >
              {task.title}
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            {where}
          </Text>
        </Stack>
        <Textarea
          label="Note"
          description="Added to that task, signed with your name. No new task is created."
          autosize
          minRows={3}
          maxRows={10}
          ref={noteRef}
          value={note}
          readOnly={saved || saving}
          error={error}
          onChange={(e) => {
            setNote(e.currentTarget.value);
            setError(null);
          }}
        />
        {saved ? (
          <Stack gap={4} role="status">
            <Text size="sm" fw={500}>
              {failedLinks.length === 1
                ? 'Your note is saved. 1 link still needs adding.'
                : `Your note is saved. ${failedLinks.length} links still need adding.`}
            </Text>
            <Text size="xs" c="dimmed">
              Only missing links will be retried.
            </Text>
            <Stack gap={2} style={{ maxHeight: 120, overflowY: 'auto' }}>
              {failedLinks.map((ref) => (
                <Text key={ref} size="xs" style={{ overflowWrap: 'anywhere' }}>
                  {ref}
                </Text>
              ))}
            </Stack>
          </Stack>
        ) : linkCount > 0 ? (
          <Text size="xs" c="dimmed">
            {linkCount === 1
              ? 'Your link will be added to that task as well.'
              : `Your ${linkCount} links will be added to that task as well.`}
          </Text>
        ) : null}
        <Group justify="space-between" mt="md">
          <Button
            variant="default"
            leftSection={saved ? undefined : <IconArrowLeft size={14} />}
            onClick={onBack}
            disabled={saving}
          >
            {saved ? 'Done' : 'Back to new task'}
          </Button>
          <Button type="submit" loading={saving}>
            {saved ? 'Retry missing links' : 'Add note'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
