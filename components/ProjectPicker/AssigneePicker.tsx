'use client';

import React, { useMemo } from 'react';
import { IconUser } from '@tabler/icons-react';
import { Group, Select, Text, type SelectProps } from '@mantine/core';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useOrganisationMembers } from '../../app/hooks/useOrganisationQueries';
import type { PersonKind } from '../../app/types/collaboration.types';
import { TeamAvatar } from '../Team';

/** Select value standing in for "nobody" (Mantine Select values must be strings). */
export const UNASSIGNED_VALUE = '__unassigned__';

export interface AssigneePickerProps
  extends Omit<SelectProps, 'data' | 'value' | 'onChange' | 'defaultValue'> {
  /** Workspace whose members can be picked */
  orgId: string | null | undefined;
  value: string | null | undefined;
  onChange: (assigneeId: string | null, assigneeName: string | null) => void;
  /** Name to show while members load, so the field never flashes empty */
  currentName?: string | null;
  /** Kind of the current value, when it came from a task response. */
  currentKind?: PersonKind | null;
  allowUnassigned?: boolean;
}

/**
 * Pick who a task is assigned to from the members of its workspace. "You" comes first.
 */
export function AssigneePicker({
  orgId,
  value,
  onChange,
  currentName,
  currentKind,
  allowUnassigned = true,
  label = 'Assignee',
  ...rest
}: AssigneePickerProps) {
  const { data: members = [], isLoading } = useOrganisationMembers(orgId || '');
  const { userId } = useCurrentUser();

  const options = useMemo(() => {
    const people = (Array.isArray(members) ? members : [])
      .filter((member) => member.kind !== 'bot' && !member.userId.startsWith('bot|'))
      .map((m) => ({
        value: m.userId,
        name: m.userName || m.userEmail || 'Someone',
        label:
          m.userId === userId
            ? `You (${m.userName || m.userEmail || 'Someone'})`
            : `${m.userName || m.userEmail || 'Someone'}${m.role === 'viewer' ? ' (view only)' : ''}`,
        isMe: m.userId === userId,
      }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name));

    // Never reintroduce a bot through the current-value fallback while members load.
    const currentValueIsBot = currentKind === 'bot' || !!value?.startsWith('bot|');
    if (value && !currentValueIsBot && !people.some((person) => person.value === value)) {
      people.unshift({
        value,
        name: currentName || 'Current assignee',
        label: value === userId ? 'You' : currentName || 'Current assignee',
        isMe: value === userId,
      });
    }
    return people;
  }, [members, userId, value, currentName, currentKind]);

  const data = [
    ...(allowUnassigned ? [{ value: UNASSIGNED_VALUE, label: 'Unassigned' }] : []),
    ...options.map(({ value: v, label: l }) => ({ value: v, label: l })),
  ];

  return (
    <Select
      label={label}
      data={data}
      value={value || (allowUnassigned ? UNASSIGNED_VALUE : null)}
      onChange={(next) => {
        if (!next || next === UNASSIGNED_VALUE) {
          onChange(null, null);
          return;
        }
        onChange(next, options.find((o) => o.value === next)?.name ?? null);
      }}
      allowDeselect={false}
      placeholder={isLoading ? 'Loading people...' : 'Pick someone'}
      leftSection={<IconUser size={16} />}
      comboboxProps={{ withinPortal: true }}
      renderOption={({ option }) =>
        option.value === UNASSIGNED_VALUE ? (
          <Text size="sm" c="dimmed">
            Unassigned
          </Text>
        ) : (
          <Group gap="xs" wrap="nowrap">
            <TeamAvatar
              name={options.find((o) => o.value === option.value)?.name}
              seed={option.value}
              size={20}
            />
            <Text size="sm">{option.label}</Text>
          </Group>
        )
      }
      {...rest}
    />
  );
}
