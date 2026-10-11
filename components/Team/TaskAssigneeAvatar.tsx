'use client';

import React from 'react';
import { Badge, Group, Tooltip } from '@mantine/core';
import type { Project } from '../../app/types/project.types';
import { BotMarker } from './BotMarker';
import { TeamAvatar } from './TeamAvatar';
import { personLabel } from './teamFormat';

/**
 * Who's on a task, as a small avatar. Renders nothing outside shared workspaces so personal
 * lists stay uncluttered.
 */
export function TaskAssigneeAvatar({
  task,
  meId,
  size = 20,
}: {
  task: Pick<Project, 'isShared' | 'assigneeId' | 'assigneeName' | 'assigneeKind'>;
  meId: string | null;
  size?: number;
}) {
  if (!task.isShared) {
    return null;
  }
  if (!task.assigneeId) {
    return (
      <Tooltip label="Unassigned" withArrow>
        <Badge size="xs" variant="outline" color="gray" aria-label="Unassigned">
          ?
        </Badge>
      </Tooltip>
    );
  }
  const isBot = task.assigneeKind === 'bot' || task.assigneeId.startsWith('bot|');
  return (
    <Group gap={4} wrap="nowrap" aria-label={isBot ? 'Bot assignee' : undefined}>
      <TeamAvatar
        name={task.assigneeName}
        seed={task.assigneeId}
        size={size}
        tooltip={`Assigned to ${personLabel(task.assigneeName, task.assigneeId, meId, { capitalise: false })}${isBot ? ' [bot]' : ''}`}
      />
      <BotMarker kind={isBot ? 'bot' : task.assigneeKind} />
    </Group>
  );
}
