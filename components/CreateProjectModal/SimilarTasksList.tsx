'use client';

import Link from 'next/link';
import { Anchor, Badge, Button, Group, Stack, Text } from '@mantine/core';
import type { SimilarTask } from '../../app/hooks/useSimilarTasks';

interface SimilarTasksListProps {
  tasks: SimilarTask[];
  /** The signed-in user, so their own tasks say "You" */
  meId: string | null | undefined;
  /** Whether I can add notes in that task's workspace (false for viewers) */
  canAddNote: (task: SimilarTask) => boolean;
  /** Whether the task's workspace has anyone else in it, so the assignee is worth showing */
  isShared: (task: SimilarTask) => boolean;
  onOpen: (task: SimilarTask) => void;
  onAddNote: (task: SimilarTask) => void;
}

function assigneeLabel(task: SimilarTask, meId: string | null | undefined): string {
  if (!task.assigneeId) {
    return 'Unassigned';
  }
  return task.assigneeId === meId ? 'You' : task.assigneeName || 'Someone else';
}

/** "Installation · Robin Fairweather" in a shared workspace, just "Installation" in a personal one. */
export function similarTaskWhere(
  task: SimilarTask,
  meId: string | null | undefined,
  shared: boolean
): string {
  return shared ? `${task.projectName} · ${assigneeLabel(task, meId)}` : task.projectName;
}

/**
 * A quiet "did you mean" list under the new task's title: up to three open tasks that look
 * the same, each with Open and "Add a note there instead". Renders nothing when there are none.
 */
export function SimilarTasksList({
  tasks,
  meId,
  canAddNote,
  isShared,
  onOpen,
  onAddNote,
}: SimilarTasksListProps) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <Stack gap={6} role="region" aria-label="Similar open tasks" data-testid="similar-tasks">
      <Text size="xs" fw={600} c="dimmed">
        Similar open tasks
      </Text>
      <Stack gap={4} role="list">
        {tasks.map((task) => {
          const where = similarTaskWhere(task, meId, isShared(task));
          return (
            <Stack
              key={task.id}
              role="listitem"
              gap={0}
              px="xs"
              py={4}
              style={{
                borderRadius: 'var(--mantine-radius-sm)',
                backgroundColor: 'var(--mantine-color-default-hover)',
              }}
            >
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                  #{task.shortId}
                </Badge>
                <Text size="sm" fw={500} truncate title={task.title}>
                  {task.title}
                </Text>
              </Group>
              <Group gap="xs" wrap="nowrap" justify="space-between">
                <Text size="xs" c="dimmed" truncate>
                  {where}
                </Text>
                <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                  <Anchor
                    component={Link}
                    href={`/tasks/${task.id}`}
                    size="xs"
                    onClick={() => onOpen(task)}
                    aria-label={`Open #${task.shortId} ${task.title}`}
                  >
                    Open
                  </Anchor>
                  {canAddNote(task) && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      onClick={() => onAddNote(task)}
                      aria-label={`Add a note there instead: #${task.shortId} ${task.title}`}
                    >
                      Add a note there instead
                    </Button>
                  )}
                </Group>
              </Group>
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}
