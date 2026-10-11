'use client';

import React, { useState } from 'react';
import { IconDoorExit, IconInfoCircle, IconUserMinus } from '@tabler/icons-react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Popover,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useChangeRole, useRemoveMember } from '../../app/hooks/useSharingQueries';
import type {
  SharingMember,
  SharingWorkspace,
  WorkspaceRole,
} from '../../app/types/collaboration.types';
import { PersonAvatar } from '../Activity/PersonAvatar';
import { BotMarker } from '../Team/BotMarker';
import { ConfirmModal } from './ConfirmModal';
import {
  assignableRoles,
  canRemove,
  leaveState,
  personName,
  ROLE_COLOURS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_ORDER,
  workspaceLabel,
} from './sharingRules';

export function RoleBadge({ role, size = 'sm' }: { role: WorkspaceRole; size?: 'xs' | 'sm' }) {
  return (
    <Badge color={ROLE_COLOURS[role]} variant="light" size={size}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

/** Owner: everything. Admin: manage people and projects. ... */
export function RoleExplainer() {
  return (
    <Stack gap={4}>
      {ROLE_ORDER.map((role) => (
        <Text key={role} size="xs">
          <Text span inherit fw={600}>
            {ROLE_LABELS[role]}:
          </Text>{' '}
          <Text span inherit c="dimmed">
            {ROLE_DESCRIPTIONS[role].toLowerCase()}.
          </Text>
        </Text>
      ))}
    </Stack>
  );
}

export function RoleHelp() {
  return (
    <Popover width={260} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="What the roles mean">
          <IconInfoCircle size={16} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <RoleExplainer />
      </Popover.Dropdown>
    </Popover>
  );
}

type Pending = { type: 'remove' | 'leave'; member: SharingMember } | null;

export function PeopleSection({ workspace }: { workspace: SharingWorkspace }) {
  const changeRole = useChangeRole(workspace.id);
  const removeMember = useRemoveMember(workspace.id);
  const [pending, setPending] = useState<Pending>(null);
  const leave = leaveState(workspace);
  const label = workspaceLabel(workspace);

  const confirm = () => {
    if (!pending) {
      return;
    }
    removeMember.mutate(
      {
        userId: pending.member.userId,
        leaving: pending.type === 'leave',
        name: personName(pending.member),
      },
      { onSettled: () => setPending(null) }
    );
  };

  return (
    <Box>
      <Group gap={4} mb="xs">
        <Text fw={600} size="sm">
          People
        </Text>
        <RoleHelp />
      </Group>

      <Stack gap={0} component="ul" m={0} p={0} aria-label={`People in ${label}`}>
        {workspace.members.map((member, i) => {
          const roles = assignableRoles(workspace, member);
          const name = personName(member);
          const isBot = member.kind === 'bot' || member.userId.startsWith('bot|');
          return (
            <Group
              component="li"
              key={member.userId}
              justify="space-between"
              wrap="wrap"
              gap="xs"
              py="xs"
              style={{
                listStyle: 'none',
                borderTop:
                  i === 0
                    ? undefined
                    : '1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))',
              }}
              data-testid={`member-row-${member.userId}`}
            >
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: '1 1 220px' }}>
                <PersonAvatar
                  name={member.userName}
                  email={isBot ? null : member.userEmail}
                  seed={member.userId}
                />
                <Box style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500} truncate>
                      {name}
                    </Text>
                    <BotMarker kind={isBot ? 'bot' : member.kind} />
                    {member.isMe && (
                      <Badge size="xs" variant="outline" color="gray">
                        You
                      </Badge>
                    )}
                  </Group>
                  {!isBot && member.userName && member.userEmail && (
                    <Text size="xs" c="dimmed" truncate>
                      {member.userEmail}
                    </Text>
                  )}
                </Box>
              </Group>

              <Group gap="xs" wrap="nowrap" ml="auto">
                {roles ? (
                  <Select
                    size="xs"
                    w={150}
                    value={member.role}
                    allowDeselect={false}
                    aria-label={`Role for ${name}`}
                    data={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                    renderOption={({ option }) => (
                      <Box>
                        <Text size="sm">{option.label}</Text>
                        <Text size="xs" c="dimmed">
                          {ROLE_DESCRIPTIONS[option.value as WorkspaceRole]}
                        </Text>
                      </Box>
                    )}
                    comboboxProps={{ width: 220, position: 'bottom-end' }}
                    onChange={(value) => {
                      if (value && value !== member.role) {
                        changeRole.mutate({ userId: member.userId, role: value as WorkspaceRole });
                      }
                    }}
                    data-testid={`role-select-${member.userId}`}
                  />
                ) : (
                  <RoleBadge role={member.role} />
                )}

                {member.isMe ? (
                  !workspace.isPersonal || workspace.role !== 'owner' ? (
                    <Tooltip label={leave.reason} disabled={leave.canLeave} withArrow>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconDoorExit size={14} />}
                        disabled={!leave.canLeave}
                        onClick={() => setPending({ type: 'leave', member })}
                        // Disabled buttons don't fire hover events, so keep the tooltip working
                        style={!leave.canLeave ? { pointerEvents: 'all' } : undefined}
                      >
                        Leave
                      </Button>
                    </Tooltip>
                  ) : null
                ) : canRemove(workspace, member) ? (
                  <Tooltip label={`Remove ${name}`} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Remove ${name}`}
                      onClick={() => setPending({ type: 'remove', member })}
                      data-testid={`remove-member-${member.userId}`}
                    >
                      <IconUserMinus size={16} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Group>
            </Group>
          );
        })}
      </Stack>

      <ConfirmModal
        opened={!!pending}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        loading={removeMember.isPending}
        danger
        title={
          pending?.type === 'leave'
            ? `Leave ${label}?`
            : `Remove ${pending ? personName(pending.member) : ''}?`
        }
        confirmLabel={pending?.type === 'leave' ? 'Leave workspace' : 'Remove'}
      >
        <Text size="sm">
          {pending?.type === 'leave'
            ? `You will no longer see ${label} or any of its projects, epics and tasks. Someone will need to share it with you again to get back in.`
            : `${pending ? personName(pending.member) : 'They'} will no longer see ${label} or any of its projects, epics and tasks.`}
        </Text>
      </ConfirmModal>
    </Box>
  );
}
