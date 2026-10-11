'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { IconEye, IconFolder, IconUser, IconUsers } from '@tabler/icons-react';
import {
  Alert,
  Badge,
  Card,
  Container,
  Group,
  Progress,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { joinNames } from '../../components/Team';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { useEpics } from '../hooks/useEpicQueries';
import { useProjects } from '../hooks/useProjectQueries';
import { useWorkspaceMembersMap, useWorkspaceProjects } from '../hooks/useWorkspaces';

interface ProjectCardData {
  key: string;
  name: string;
  projectKey?: string | null;
  totalTasks: number;
  doneTasks: number;
  epicCount: number;
  progress: number;
}

interface WorkspaceSection {
  id: string;
  label: string;
  isShared: boolean;
  isViewer: boolean;
  projects: ProjectCardData[];
}

function ProjectsSkeleton() {
  return (
    <Stack gap="lg" role="status" aria-label="Loading projects">
      <Skeleton height={20} width={160} radius="sm" />
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} height={150} radius="md" />
        ))}
      </SimpleGrid>
    </Stack>
  );
}

export default function ProjectsOverviewPage() {
  const { userId } = useCurrentUser();
  const { workspaces, isLoading: isWorkspacesLoading } = useWorkspaceProjects();
  const { data: tasks, isLoading: isTasksLoading, isError: isTasksError } = useProjects();
  const { data: epics, isLoading: isEpicsLoading } = useEpics();

  const sharedOrgIds = workspaces.filter((ws) => ws.isShared).map((ws) => ws.org.id);
  const membersByOrg = useWorkspaceMembersMap(sharedOrgIds);

  // One section per workspace (personal first), one card per project. Counts come from the
  // tasks I can see, so they always match the board.
  const sections = useMemo<WorkspaceSection[]>(() => {
    const allTasks = (tasks || []).filter((t) => !t.isDeleted);
    const seen = new Set<string>();

    const built = workspaces.map((ws): WorkspaceSection => {
      const cards = ws.projects.map((p): ProjectCardData => {
        seen.add(p.id);
        const projectTasks = allTasks.filter((t) =>
          t.projectId ? t.projectId === p.id : (t.category || '') === p.name
        );
        const done = projectTasks.filter((t) => t.status === 'done').length;
        const total = projectTasks.length;
        return {
          key: p.id,
          name: p.name,
          projectKey: p.key,
          totalTasks: total,
          doneTasks: done,
          epicCount:
            p.epicCount ?? (epics || []).filter((e) => (e.projectId || '') === p.id).length,
          progress: total > 0 ? Math.round((done / total) * 100) : 0,
        };
      });
      return {
        id: ws.org.id,
        label: ws.label,
        isShared: ws.isShared,
        isViewer: !ws.canEdit,
        // Busy projects first, empty ones last
        projects: cards.sort(
          (a, b) =>
            Number(b.totalTasks > 0) - Number(a.totalTasks > 0) || a.name.localeCompare(b.name)
        ),
      };
    });

    // Anything visible whose project isn't listed (e.g. archived) still gets a card
    const leftovers = new Map<string, ProjectCardData>();
    allTasks
      .filter((t) => t.projectId && !seen.has(t.projectId) && t.category)
      .forEach((t) => {
        const card = leftovers.get(t.projectId!) || {
          key: t.projectId!,
          name: t.category!,
          projectKey: t.projectKey,
          totalTasks: 0,
          doneTasks: 0,
          epicCount: 0,
          progress: 0,
        };
        card.totalTasks += 1;
        card.doneTasks += t.status === 'done' ? 1 : 0;
        card.progress = Math.round((card.doneTasks / card.totalTasks) * 100);
        leftovers.set(t.projectId!, card);
      });
    if (leftovers.size > 0) {
      built.push({
        id: 'other',
        label: 'Other',
        isShared: false,
        isViewer: false,
        projects: Array.from(leftovers.values()),
      });
    }

    return built.filter((s) => s.projects.length > 0);
  }, [workspaces, tasks, epics]);

  const isLoading = isWorkspacesLoading || isTasksLoading || isEpicsLoading;

  return (
    <Container size="lg" py="xl">
      <Stack gap="xl">
        <div>
          <Title order={1}>Projects</Title>
          <Text c="dimmed" size="sm">
            Every project you can see, grouped by workspace. Shared workspaces show who else is in
            them.
          </Text>
        </div>

        {isLoading ? (
          <ProjectsSkeleton />
        ) : isTasksError ? (
          <Alert title="Error" color="red">
            Could not load projects.
          </Alert>
        ) : sections.length === 0 ? (
          <Card withBorder p="xl" radius="md">
            <Text c="dimmed" ta="center">
              No projects yet. Add a task with Quick Add and pick a project to get started.
            </Text>
          </Card>
        ) : (
          sections.map((section) => {
            const others = (membersByOrg[section.id] || [])
              .filter((member) => member.userId !== userId)
              .map((member) => {
                const name = member.userName || member.userEmail || 'Someone';
                return member.kind === 'bot' || member.userId.startsWith('bot|')
                  ? `${name} [bot]`
                  : name;
              });
            return (
              <Stack key={section.id} gap="sm" component="section" aria-label={section.label}>
                <Group gap="xs" align="center">
                  <ThemeIcon
                    size={26}
                    radius="xl"
                    variant="light"
                    color={section.isShared ? 'grape' : 'gray'}
                  >
                    {section.isShared ? <IconUsers size={15} /> : <IconUser size={15} />}
                  </ThemeIcon>
                  <Title order={2} size="h4">
                    {section.label}
                  </Title>
                  {section.isShared && (
                    <Text size="sm" c="dimmed">
                      {others.length > 0 ? `Shared with ${joinNames(others, 3)}` : 'Shared'}
                    </Text>
                  )}
                  {section.isViewer && (
                    <Tooltip label="You can see these projects but not change them" withArrow>
                      <Badge
                        size="sm"
                        variant="light"
                        color="gray"
                        leftSection={<IconEye size={10} />}
                      >
                        View only
                      </Badge>
                    </Tooltip>
                  )}
                </Group>

                <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
                  {section.projects.map((project) => (
                    <Card
                      key={project.key}
                      component={Link}
                      href={`/projects/${encodeURIComponent(project.name)}`}
                      shadow="sm"
                      padding="lg"
                      radius="md"
                      withBorder
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <Stack justify="space-between" h="100%" gap="md">
                        <div>
                          <Group justify="space-between" align="flex-start" mb="xs">
                            <ThemeIcon
                              size={40}
                              radius="md"
                              color={section.isShared ? 'grape' : 'blue'}
                              variant="light"
                            >
                              <IconFolder size={22} />
                            </ThemeIcon>
                            {project.epicCount > 0 && (
                              <Badge variant="light" color="violet">
                                {project.epicCount} {project.epicCount === 1 ? 'Epic' : 'Epics'}
                              </Badge>
                            )}
                          </Group>
                          <Title order={3} size="h4">
                            {project.name}
                          </Title>
                          <Text size="xs" c="dimmed" mt={4}>
                            {project.totalTasks === 0
                              ? 'No tasks yet'
                              : `${project.totalTasks} tasks · ${project.doneTasks} done`}
                          </Text>
                        </div>

                        <div>
                          <Group justify="space-between" mb={4}>
                            <Text size="xs" c="dimmed">
                              Progress
                            </Text>
                            <Text size="xs" fw={600}>
                              {project.progress}%
                            </Text>
                          </Group>
                          <Progress
                            value={project.progress}
                            color={section.isShared ? 'grape' : 'blue'}
                            radius="xl"
                            size="sm"
                          />
                        </div>
                      </Stack>
                    </Card>
                  ))}
                </SimpleGrid>
              </Stack>
            );
          })
        )}
      </Stack>
    </Container>
  );
}
