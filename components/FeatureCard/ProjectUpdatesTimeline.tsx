import React, { useState } from 'react';
import { IconBrandGmail, IconExternalLink, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Timeline,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useInstanceConfig } from '../../app/hooks/useInstanceConfig';
import { addProjectUpdate, deleteProjectUpdate, getProjectUpdates } from '../../app/lib/apiClient';
import type { ProjectUpdate } from '../../app/types/project.types';
import { absoluteTime, personLabel, relativeTime, TeamAvatar } from '../Team';

interface ProjectUpdatesTimelineProps {
  projectId: string;
  projectGmailThreadId?: string | null;
  /** False for viewers: notes are read-only */
  canEdit?: boolean;
}

export function ProjectUpdatesTimeline({
  projectId,
  projectGmailThreadId,
  canEdit = true,
}: ProjectUpdatesTimelineProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();

  const [note, setNote] = useState('');
  const [gmailThreadId, setGmailThreadId] = useState('');
  const { features } = useInstanceConfig();
  const [showAddForm, setShowAddForm] = useState(false);

  const queryKey = ['project-updates', projectId];

  const {
    data: updates,
    isLoading,
    isError,
    error,
  } = useQuery<ProjectUpdate[], Error>({
    queryKey,
    queryFn: () => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return getProjectUpdates(projectId, session.accessToken);
    },
    enabled: !!session?.accessToken && !!projectId,
  });

  const addMutation = useMutation({
    mutationFn: (data: { note: string; gmailThreadId?: string }) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return addProjectUpdate(projectId, data, session.accessToken);
    },
    onSuccess: (newUpdate) => {
      queryClient.setQueryData<ProjectUpdate[]>(queryKey, (old) =>
        old ? [...old, newUpdate] : [newUpdate]
      );
      setNote('');
      setGmailThreadId('');
      setShowAddForm(false);
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      notifications.show({
        title: 'Note added',
        message: 'Your note is on the task.',
        color: 'green',
      });
    },
    onError: (err: Error) => {
      notifications.show({
        title: 'Could not add note',
        message: err.message || 'Failed to add update.',
        color: 'red',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (updateId: string) => {
      if (!session?.accessToken) {
        throw new Error('Not authenticated');
      }
      return deleteProjectUpdate(projectId, updateId, session.accessToken);
    },
    onSuccess: (_data, updateId) => {
      queryClient.setQueryData<ProjectUpdate[]>(queryKey, (old) =>
        old ? old.filter((u) => u.id !== updateId) : []
      );
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      notifications.show({
        title: 'Note deleted',
        message: 'The note has been removed.',
        color: 'green',
      });
    },
    onError: (err: Error) => {
      notifications.show({
        title: 'Could not delete note',
        message: err.message || 'Failed to delete update.',
        color: 'red',
      });
    },
  });

  const handleAddUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) {
      return;
    }
    addMutation.mutate({
      note: note.trim(),
      gmailThreadId: gmailThreadId.trim() || undefined,
    });
  };

  const getGmailUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

  return (
    <Stack gap="sm" mt="xs">
      {/* Project-level Gmail Thread Link if present */}
      {features.gmail && projectGmailThreadId && (
        <Group gap="xs">
          <Badge leftSection={<IconBrandGmail size={14} />} variant="light" color="red" size="sm">
            Gmail Thread
          </Badge>
          <Anchor
            href={getGmailUrl(projectGmailThreadId)}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            c="blue"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            Open Project Email Thread
            <IconExternalLink size={12} />
          </Anchor>
        </Group>
      )}

      {/* Updates / Notes Section - Only show header if updates exist or form is active */}
      {((updates && updates.length > 0) || showAddForm) && (
        <Group justify="space-between" align="center">
          <Text size="sm" fw={600} c="dimmed">
            Updates & Notes {updates && updates.length > 0 ? `(${updates.length})` : ''}
          </Text>
          {!showAddForm && canEdit && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconPlus size={12} />}
              onClick={() => setShowAddForm(true)}
            >
              Add Update / Note
            </Button>
          )}
        </Group>
      )}

      {/* When no updates exist and form is closed, show a compact button to add one without empty placeholder text */}
      {(!updates || updates.length === 0) && !showAddForm && !isLoading && canEdit && (
        <Group justify="flex-start">
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPlus size={12} />}
            onClick={() => setShowAddForm(true)}
          >
            Add Update / Note
          </Button>
        </Group>
      )}

      {/* Inline Form to Add Update */}
      {showAddForm && (
        <Paper withBorder p="xs" radius="sm">
          <form onSubmit={handleAddUpdate}>
            <Stack gap="xs">
              <Textarea
                placeholder="Write an update or note..."
                value={note}
                onChange={(e) => setNote(e.currentTarget.value)}
                required
                autosize
                minRows={2}
                maxRows={6}
                data-autofocus
              />
              {features.gmail && (
                <TextInput
                  placeholder="Optional Gmail Thread ID"
                  label="Gmail Thread ID"
                  size="xs"
                  value={gmailThreadId}
                  onChange={(e) => setGmailThreadId(e.currentTarget.value)}
                  leftSection={<IconBrandGmail size={14} />}
                />
              )}
              <Group justify="flex-end" gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    setShowAddForm(false);
                    setNote('');
                    setGmailThreadId('');
                  }}
                  disabled={addMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  type="submit"
                  loading={addMutation.isPending}
                  disabled={!note.trim()}
                >
                  Save Update
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      )}

      {/* Loading & Error states */}
      {isLoading && <Loader size="xs" />}
      {isError && (
        <Text size="xs" c="red">
          Failed to load updates: {error?.message}
        </Text>
      )}

      {/* Timeline of Updates */}
      {updates && updates.length > 0 && (
        <Timeline active={updates.length} bulletSize={18} lineWidth={2}>
          {updates.map((update) => (
            <Timeline.Item
              key={update.id}
              title={
                <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
                  <Group gap="xs" wrap="nowrap" align="center">
                    {update.authorName ? (
                      <Group gap={4} wrap="nowrap">
                        <TeamAvatar name={update.authorName} seed={update.userId} size={18} />
                        <Text size="xs" fw={500}>
                          {personLabel(update.authorName, update.userId, userId)}
                        </Text>
                      </Group>
                    ) : null}
                    <Tooltip label={absoluteTime(update.createdAt)} withArrow openDelay={300}>
                      <Text size="xs" c="dimmed">
                        {relativeTime(update.createdAt)}
                      </Text>
                    </Tooltip>
                  </Group>
                  {update.canDelete !== false && (
                    <ActionIcon
                      size="xs"
                      color="red"
                      variant="subtle"
                      aria-label="Delete update"
                      loading={deleteMutation.isPending && deleteMutation.variables === update.id}
                      onClick={() => deleteMutation.mutate(update.id)}
                    >
                      <IconTrash size={12} />
                    </ActionIcon>
                  )}
                </Group>
              }
            >
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {update.note}
              </Text>
              {update.gmailThreadId && (
                <Group gap="xs" mt={4}>
                  <Anchor
                    href={getGmailUrl(update.gmailThreadId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="xs"
                    c="blue"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <IconBrandGmail size={14} color="#EA4335" />
                    Open Gmail Thread
                    <IconExternalLink size={12} />
                  </Anchor>
                </Group>
              )}
            </Timeline.Item>
          ))}
        </Timeline>
      )}
    </Stack>
  );
}
