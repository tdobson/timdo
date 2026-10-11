'use client';

import React, { useState } from 'react';
import {
  IconBuilding,
  IconCheck,
  IconDots,
  IconEye,
  IconHistory,
  IconLock,
  IconPencil,
  IconTrash,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import {
  Accordion,
  ActionIcon,
  Box,
  Card,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDeleteWorkspace, useRenameWorkspace } from '../../app/hooks/useSharingQueries';
import type { SharingWorkspace } from '../../app/types/collaboration.types';
import { ActivityFeed } from '../Activity/ActivityFeed';
import { AddPeopleForm } from './AddPeopleForm';
import { ConfirmModal } from './ConfirmModal';
import { PendingInvites } from './PendingInvites';
import { PeopleSection, RoleBadge } from './PeopleSection';
import { ProjectsSection } from './ProjectsSection';
import { canManage, plural, whoCanSee, workspaceLabel } from './sharingRules';
import { WorkspaceBotsPanel } from './WorkspaceBotsPanel';

function WorkspaceName({ workspace }: { workspace: SharingWorkspace }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const rename = useRenameWorkspace();
  const canRename = canManage(workspace.role) && !workspace.isPersonal;
  const label = workspaceLabel(workspace);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === workspace.name) {
      setEditing(false);
      setName(workspace.name);
      return;
    }
    rename.mutate({ orgId: workspace.id, name: trimmed }, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    return (
      <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <TextInput
          aria-label="Workspace name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              setEditing(false);
              setName(workspace.name);
            }
          }}
          maxLength={80}
          autoFocus
          size="sm"
          style={{ flex: 1, maxWidth: 360 }}
          disabled={rename.isPending}
        />
        <ActionIcon
          variant="light"
          color="teal"
          aria-label="Save name"
          onClick={save}
          loading={rename.isPending}
        >
          <IconCheck size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Cancel rename"
          onClick={() => {
            setEditing(false);
            setName(workspace.name);
          }}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
    );
  }

  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
      <Title order={3} size="h4" style={{ overflowWrap: 'anywhere' }}>
        {label}
      </Title>
      {canRename && (
        <Tooltip label="Rename" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Rename ${label}`}
            onClick={() => {
              setName(workspace.name);
              setEditing(true);
            }}
          >
            <IconPencil size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

export interface WorkspaceCardProps {
  workspace: SharingWorkspace;
  allWorkspaces: SharingWorkspace[];
}

export function WorkspaceCard({ workspace, allWorkspaces }: WorkspaceCardProps) {
  const [activityOpen, setActivityOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteWorkspace();
  const manage = canManage(workspace.role);
  const label = workspaceLabel(workspace);
  const onlyMe = workspace.members.every((m) => m.isMe);
  const canDelete =
    workspace.role === 'owner' && !workspace.isPersonal && workspace.projects.length === 0;

  return (
    <Card
      withBorder
      radius="md"
      padding="lg"
      shadow="xs"
      component="section"
      aria-label={`${label} workspace`}
      data-testid={`workspace-card-${workspace.id}`}
    >
      <Stack gap="md">
        {/* Header */}
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
          <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: 1 }}>
            <ThemeIcon
              size={38}
              radius="md"
              variant="light"
              color={workspace.isPersonal ? 'gray' : 'blue'}
              aria-hidden
            >
              {workspace.isPersonal ? <IconLock size={20} /> : <IconBuilding size={20} />}
            </ThemeIcon>
            <Box style={{ minWidth: 0, flex: 1 }}>
              <WorkspaceName workspace={workspace} />
              <Group gap={6} mt={4} wrap="wrap">
                <RoleBadge role={workspace.role} size="xs" />
                <Group gap={4} wrap="nowrap">
                  <IconUsers size={13} aria-hidden style={{ opacity: 0.6 }} />
                  <Text size="xs" c="dimmed">
                    {plural(workspace.members.length, 'person', 'people')}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" aria-hidden>
                  ·
                </Text>
                <Text size="xs" c="dimmed">
                  {plural(workspace.projects.filter((p) => !p.isArchived).length, 'project')}
                </Text>
              </Group>
            </Box>
          </Group>

          {canDelete && (
            <Menu position="bottom-end" withinPortal shadow="md">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label={`More actions for ${label}`}>
                  <IconDots size={18} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete workspace
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>

        {/* Who can see this */}
        <Group
          gap="xs"
          wrap="nowrap"
          p="xs"
          style={{
            borderRadius: 'var(--mantine-radius-sm)',
            background: 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))',
          }}
          data-testid="who-can-see"
        >
          <IconEye size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
          <Text size="sm">
            {workspace.isPersonal && onlyMe
              ? 'Only you can see this unless you share it'
              : whoCanSee(workspace)}
            {workspace.invites.length > 0 && (
              <Text span inherit c="dimmed">
                {' '}
                ({plural(workspace.invites.length, 'invite')} waiting)
              </Text>
            )}
          </Text>
        </Group>

        <PeopleSection workspace={workspace} />

        {manage && !workspace.isPersonal && <WorkspaceBotsPanel workspace={workspace} />}

        {manage && (
          <>
            <Divider />
            <AddPeopleForm workspace={workspace} />
            <PendingInvites workspace={workspace} />
          </>
        )}

        <Divider />
        <ProjectsSection workspace={workspace} allWorkspaces={allWorkspaces} />

        <Accordion
          value={activityOpen}
          onChange={setActivityOpen}
          variant="contained"
          radius="md"
          chevronPosition="right"
        >
          <Accordion.Item value="activity">
            <Accordion.Control icon={<IconHistory size={16} />}>
              <Text size="sm" fw={500}>
                Recent activity
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              {/* Only fetch once opened */}
              {activityOpen === 'activity' && (
                <ActivityFeed orgId={workspace.id} limit={15} compact />
              )}
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>

      <ConfirmModal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(workspace.id, { onSuccess: () => setConfirmDelete(false) })}
        loading={remove.isPending}
        danger
        title={`Delete ${label}?`}
        confirmLabel="Delete workspace"
      >
        <Text size="sm">
          {onlyMe
            ? 'It has no projects, so nothing else is lost.'
            : 'It has no projects. Everyone in it will lose access to the workspace itself.'}
        </Text>
      </ConfirmModal>
    </Card>
  );
}
