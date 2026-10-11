'use client';

import React, { Suspense, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { IconEye, IconFlag, IconPlus, IconTarget, IconUsers } from '@tabler/icons-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Modal,
  Pill,
  Progress,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { PRIVATE_GOAL_HINT, ProjectPicker } from '../../components/ProjectPicker/ProjectPicker';
import {
  BotMarker,
  canEditItem,
  personLabel,
  TeamAvatar,
  WorkspaceBadge,
} from '../../components/Team';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { useCreateEpic, useEpics } from '../hooks/useEpicQueries';
import { useGoals } from '../hooks/useGoalQueries';
import { useWorkspaceLookup } from '../hooks/useWorkspaces';
import type { Epic, EpicCreateInput } from '../types/epic.types';

interface CategoryPillGroup {
  key: string;
  label: string;
  isShared: boolean;
  categories: string[];
}

function EpicsSkeleton() {
  return (
    <SimpleGrid
      cols={{ base: 1, sm: 2, md: 3 }}
      spacing="md"
      role="status"
      aria-label="Loading epics"
    >
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} height={170} radius="md" />
      ))}
    </SimpleGrid>
  );
}

function EpicsOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedCategory = searchParams.get('category') || 'All';
  const { userId } = useCurrentUser();
  const lookupWorkspace = useWorkspaceLookup();

  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure();
  const createEpicMutation = useCreateEpic();
  const { data: goals } = useGoals();
  const { data: epics, isLoading: isEpicsLoading, isError: isEpicsError, error } = useEpics();

  const form = useForm<EpicCreateInput>({
    initialValues: {
      title: '',
      description: '',
      projectId: null,
      goalId: null,
      status: 'active',
    },
    validate: {
      title: (val) => (val && val.trim().length > 0 ? null : 'Title is required'),
    },
  });

  const handleCategorySelect = (category: string) => {
    if (category === 'All') {
      router.push('/epics');
    } else {
      router.push(`/epics?category=${encodeURIComponent(category)}`);
    }
  };

  const handleCreateSubmit = (values: typeof form.values) => {
    createEpicMutation.mutate({
      ...values,
      projectId: values.projectId || undefined,
      goalId: values.goalId || undefined,
    });
    form.reset();
    closeCreateModal();
  };

  const goalSelectData = (goals || []).map((g) => ({
    value: g.id,
    label: `[${g.type.toUpperCase()}] ${g.title}`,
  }));

  // Category (project) pills from the epics I can see, grouped by workspace
  const categoryGroups = useMemo<CategoryPillGroup[]>(() => {
    const groups = new Map<string, CategoryPillGroup>();
    (epics || []).forEach((e) => {
      if (!e.category) {
        return;
      }
      const key = e.orgId || 'personal';
      const group = groups.get(key) || {
        key,
        label: lookupWorkspace(e.orgId, e).label,
        isShared: !!e.isShared,
        categories: [],
      };
      if (!group.categories.includes(e.category)) {
        group.categories.push(e.category);
      }
      groups.set(key, group);
    });
    return Array.from(groups.values())
      .map((g) => ({ ...g, categories: g.categories.sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => Number(a.isShared) - Number(b.isShared) || a.label.localeCompare(b.label));
  }, [epics, lookupWorkspace]);

  const filteredEpics = useMemo(() => {
    if (!epics) {
      return [];
    }
    if (selectedCategory === 'All') {
      return epics;
    }
    return epics.filter((e) => (e.category || '').toLowerCase() === selectedCategory.toLowerCase());
  }, [epics, selectedCategory]);

  const showGroupLabels = categoryGroups.length > 1 || categoryGroups.some((g) => g.isShared);

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="center">
          <div>
            <Title order={1}>Epics</Title>
            <Text c="dimmed" size="sm">
              Bigger pieces of work made of related tasks, across all your workspaces.
            </Text>
          </div>
          <Button leftSection={<IconPlus size={16} />} color="violet" onClick={openCreateModal}>
            New Epic
          </Button>
        </Group>

        {/* Category filter pills, grouped by workspace like the board */}
        <Group gap="xs" align="center">
          <EpicCategoryPill
            label="All"
            active={selectedCategory === 'All'}
            onClick={() => handleCategorySelect('All')}
          />
          {categoryGroups.map((group) => (
            <Group key={group.key} gap={6} align="center" wrap="wrap">
              {showGroupLabels && (
                <Group gap={4} ml="xs" wrap="nowrap">
                  {group.isShared && <IconUsers size={14} color="var(--mantine-color-grape-6)" />}
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    {group.label}
                  </Text>
                </Group>
              )}
              {group.categories.map((cat) => (
                <EpicCategoryPill
                  key={`${group.key}-${cat}`}
                  label={cat}
                  active={selectedCategory === cat}
                  shared={group.isShared}
                  onClick={() => handleCategorySelect(cat)}
                />
              ))}
            </Group>
          ))}
        </Group>

        {isEpicsLoading ? (
          <EpicsSkeleton />
        ) : isEpicsError ? (
          <Alert title="Couldn't load epics" color="red">
            {error?.message || 'Could not load epics.'}
          </Alert>
        ) : filteredEpics.length === 0 ? (
          <Card withBorder p="xl" radius="md">
            <Stack align="center" gap="xs">
              <Text c="dimmed">
                {selectedCategory === 'All'
                  ? 'No epics yet. Epics group related tasks into one bigger goal.'
                  : `No epics in "${selectedCategory}".`}
              </Text>
              {selectedCategory === 'All' && (
                <Button
                  variant="light"
                  color="violet"
                  leftSection={<IconPlus size={14} />}
                  onClick={openCreateModal}
                >
                  Create Your First Epic
                </Button>
              )}
            </Stack>
          </Card>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
            {filteredEpics.map((epic) => (
              <EpicCard key={epic.id} epic={epic} meId={userId} />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      {/* Create Epic Modal */}
      <Modal opened={createModalOpened} onClose={closeCreateModal} title="Create New Epic" centered>
        <form onSubmit={form.onSubmit(handleCreateSubmit)}>
          <Stack gap="sm">
            <TextInput
              label="Epic Title"
              placeholder="e.g. Launch Acme Solar Array"
              required
              data-autofocus
              {...form.getInputProps('title')}
            />

            <Textarea
              label="Description"
              placeholder="What does this epic deliver?"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />

            <ProjectPicker
              label="Project"
              description="Everyone in the project's workspace will see this epic"
              value={form.values.projectId}
              onChange={(id) => form.setFieldValue('projectId', id)}
              clearable
            />

            <Select
              label="Linked Life Goal"
              description={PRIVATE_GOAL_HINT}
              placeholder="Link to an Aim, Focus, or Value"
              data={goalSelectData}
              clearable
              leftSection={<IconTarget size={16} />}
              comboboxProps={{ withinPortal: true }}
              {...form.getInputProps('goalId')}
            />

            <Group justify="flex-end" mt="md">
              <Button variant="default" onClick={closeCreateModal}>
                Cancel
              </Button>
              <Button type="submit" color="violet">
                Create Epic
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Container>
  );
}

function EpicCard({ epic, meId }: { epic: Epic; meId: string | null }) {
  const total = epic.totalTasks ?? 0;
  const done = epic.doneTasks ?? 0;
  const pct = epic.progressPercentage ?? (total > 0 ? Math.round((done / total) * 100) : 0);
  const canEdit = canEditItem(epic);

  return (
    <Card
      component={Link}
      href={`/epics/${epic.id}`}
      shadow="sm"
      padding="lg"
      radius="md"
      withBorder
      style={{ textDecoration: 'none', color: 'inherit' }}
      data-testid={`epic-card-${epic.id}`}
    >
      <Stack justify="space-between" h="100%" gap="md">
        <div>
          <Group justify="space-between" align="flex-start" mb="xs" wrap="nowrap">
            <ThemeIcon size={36} radius="md" color="violet" variant="light">
              <IconFlag size={20} />
            </ThemeIcon>
            <Group gap={6} justify="flex-end">
              {epic.isShared && <WorkspaceBadge name={epic.orgName} isShared isPersonal={false} />}
              {epic.category && (
                <Badge color="blue" variant="light" size="xs" style={{ textTransform: 'none' }}>
                  {epic.category}
                </Badge>
              )}
              <Badge color={epic.status === 'completed' ? 'green' : 'violet'} variant="dot">
                {epic.status.replace('_', ' ')}
              </Badge>
            </Group>
          </Group>
          <Title order={3} size="h4">
            {epic.title}
          </Title>
          {epic.description && (
            <Text size="xs" c="dimmed" lineClamp={2} mt={4}>
              {epic.description}
            </Text>
          )}
        </div>

        <div>
          <Group justify="space-between" mb={4}>
            <Text size="xs" c="dimmed">
              {done}/{total} tasks
            </Text>
            <Text size="xs" fw={600}>
              {pct}%
            </Text>
          </Group>
          <Progress value={pct} color="violet" radius="xl" size="sm" />
          {(epic.isShared || !canEdit) && (
            <Group justify="space-between" mt="sm" gap="xs" wrap="nowrap">
              {epic.createdByName ? (
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  <TeamAvatar name={epic.createdByName} seed={epic.createdById} size={18} />
                  <Text size="xs" c="dimmed" truncate>
                    Created by{' '}
                    {personLabel(epic.createdByName, epic.createdById, meId, { capitalise: false })}{' '}
                    <BotMarker kind={epic.createdByKind} />
                  </Text>
                </Group>
              ) : (
                <span />
              )}
              {!canEdit && (
                <Tooltip label="You can see this epic but not change it" withArrow>
                  <Badge size="xs" color="gray" variant="light" leftSection={<IconEye size={10} />}>
                    View only
                  </Badge>
                </Tooltip>
              )}
            </Group>
          )}
        </div>
      </Stack>
    </Card>
  );
}

function EpicCategoryPill({
  label,
  active,
  shared = false,
  onClick,
}: {
  label: string;
  active: boolean;
  shared?: boolean;
  onClick: () => void;
}) {
  return (
    <Pill
      size="md"
      role="button"
      tabIndex={0}
      aria-pressed={active}
      style={{
        cursor: 'pointer',
        backgroundColor: active
          ? `var(--mantine-color-${shared ? 'grape' : 'blue'}-filled)`
          : 'var(--mantine-color-default)',
        color: active ? 'var(--mantine-color-white)' : 'var(--mantine-color-text)',
        fontWeight: active ? 600 : 400,
        border: '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
      }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {label}
    </Pill>
  );
}

export default function EpicsOverviewPage() {
  return (
    <Suspense
      fallback={
        <Container size="lg" py="xl">
          <EpicsSkeleton />
        </Container>
      }
    >
      <EpicsOverviewContent />
    </Suspense>
  );
}
