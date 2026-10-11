import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Group, Paper, Select, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useCurrentUser } from '../../app/hooks/useCurrentUser';
import { getVisibleBoardTasks, groupBoardTasks, type BoardGroupBy } from '../../app/lib/boardState';
import type { Project, ProjectSummary } from '../../app/types/project.types';
import { personLabel, TeamAvatar } from '../Team';
import classes from './DoneProjectList.module.css';

interface DoneProjectListProps {
  title: string;
  projects: Array<Project | ProjectSummary>;
  totalCount?: number;
  expanded?: boolean;
  onToggle?: () => void;
  groupBy?: BoardGroupBy;
  epicTitles?: Record<string, string>;
  visibleLimit?: number;
  onShowMore?: () => void;
  historyOpen?: boolean;
  historyItems?: ProjectSummary[];
  historyLoading?: boolean;
  historyLoadingMore?: boolean;
  historyError?: Error | null;
  historyHasNext?: boolean;
  onShowOlder?: () => void;
  onLoadMoreOlder?: () => void;
  onRetryOlder?: () => void;
}

export function DoneProjectList({
  title,
  projects,
  totalCount = projects.length,
  expanded,
  onToggle,
  groupBy = 'none',
  epicTitles = {},
  visibleLimit = 50,
  onShowMore,
  historyOpen = false,
  historyItems = [],
  historyLoading = false,
  historyLoadingMore = false,
  historyError = null,
  historyHasNext = false,
  onShowOlder,
  onLoadMoreOlder,
  onRetryOlder,
}: DoneProjectListProps) {
  const { userId } = useCurrentUser();
  const recentIds = new Set(projects.map((project) => project.id));
  const allLoaded = [...projects, ...historyItems.filter((project) => !recentIds.has(project.id))];
  const groups = groupBoardTasks(allLoaded, groupBy, epicTitles);
  const groupSignature = groups.map((group) => group.id).join('|');
  const [openLargeGroupId, setOpenLargeGroupId] = useState<string | null>(
    () => groups[0]?.id || null
  );
  const [collapsedSmallGroups, setCollapsedSmallGroups] = useState<Set<string>>(() => new Set());
  const isSmallSection = totalCount <= 15;
  const isExpanded = expanded ?? true;
  const grouped = groupBy !== 'none';

  useEffect(() => {
    setOpenLargeGroupId((current) =>
      current && groups.some((group) => group.id === current) ? current : groups[0]?.id || null
    );
    setCollapsedSmallGroups((current) => {
      const available = new Set(groups.map((group) => group.id));
      return new Set(Array.from(current).filter((groupId) => available.has(groupId)));
    });
  }, [groupSignature, groupBy, totalCount]);

  const allVisible = isSmallSection
    ? getVisibleBoardTasks(groups, totalCount, null, visibleLimit)
    : openLargeGroupId
      ? getVisibleBoardTasks(groups, totalCount, openLargeGroupId, visibleLimit)
      : [];
  const visibleIds = new Set(allVisible.map((project) => project.id));
  const isGroupOpen = (groupId: string) =>
    isSmallSection ? !collapsedSmallGroups.has(groupId) : openLargeGroupId === groupId;
  const visibleTasks = groups.flatMap((group) => {
    if (grouped && !isGroupOpen(group.id)) {
      return [];
    }
    return group.items.filter((project) => visibleIds.has(project.id));
  });
  const recentVisible = visibleTasks.filter((project) => recentIds.has(project.id));
  const olderVisible = visibleTasks.filter((project) => !recentIds.has(project.id));
  const selectedGroupCount =
    groups.find((group) => group.id === openLargeGroupId)?.items.length || 0;
  const canShowMore =
    !isSmallSection &&
    !!openLargeGroupId &&
    selectedGroupCount > visibleLimit &&
    visibleTasks.length < selectedGroupCount;
  const countLabel = (group: (typeof groups)[number]) => {
    const recentCount = group.items.filter((project) => recentIds.has(project.id)).length;
    const olderCount = group.items.length - recentCount;
    return olderCount
      ? `${recentCount} recent, ${olderCount} older loaded`
      : `${recentCount} recent`;
  };

  const renderItem = (project: Project | ProjectSummary) => (
    <div key={project.id} className={classes.listItem} data-testid="done-project-item">
      <Group gap={6} wrap="nowrap">
        {project.isShared && project.assigneeId && (
          <TeamAvatar
            name={project.assigneeName}
            seed={project.assigneeId}
            size={18}
            tooltip={`Assigned to ${personLabel(project.assigneeName, project.assigneeId, userId, { capitalise: false })}`}
          />
        )}
        <Text
          component={Link}
          href={`/tasks/${project.id}`}
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          {project.project}
        </Text>
      </Group>
    </div>
  );

  return (
    <Stack component="section" mb="xl" data-testid={`section-${title.toLowerCase()}`}>
      <Button
        variant="subtle"
        justify="flex-start"
        px="xs"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${title} section`}
        onClick={onToggle}
        data-testid="done-section-toggle"
      >
        <Title order={2} fz="h1" c="blue">
          {isExpanded ? '▼' : '▶'} {title} (recent {projects.length}, all time {totalCount})
        </Title>
      </Button>

      {isExpanded && (
        <Paper withBorder p="md" className={classes.doneList}>
          {grouped &&
            isSmallSection &&
            groups.map((group) => {
              const open = !collapsedSmallGroups.has(group.id);
              return (
                <Button
                  key={group.id}
                  variant="light"
                  size="xs"
                  mb="xs"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${group.label}`}
                  onClick={() =>
                    setCollapsedSmallGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) {
                        next.delete(group.id);
                      } else {
                        next.add(group.id);
                      }
                      return next;
                    })
                  }
                >
                  {group.label} ({countLabel(group)})
                </Button>
              );
            })}
          {grouped && !isSmallSection && groups.length > 0 && (
            <Select
              label="Open one Done group"
              data={groups.map((group) => ({
                value: group.id,
                label: `${group.label} (${countLabel(group)})`,
              }))}
              value={openLargeGroupId}
              onChange={setOpenLargeGroupId}
              clearable
              searchable
              mb="sm"
            />
          )}
          {recentVisible.length > 0 && (
            <>
              <Text size="xs" c="dimmed" mb="xs">
                Recent Done
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }}>
                {recentVisible.map(renderItem)}
              </SimpleGrid>
            </>
          )}
          {olderVisible.length > 0 && (
            <>
              <Text size="xs" c="dimmed" mt="sm" mb="xs">
                Older
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }}>
                {olderVisible.map(renderItem)}
              </SimpleGrid>
            </>
          )}

          {canShowMore && (
            <Button variant="subtle" size="xs" mt="sm" onClick={onShowMore}>
              Show 50 more
            </Button>
          )}
          {onShowOlder && totalCount > projects.length && (
            <Group mt="sm" justify="space-between">
              {!historyOpen ? (
                <Button variant="light" size="xs" onClick={onShowOlder}>
                  Show older tasks ({Math.max(0, totalCount - projects.length)})
                </Button>
              ) : historyLoading ? (
                <Text size="sm" c="dimmed" role="status">
                  Loading older tasks…
                </Text>
              ) : historyError ? (
                <Group>
                  <Text size="sm" c="red">
                    Could not load older tasks: {historyError.message}
                  </Text>
                  <Button variant="light" size="xs" onClick={onRetryOlder}>
                    Retry
                  </Button>
                </Group>
              ) : (
                <>
                  <Text size="xs" c="dimmed">
                    Older tasks ({historyItems.length} loaded)
                  </Text>
                  {historyHasNext ? (
                    <Button
                      variant="light"
                      size="xs"
                      loading={historyLoadingMore}
                      onClick={onLoadMoreOlder}
                    >
                      Load older 50
                    </Button>
                  ) : (
                    <Text size="xs" c="dimmed">
                      {historyItems.length === 0
                        ? 'No older tasks found'
                        : 'All older tasks loaded'}
                    </Text>
                  )}
                </>
              )}
            </Group>
          )}
        </Paper>
      )}
    </Stack>
  );
}
