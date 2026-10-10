'use client';

import React, { useMemo } from 'react';
import { IconCategory } from '@tabler/icons-react';
import { Select, type SelectProps } from '@mantine/core';
import { useWorkspaceProjects, type ProjectOption } from '../../app/hooks/useWorkspaces';
import type { Epic } from '../../app/types/epic.types';

export interface ProjectPickerProps
  extends Omit<SelectProps, 'data' | 'value' | 'onChange' | 'defaultValue'> {
  /** Selected project (container) id */
  value: string | null | undefined;
  onChange: (projectId: string | null, option: ProjectOption | null) => void;
  /**
   * Shown when the current project isn't one I can add to (e.g. a view-only project), so the
   * field still reads correctly instead of looking empty.
   */
  currentLabel?: string | null;
}

/**
 * Project picker grouped by workspace. Only lists projects I can add to: view-only workspaces are
 * left out.
 */
export function ProjectPicker({
  value,
  onChange,
  currentLabel,
  label = 'Project',
  placeholder = 'Pick a project',
  ...rest
}: ProjectPickerProps) {
  const { editableProjectGroups, findProject, isLoading } = useWorkspaceProjects();

  const data = useMemo(() => {
    const known = editableProjectGroups.some((g) => g.items.some((i) => i.value === value));
    if (value && !known && currentLabel) {
      return [
        { group: 'Current', items: [{ value, label: currentLabel }] },
        ...editableProjectGroups,
      ];
    }
    return editableProjectGroups;
  }, [editableProjectGroups, value, currentLabel]);

  return (
    <Select
      label={label}
      placeholder={isLoading ? 'Loading projects...' : placeholder}
      data={data}
      value={value || null}
      onChange={(id) => onChange(id, findProject(id))}
      searchable
      nothingFoundMessage="No matching project"
      leftSection={<IconCategory size={16} />}
      comboboxProps={{ withinPortal: true }}
      {...rest}
    />
  );
}

/**
 * Epic options for a task, grouped by project. When `orgId` is given only epics from that
 * workspace are offered, since a task can't link to an epic in another workspace.
 */
export function buildEpicOptions(
  epics: Epic[] | undefined,
  { orgId, projectId }: { orgId?: string | null; projectId?: string | null } = {}
) {
  const pool = (epics || []).filter((e) => !orgId || !e.orgId || e.orgId === orgId);
  const groups = new Map<string, { value: string; label: string }[]>();
  pool
    .slice()
    .sort((a, b) => {
      // The task's own project first, then alphabetically
      const aOwn = projectId && a.projectId === projectId ? 0 : 1;
      const bOwn = projectId && b.projectId === projectId ? 0 : 1;
      return aOwn - bOwn || (a.category || '').localeCompare(b.category || '');
    })
    .forEach((e) => {
      const group = e.category || 'No project';
      const items = groups.get(group) || [];
      items.push({ value: e.id, label: e.title });
      groups.set(group, items);
    });
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items }));
}

/** Life goal links are private to each person; this is the helper text for every goal picker. */
export const PRIVATE_GOAL_HINT = 'Only you can see your life goal links';
