import React, { useEffect, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Accordion, Button, Paper, Select, Stack, Text, Title } from '@mantine/core';
import {
  getVisibleBoardTasks,
  groupBoardTasks,
  type BoardGroupBy,
  type BoardTaskGroup,
} from '../../app/lib/boardState';
import type {
  Project,
  ProjectStatus,
  ProjectSummary,
  ProjectUpdateInput,
} from '../../app/types/project.types';
import { ProjectCard } from '../ProjectCard/ProjectCard';

interface ProjectSectionProps {
  id: string;
  title: string;
  projects: Array<Project | ProjectSummary>;
  defaultOpen?: boolean;
  alwaysExpanded?: boolean;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => void;
  onStatusChange: (projectId: string, newStatus: ProjectStatus) => void;
  /** The remaining props enable the controlled, bounded board presentation. */
  taskCount?: number;
  sectionExpanded?: boolean;
  onToggleSection?: () => void;
  groupBy?: BoardGroupBy;
  groups?: Array<BoardTaskGroup<Project | ProjectSummary>>;
  visibleLimit?: number;
  onShowMore?: () => void;
  expandedTaskIds?: string[];
  onExpandedTaskIdsChange?: (ids: string[]) => void;
  onMountedIdsChange?: (ids: string[]) => void;
}

export function ProjectSection(props: ProjectSectionProps) {
  if (props.sectionExpanded === undefined) {
    return <LegacyProjectSection {...props} />;
  }
  return <BoundedProjectSection {...props} sectionExpanded={props.sectionExpanded} />;
}

function LegacyProjectSection({
  id,
  title,
  projects,
  defaultOpen = false,
  alwaysExpanded = false,
  onUpdateProject,
  onStatusChange,
}: ProjectSectionProps) {
  if (projects.length === 0) {
    return null;
  }

  const projectIds = projects.map((project) => project.id);
  const accordionProps = alwaysExpanded
    ? { value: projectIds, onChange: () => {} }
    : { defaultValue: defaultOpen ? projectIds : [] };

  return (
    <Stack component="section" mb="xl" data-testid={`section-${id}`}>
      <Title order={2} fz="h1" c="blue">
        {title}
      </Title>
      <SortableContext id={id} items={projectIds} strategy={verticalListSortingStrategy}>
        <Accordion<true> multiple {...accordionProps} variant="separated">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onUpdate={onUpdateProject}
              onStatusChange={onStatusChange}
              disableCollapse={alwaysExpanded}
            />
          ))}
        </Accordion>
      </SortableContext>
    </Stack>
  );
}

