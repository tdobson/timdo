import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { IconLink, IconSearch, IconUsers } from '@tabler/icons-react';
import {
  Badge,
  Box,
  Checkbox,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { useProjects } from '../../app/hooks/useProjectQueries';
import { useTaskSearch } from '../../app/hooks/useSearchQueries';
import type { Project } from '../../app/types/project.types';
import { parseRef } from '../../workers/src/lib/refs';
import { RefKindIcon } from '../TaskDetail/refDisplay';
import { TaskAssigneeAvatar, workspaceLabel } from '../Team';

/** What a pasted link or kind:id was read as, or null for ordinary words. */
function readAsRef(query: string) {
  const text = query.trim();
  if (text.length < 2 || /\s/.test(text)) {
    return null;
  }
  const parsed = parseRef(text);
  return parsed.ok ? parsed.value : null;
}

interface QuickSearchModalProps {
  opened: boolean;
  onClose: () => void;
}

export function QuickSearchModal({ opened, onClose }: QuickSearchModalProps) {
  const [query, setQuery] = useState('');
  const [includeDone, setIncludeDone] = useState(false);
  const { data, isLoading, isError, error } = useTaskSearch(query, includeDone);
  // Results that carry the pasted link exactly come first, flagged by the API
  const results = data;
  const pastedRef = readAsRef(query);
  // Search results are bare; borrow project, workspace and assignee from the loaded tasks
  const { data: tasks } = useProjects();
  const { userId } = useCurrentUser();
  const taskById = useMemo(() => {
    const map = new Map<string, Project>();
    (tasks || []).forEach((t) => map.set(t.id, t));
    return map;
  }, [tasks]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <IconSearch size={20} />
          <Text fw={600}>Search Tasks & Notes</Text>
        </Group>
      }
      size="lg"
      padding="md"
    >
      <Stack gap="md">
        <TextInput
          data-autofocus
          aria-label="Search tasks"
          placeholder="Search by keywords, error codes, customer, or paste a link..."
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          rightSection={isLoading ? <Loader size={16} /> : null}
        />

        <Group justify="space-between">
          {pastedRef ? (
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }} data-testid="search-ref">
              <RefKindIcon kind={pastedRef.kind} size={14} />
              <Text size="xs" c="dimmed" truncate>
                Tasks linked to {pastedRef.label} come first, done ones included
              </Text>
            </Group>
          ) : (
            <Text size="xs" c="dimmed" style={{ flex: 1 }}>
              Searches titles, reasons, customers and notes on every task you can see, in all your
              workspaces. Paste a link to find the tasks that carry it, done ones included.
            </Text>
          )}
          <Checkbox
            label="Include completed"
            size="xs"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.currentTarget.checked)}
          />
        </Group>

        <Stack gap="xs" style={{ maxHeight: 400, overflowY: 'auto' }}>
          {isError && (
            <Text size="sm" c="red" ta="center" py="md">
              Search failed: {error?.message || 'please try again.'}
            </Text>
          )}
          {results && results.length > 0 ? (
            results.map((item) => {
              const task = taskById.get(item.id);
              return (
                <UnstyledButton
                  key={item.id}
                  component={Link}
                  href={`/tasks/${item.id}`}
                  onClick={onClose}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid var(--mantine-color-default-border)',
                    backgroundColor: 'var(--mantine-color-body)',
                  }}
                >
                  <Group justify="space-between" mb={4}>
                    <Group gap="xs">
                      <Badge size="xs" variant="filled" color="dark">
                        #{item.shortId}
                      </Badge>
                      <Text fw={600} size="sm">
                        {item.title}
                      </Text>
                      {item.matchedRef && (
                        <Tooltip label="This task carries that link" withArrow openDelay={300}>
                          <Badge
                            size="xs"
                            variant="light"
                            color="indigo"
                            leftSection={<IconLink size={10} />}
                            data-testid="search-matched-ref"
                          >
                            Linked
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                    <Group gap="xs" wrap="nowrap">
                      {task && <TaskAssigneeAvatar task={task} meId={userId} size={18} />}
                      {(task?.category || item.projectName) && (
                        <Badge
                          size="xs"
                          variant="outline"
                          color={task?.isShared ? 'grape' : 'blue'}
                          leftSection={task?.isShared ? <IconUsers size={10} /> : undefined}
                          style={{ textTransform: 'none' }}
                          title={
                            task?.isShared || (!task && item.orgName)
                              ? `${task?.category || item.projectName}, in ${workspaceLabel({
                                  name: task?.orgName || item.orgName,
                                })}`
                              : task?.category || item.projectName || undefined
                          }
                        >
                          {task?.category || item.projectName}
                        </Badge>
                      )}
                      {item.customer && (
                        <Badge size="xs" color="teal">
                          {item.customer}
                        </Badge>
                      )}
                      <Badge size="xs" variant="light">
                        {item.status}
                      </Badge>
                    </Group>
                  </Group>
                  {item.reason && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      Why: {item.reason}
                    </Text>
                  )}
                  {item.snippet && (
                    <Box
                      mt={4}
                      p={4}
                      style={{
                        fontSize: '11px',
                        backgroundColor: 'rgba(0,0,0,0.03)',
                        borderRadius: '4px',
                      }}
                      dangerouslySetInnerHTML={{ __html: item.snippet }}
                    />
                  )}
                </UnstyledButton>
              );
            })
          ) : query.trim().length >= 2 && !isLoading && !isError ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No matching tasks found.
            </Text>
          ) : null}
        </Stack>
      </Stack>
    </Modal>
  );
}