function BoundedProjectSection({
  id,
  title,
  projects,
  taskCount = projects.length,
  sectionExpanded,
  onToggleSection = () => {},
  groupBy = 'none',
  groups: suppliedGroups,
  visibleLimit = 50,
  onShowMore = () => {},
  expandedTaskIds = [],
  onExpandedTaskIdsChange = () => {},
  onMountedIdsChange,
  onUpdateProject,
  onStatusChange,
}: ProjectSectionProps & { sectionExpanded: boolean }) {
  const groups = suppliedGroups || groupBoardTasks(projects, groupBy);
  const groupIdByTaskId = new Map(
    groups.flatMap((group) => group.items.map((project) => [project.id, group.id] as const))
  );
  const signature = groups.map((group) => group.id).join('|');
  const [openLargeGroupId, setOpenLargeGroupId] = useState<string | null>(
    () => groups[0]?.id || null
  );
  const [collapsedSmallGroups, setCollapsedSmallGroups] = useState<Set<string>>(() => new Set());
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { type: 'status', status: id },
  });
  const isSmallSection = taskCount <= 15;

  useEffect(() => {
    setOpenLargeGroupId(groups[0]?.id || null);
    setCollapsedSmallGroups(new Set());
  }, [id, groupBy, signature, taskCount]);

  const visibleTasks = isSmallSection
    ? getVisibleBoardTasks(groups, taskCount, null, visibleLimit)
    : openLargeGroupId
      ? getVisibleBoardTasks(groups, taskCount, openLargeGroupId, visibleLimit)
      : [];
  const visibleIds = new Set(visibleTasks.map((project) => project.id));

  const toggleGroup = (groupId: string) => {
    if (isSmallSection) {
      setCollapsedSmallGroups((current) => {
        const next = new Set(current);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
      return;
    }
    setOpenLargeGroupId((current) => (current === groupId ? null : groupId));
  };

  const grouped = groupBy !== 'none';
  const isGroupOpen = (groupId: string) =>
    isSmallSection ? !collapsedSmallGroups.has(groupId) : openLargeGroupId === groupId;
  const mountedTasks = sectionExpanded
    ? groups.flatMap((group) => {
        if (grouped && !isGroupOpen(group.id)) {
          return [];
        }
        return group.items.filter((project) => visibleIds.has(project.id));
      })
    : [];
  const mountedTaskIds = mountedTasks.map((project) => project.id);
  const mountedKey = JSON.stringify(mountedTaskIds);

  useEffect(() => {
    onMountedIdsChange?.(JSON.parse(mountedKey) as string[]);
  }, [mountedKey, onMountedIdsChange]);

  return (
    <section
      ref={setNodeRef}
      data-testid={`section-${id}`}
      data-over={isOver || undefined}
      aria-label={`${title} tasks`}
    >
      <Stack mb="xl" gap="sm">
        <Button
          variant="subtle"
          justify="flex-start"
          px="xs"
          aria-expanded={sectionExpanded}
          aria-label={`${sectionExpanded ? 'Collapse' : 'Expand'} ${title} section`}
          onClick={onToggleSection}
          data-testid={`section-toggle-${id}`}
        >
          <Title order={2} fz="h1" c="blue">
            {sectionExpanded ? '▼' : '▶'} {title} ({taskCount})
          </Title>
        </Button>

        {sectionExpanded && taskCount === 0 && (
          <Paper withBorder p="md" radius="md" role="region" aria-label={`Empty ${title} section`}>
            <Text size="sm" c="dimmed">
              No tasks here. Drop one into this section.
            </Text>
          </Paper>
        )}

        {sectionExpanded && taskCount > 0 && (
          <>
            {grouped &&
              isSmallSection &&
              groups.map((group) => {
                const open = isGroupOpen(group.id);
                return (
                  <Button
                    key={group.id}
                    variant="light"
                    size="sm"
                    justify="space-between"
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${group.label}`}
                    onClick={() => toggleGroup(group.id)}
                    data-testid={`board-group-${id}-${group.id}`}
                  >
                    {group.label} ({group.items.length})
                  </Button>
                );
              })}
            {grouped && !isSmallSection && (
              <Select
                label="Open one group"
                placeholder="Choose a group"
                data={groups.map((group) => ({
                  value: group.id,
                  label: `${group.label} (${group.items.length})`,
                }))}
                value={openLargeGroupId}
                onChange={setOpenLargeGroupId}
                clearable
                searchable
                data-testid={`board-group-select-${id}`}
              />
            )}

            <SortableContext id={id} items={mountedTaskIds} strategy={verticalListSortingStrategy}>
              <Accordion
                multiple
                value={expandedTaskIds}
                onChange={onExpandedTaskIdsChange}
                variant="separated"
              >
                {mountedTasks.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    groupId={groupIdByTaskId.get(project.id)}
                    expanded={expandedTaskIds.includes(project.id)}
                    onUpdate={onUpdateProject}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </Accordion>
            </SortableContext>

            {grouped &&
              !isSmallSection &&
              openLargeGroupId &&
              (groups.find((group) => group.id === openLargeGroupId)?.items.length || 0) >
                visibleLimit && (
                <Button variant="subtle" size="xs" onClick={onShowMore}>
                  Show 50 more
                </Button>
              )}
            {!grouped && !isSmallSection && groups[0]?.items.length > visibleLimit && (
              <Button variant="subtle" size="xs" onClick={onShowMore}>
                Show 50 more
              </Button>
            )}
          </>
        )}
      </Stack>
    </section>
  );
}
