'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { IconSearch, IconUsers } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import {
  ActionIcon,
  Alert,
  Button,
  Container,
  Group,
  Loader,
  Paper,
  Pill,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { DoneProjectList } from '../../components/DoneProjectList/DoneProjectList';
import { ProjectCardPreview } from '../../components/ProjectCard/ProjectCard';
import { ProjectSection } from '../../components/ProjectSection/ProjectSection';
import { QuickSearchModal } from '../../components/SearchModal/QuickSearchModal';
import { canEditItem, joinNames, workspaceLabel } from '../../components/Team';
import {
  filterByAssigneeScope,
  useAssigneeScope,
  type AssigneeScope,
} from '../hooks/useAssigneeScope';
import { useBoardCounts, useBoardDoneHistory, useBoardSummaries } from '../hooks/useBoardQueries';
import { useCurrentUser } from '../hooks/useCurrentUser';
import { useEpics } from '../hooks/useEpicQueries';
import { useOrganisations } from '../hooks/useOrganisationQueries';
import { useBatchUpdateProjects, useUpdateProject } from '../hooks/useProjectMutations';
import { useWorkspaceLookup, useWorkspaceMembersMap } from '../hooks/useWorkspaces';
import {
  canDropBoardTask,
  groupBoardTasks,
  resolveBoardGrouping,
  shouldExpandBoardSection,
  updateBoardSearchParams,
  type BoardGroupBy,
  type BoardTaskGroup,
} from '../lib/boardState';
import type {
  ProjectSize,
  ProjectStatus,
  ProjectSummary,
  ProjectUpdateInput,
} from '../types/project.types';

const STATUSES: ProjectStatus[] = ['do', 'delay', 'awaiting', 'delegate', 'done'];
const INITIAL_WINDOW = 50;

const SCOPE_EMPTY_COPY: Record<AssigneeScope, string> = {
  mine: "Nothing assigned to you yet. Switch to Everyone to see the whole team's work.",
  unassigned: 'Every task here has someone on it.',
  everyone: 'No tasks here yet. Press C or use Quick Add to create one.',
};

function normalizeCategory(category: string | null | undefined): string {
  return category?.trim().toLowerCase() ?? '';
}

function isCategorySelected(selectedCategory: string, category: string): boolean {
  return (
    selectedCategory !== 'All' &&
    normalizeCategory(selectedCategory) === normalizeCategory(category)
  );
}

type ExpandedSections = Partial<Record<ProjectStatus, boolean>>;
type MountedIdsByStatus = Record<ProjectStatus, string[]>;

function sizeToNumber(size: ProjectSize): number {
  return size.length;
}

function getDoneCutoff(): string {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  return cutoff.toISOString().slice(0, 10);
}

function emptyCounts() {
  return { do: 0, delay: 0, awaiting: 0, delegate: 0, done: 0 };
}

function BoardSkeleton() {
  return (
    <Stack gap="sm" role="status" aria-label="Loading projects">
      <Skeleton height={36} width={120} radius="sm" />
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} height={64} radius="md" />
      ))}
    </Stack>
  );
}

function BoardContent() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountId = session?.user?.id || session?.user?.email || null;
  const selectedCategory = searchParams.get('category') || 'All';
  const [doneCutoff] = useState(getDoneCutoff);
  const [selectedOrgId, setSelectedOrgId] = useState('all');
  const [selectedCustomer, setSelectedCustomer] = useState(searchParams.get('customer') || 'all');
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [assigneeScope, setAssigneeScope] = useAssigneeScope();
  const [storedGrouping, setStoredGrouping] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState({
    filterSignature: '',
    open: false,
    revision: 0,
  });
  const [sectionWindows, setSectionWindows] = useState<Record<ProjectStatus, number>>({
    do: INITIAL_WINDOW,
    delay: INITIAL_WINDOW,
    awaiting: INITIAL_WINDOW,
    delegate: INITIAL_WINDOW,
    done: INITIAL_WINDOW,
  });
  const [manualExpandedCards, setManualExpandedCards] = useState<string[] | null>(null);
  const [mountedIdsByStatus, setMountedIdsByStatus] = useState<MountedIdsByStatus>({
    do: [],
    delay: [],
    awaiting: [],
    delegate: [],
    done: [],
  });
  const [sectionPreferences, setSectionPreferences] = useState<{
    accountId: string | null;
    values: ExpandedSections;
  }>({ accountId: null, values: {} });
  const [activeProject, setActiveProject] = useState<ProjectSummary | null>(null);
  const updateProjectMutation = useUpdateProject();
  const batchUpdateMutation = useBatchUpdateProjects();
  const handleUpdateProject = (projectId: string, data: ProjectUpdateInput) => {
    updateProjectMutation.mutate({ projectId, data });
  };
  const handleStatusChange = (projectId: string, nextStatus: ProjectStatus) => {
    updateProjectMutation.mutate({ projectId, data: { status: nextStatus } });
  };

  const customerParam = searchParams.get('customer');
  useEffect(() => {
    setSelectedCustomer(customerParam || 'all');
  }, [customerParam]);

  const groupingStorageKey = `timdo:board:group:${accountId || 'anonymous'}`;
  useEffect(() => {
    try {
      setStoredGrouping(window.localStorage.getItem(groupingStorageKey));
    } catch {
      setStoredGrouping(null);
    }
  }, [groupingStorageKey]);
  const urlGrouping = searchParams.get('group');
  const groupBy = resolveBoardGrouping(urlGrouping, storedGrouping);

  const sectionStorageKey = `timdo:board:sections:${accountId || 'anonymous'}`;
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(sectionStorageKey);
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const values: ExpandedSections = {};
      STATUSES.forEach((section) => {
        if (typeof parsed[section] === 'boolean') {
          values[section] = parsed[section] as boolean;
        }
      });
      setSectionPreferences({ accountId, values });
    } catch {
      setSectionPreferences({ accountId, values: {} });
    }
  }, [accountId, sectionStorageKey]);
  useEffect(() => {
    if (accountId && sectionPreferences.accountId === accountId) {
      try {
        window.localStorage.setItem(sectionStorageKey, JSON.stringify(sectionPreferences.values));
      } catch {
        // A private window or disabled storage should not block the board.
      }
    }
  }, [accountId, sectionPreferences, sectionStorageKey]);

  const commonFilters = useMemo(
    () => ({
      ...(selectedOrgId !== 'all' ? { orgId: selectedOrgId } : {}),
      ...(selectedCustomer !== 'all' ? { customer: selectedCustomer } : {}),
    }),
    [selectedOrgId, selectedCustomer]
  );
  const summaryQuery = useBoardSummaries(commonFilters, doneCutoff, status === 'authenticated');
  const summaries = summaryQuery.data || [];
  const hasSharedTasks = useMemo(() => summaries.some((project) => project.isShared), [summaries]);
  const scope: AssigneeScope =
    assigneeScope === 'unassigned' && !hasSharedTasks ? 'everyone' : assigneeScope;
  const assigneeFilter =
    scope === 'mine' ? 'me' : scope === 'unassigned' ? 'unassigned' : undefined;
  const membershipFilters = useMemo(
    () => ({
      ...commonFilters,
      ...(selectedCategory !== 'All' ? { category: selectedCategory } : {}),
      ...(assigneeFilter ? { assignee: assigneeFilter } : {}),
    }),
    [commonFilters, selectedCategory, assigneeFilter]
  );
  const filterSignature = JSON.stringify([
    accountId,
    selectedOrgId,
    selectedCategory,
    selectedCustomer,
    scope,
    groupBy,
  ]);
  const historyOpen = historyView.filterSignature === filterSignature && historyView.open;
  const historyRevision = historyView.revision;
  const countsQuery = useBoardCounts(membershipFilters, status === 'authenticated');
  const historyQuery = useBoardDoneHistory(
    membershipFilters,
    doneCutoff,
    historyOpen,
    historyRevision
  );
  const { userId } = useCurrentUser();
  const { data: epics = [] } = useEpics();

  const setGroupBy = (value: string | null) => {
    const next = (value || 'none') as BoardGroupBy;
    try {
      window.localStorage.setItem(groupingStorageKey, next);
    } catch {
      // Grouping still works for this view if storage is unavailable.
    }
    setStoredGrouping(next);
    const search = updateBoardSearchParams(searchParams.toString(), 'group', next);
    router.push(`/board${search}`);
  };

  const handleCategorySelect = (category: string) => {
    const search = updateBoardSearchParams(
      searchParams.toString(),
      'category',
      category === 'All' ? null : category
    );
    router.push(`/board${search}`);
  };

  useEffect(() => {
    setSectionWindows({
      do: INITIAL_WINDOW,
      delay: INITIAL_WINDOW,
      awaiting: INITIAL_WINDOW,
      delegate: INITIAL_WINDOW,
      done: INITIAL_WINDOW,
    });
    setManualExpandedCards(null);
    setHistoryView((current) =>
      current.filterSignature === filterSignature
        ? current
        : {
            filterSignature,
            open: false,
            revision: current.revision + 1,
          }
    );
  }, [filterSignature]);
  const showDoneHistory = () =>
    setHistoryView((current) => ({
      filterSignature,
      open: true,
      revision:
        current.filterSignature === filterSignature ? current.revision : current.revision + 1,
    }));

  const epicTitles = useMemo(
    () => Object.fromEntries(epics.map((epic) => [epic.id, epic.title])),
    [epics]
  );
  const filteredProjects = useMemo(() => {
    let result = summaries;
    if (selectedOrgId !== 'all') {
      result = result.filter((project) => project.orgId === selectedOrgId);
    }
    result = filterByAssigneeScope(result, scope);
    if (selectedCategory !== 'All') {
      const normalizedCategory = normalizeCategory(selectedCategory);
      result = result.filter(
        (project) => normalizeCategory(project.category) === normalizedCategory
      );
    }
    if (selectedCustomer !== 'all') {
      result = result.filter(
        (project) => project.customer?.toLowerCase() === selectedCustomer.toLowerCase()
      );
    }
    return result;
  }, [summaries, selectedOrgId, selectedCategory, selectedCustomer, scope]);

  const customerOptions = useMemo(() => {
    const customers = new Set<string>();
    summaries.forEach((project) => {
      if (project.customer) {
        customers.add(project.customer.trim());
      }
    });
    return [
      { value: 'all', label: 'All Customers' },
      ...Array.from(customers)
        .sort((a, b) => a.localeCompare(b))
        .map((customer) => ({
          value: customer,
          label: customer,
        })),
    ];
  }, [summaries]);

  const { data: organisationsData = [] } = useOrganisations();
  const orgList = (Array.isArray(organisationsData) ? organisationsData : []).filter(
    (org) => org && org.id && org.name
  );
  const orgOptions = [
    { value: 'all', label: 'All workspaces' },
    ...orgList
      .slice()
      .sort((a, b) => Number(!a.isPersonal) - Number(!b.isPersonal))
      .map((org) => ({ value: String(org.id), label: workspaceLabel(org) })),
  ];

  const lookupWorkspace = useWorkspaceLookup();
  const sharedOrgIds = useMemo(
    () =>
      Array.from(
        new Set(
          summaries
            .filter((project) => project.isShared && project.orgId)
            .map((project) => project.orgId!)
        )
      ),
    [summaries]
  );
  const membersByOrg = useWorkspaceMembersMap(sharedOrgIds);
  const sharedWithLabel = (orgId: string) =>
    joinNames(
      (membersByOrg[orgId] || [])
        .filter((member) => member.userId !== userId)
        .map((member) => member.userName || member.userEmail)
    );

  const categoryGroups = useMemo(() => {
    const pool =
      selectedOrgId === 'all'
        ? summaries
        : summaries.filter((project) => project.orgId === selectedOrgId);
    const groups = new Map<
      string,
      { orgId: string; label: string; isShared: boolean; categories: string[] }
    >();
    pool.forEach((project) => {
      if (!project.category) {
        return;
      }
      const key = project.orgId || 'personal';
      const group = groups.get(key) || {
        orgId: key,
        label: lookupWorkspace(project.orgId, project).label,
        isShared: !!project.isShared,
        categories: [],
      };
      if (!group.categories.includes(project.category)) {
        group.categories.push(project.category);
      }
      groups.set(key, group);
    });
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        categories: group.categories.sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => Number(a.isShared) - Number(b.isShared) || a.label.localeCompare(b.label));
  }, [summaries, selectedOrgId, lookupWorkspace]);

  const projectsByStatus = useMemo<Record<ProjectStatus, ProjectSummary[]>>(() => {
    const data: Record<ProjectStatus, ProjectSummary[]> = {
      do: [],
      delay: [],
      awaiting: [],
      delegate: [],
      done: [],
    };
    filteredProjects.forEach((project) => data[project.status].push(project));
    data.do.sort((a, b) => b.priority - a.priority || sizeToNumber(a.size) - sizeToNumber(b.size));
    data.delay.sort(
      (a, b) => b.priority - a.priority || sizeToNumber(a.size) - sizeToNumber(b.size)
    );
    data.delegate.sort(
      (a, b) => b.priority - a.priority || sizeToNumber(a.size) - sizeToNumber(b.size)
    );
    data.awaiting.sort((a, b) => {
      const aDate = a.awaitUntil ? new Date(a.awaitUntil).getTime() : Infinity;
      const bDate = b.awaitUntil ? new Date(b.awaitUntil).getTime() : Infinity;
      return aDate - bDate || b.priority - a.priority;
    });
    data.done.sort((a, b) => {
      const aDate = a.statusLastChangedOn ? new Date(a.statusLastChangedOn).getTime() : 0;
      const bDate = b.statusLastChangedOn ? new Date(b.statusLastChangedOn).getTime() : 0;
      return bDate - aDate || b.priority - a.priority;
    });
    return data;
  }, [filteredProjects]);

  const fallbackStatusCounts = useMemo(() => {
    const fallback = emptyCounts();
    filteredProjects.forEach((project) => {
      fallback[project.status] += 1;
    });
    return fallback;
  }, [filteredProjects]);
  const statusCounts = countsQuery.data?.byStatus || fallbackStatusCounts;
  const visibleCount = countsQuery.data?.total ?? filteredProjects.length;
  const hasSharedProjects = summaries.some((project) => project.isShared);
  const scopeOptions = [
    { label: 'Everyone', value: 'everyone' },
    { label: 'Mine', value: 'mine' },
    ...(hasSharedProjects ? [{ label: 'Unassigned', value: 'unassigned' }] : []),
  ];

  const sectionCount = (section: ProjectStatus) => statusCounts[section];
  const isSectionExpanded = (section: ProjectStatus) => {
    const overrides = sectionPreferences.accountId === accountId ? sectionPreferences.values : {};
    return overrides[section] ?? shouldExpandBoardSection(sectionCount(section));
  };
  const toggleSection = (section: ProjectStatus) => {
    const nextValue = !isSectionExpanded(section);
    setSectionPreferences((current) => ({
      accountId,
      values: {
        ...(current.accountId === accountId ? current.values : {}),
        [section]: nextValue,
      },
    }));
  };

  const defaultExpandedCards = useMemo(
    () =>
      STATUSES.filter(
        (section) => section !== 'done' && sectionCountsValue(statusCounts[section]) <= 15
      ).flatMap((section) => projectsByStatus[section].map((project) => project.id)),
    [projectsByStatus, statusCounts]
  );
  const expandedCardIds = manualExpandedCards ?? defaultExpandedCards;
  const setExpandedCardIds = (ids: string[]) => setManualExpandedCards(ids);

  const onShowMore = (section: ProjectStatus) =>
    setSectionWindows((current) => ({ ...current, [section]: current[section] + 50 }));
  const reportMountedIds = useCallback((section: ProjectStatus, ids: string[]) => {
    setMountedIdsByStatus((current) => {
      const previous = current[section];
      if (previous.length === ids.length && previous.every((id, index) => id === ids[index])) {
        return current;
      }
      return { ...current, [section]: ids };
    });
  }, []);
  const mountedCallbacks = useMemo(
    () =>
      Object.fromEntries(
        STATUSES.map((section) => [section, (ids: string[]) => reportMountedIds(section, ids)])
      ) as Record<ProjectStatus, (ids: string[]) => void>,
    [reportMountedIds]
  );
  const mountedIds = useMemo(
    () => new Set(STATUSES.flatMap((section) => mountedIdsByStatus[section])),
    [mountedIdsByStatus]
  );
  const groupsByStatus = useMemo<
    Record<ProjectStatus, Array<BoardTaskGroup<ProjectSummary>>>
  >(() => {
    const groups: Partial<Record<ProjectStatus, Array<BoardTaskGroup<ProjectSummary>>>> = {};
    STATUSES.forEach((section) => {
      groups[section] = groupBoardTasks(projectsByStatus[section], groupBy, epicTitles);
    });
    return groups as Record<ProjectStatus, Array<BoardTaskGroup<ProjectSummary>>>;
  }, [projectsByStatus, groupBy, epicTitles]);
  const groupIdByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    STATUSES.forEach((section) =>
      groupsByStatus[section].forEach((group) =>
        group.items.forEach((project) => map.set(project.id, group.id))
      )
    );
    return map;
  }, [groupsByStatus]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 10 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => {
    if (!mountedIds.has(String(event.active.id))) {
      return;
    }
    setActiveProject(summaries.find((project) => project.id === event.active.id) || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveProject(null);
    const { active, over } = event;
    const activeId = String(active.id);
    if (!over || !mountedIds.has(activeId) || active.id === over.id) {
      return;
    }

    const activeData = active.data.current as
      | { sortable?: { containerId?: string }; groupId?: string }
      | undefined;
    const overData = over.data.current as
      | { sortable?: { containerId?: string }; status?: string; groupId?: string }
      | undefined;
    const movedProject = summaries.find((project) => project.id === activeId);
    if (!movedProject) {
      return;
    }

    const activeContainer = (activeData?.sortable?.containerId ||
      movedProject.status) as ProjectStatus;
    const overContainerValue =
      overData?.status || overData?.sortable?.containerId || String(over.id);
    if (!STATUSES.includes(overContainerValue as ProjectStatus)) {
      return;
    }
    const overContainer = overContainerValue as ProjectStatus;
    const activeGroup = groupIdByTaskId.get(activeId) || activeData?.groupId;
    const overId = String(over.id);
    const overGroup = groupIdByTaskId.get(overId) || overData?.groupId;
    const targetProject =
      overId === overContainer ? null : summaries.find((project) => project.id === overId) || null;
    if (
      !canDropBoardTask({
        project: movedProject,
        targetStatus: overContainer,
        targetProject,
        sourceGroupId: activeGroup,
        targetGroupId: overGroup,
      })
    ) {
      return;
    }

    const isVisibleInSameGroup = (project: ProjectSummary) =>
      mountedIds.has(project.id) &&
      (!activeGroup || groupIdByTaskId.get(project.id) === activeGroup);
    const sameWorkspace = (project: ProjectSummary) =>
      project.id !== activeId &&
      project.orgId === movedProject.orgId &&
      canEditItem(project) &&
      isVisibleInSameGroup(project);
    const newColumn = projectsByStatus[overContainer].filter(sameWorkspace);
    const overIndex = newColumn.findIndex((project) => project.id === overId);
    newColumn.splice(overIndex === -1 ? newColumn.length : overIndex, 0, movedProject);

    const changed = (project: ProjectSummary, priority: number, nextStatus: ProjectStatus) =>
      project.priority !== priority || project.status !== nextStatus;
    const updates = recalculatePriorities(newColumn)
      .map((project) => ({ id: project.id, priority: project.priority, status: overContainer }))
      .filter((update) => {
        const original = summaries.find((project) => project.id === update.id);
        return !original || changed(original, update.priority, update.status);
      });

    if (activeContainer !== overContainer) {
      const oldColumn = projectsByStatus[activeContainer].filter(sameWorkspace);
      updates.push(
        ...recalculatePriorities(oldColumn)
          .map((project) => ({
            id: project.id,
            priority: project.priority,
            status: activeContainer,
          }))
          .filter((update) => {
            const original = summaries.find((project) => project.id === update.id);
            return !original || changed(original, update.priority, update.status);
          })
      );
    }

    if (updates.length === 0) {
      return;
    }
    batchUpdateMutation.mutate(updates);
    if (activeContainer === 'awaiting' && overContainer !== 'awaiting') {
      updateProjectMutation.mutate({ projectId: activeId, data: { awaitUntil: null } });
    }
  };

  if (status === 'loading') {
    return <Loader role="status" aria-label="Loading session" />;
  }

  const isLoading = summaryQuery.isLoading || countsQuery.isLoading;
  const isError = summaryQuery.isError || countsQuery.isError;
  const error = summaryQuery.error || countsQuery.error;
  const showGroupLabels =
    categoryGroups.length > 1 || categoryGroups.some((group) => group.isShared);
  const historyItems = Array.from(
    new Map(
      (historyQuery.data?.pages.flatMap((page) => page.items) || []).map((project) => [
        project.id,
        project,
      ])
    ).values()
  );

  return (
    <Container>
      <Group justify="space-between" align="center" mb="md" wrap="wrap">
        <div>
          <Title order={1}>Your Board</Title>
          {hasSharedTasks && (
            <Text size="sm" c="dimmed">
              Your tasks and your team&apos;s tasks, across all your workspaces.
            </Text>
          )}
        </div>
        <Tooltip label="Search tasks & notes (/)" withArrow>
          <ActionIcon
            variant="default"
            size="lg"
            radius="md"
            onClick={() => setSearchModalOpen(true)}
            aria-label="Search tasks"
          >
            <IconSearch size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Group justify="space-between" align="flex-end" mb="md" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          {orgList.length > 1 && (
            <Select
              label="Workspace"
              data={orgOptions}
              value={selectedOrgId}
              onChange={(value) => setSelectedOrgId(value || 'all')}
              allowDeselect={false}
              size="sm"
              style={{ width: 200 }}
            />
          )}
          <Select
            label="Customer"
            data={customerOptions}
            value={selectedCustomer}
            onChange={(value) => setSelectedCustomer(value || 'all')}
            allowDeselect={false}
            size="sm"
            style={{ width: 180 }}
          />
          <Select
            label="Group by"
            data={[
              { value: 'none', label: 'None' },
              { value: 'project', label: 'Project' },
              { value: 'epic', label: 'Epic' },
              { value: 'assignee', label: 'Assignee' },
            ]}
            value={groupBy}
            onChange={setGroupBy}
            allowDeselect={false}
            size="sm"
            style={{ width: 160 }}
            aria-label="Group by"
          />
        </Group>
        <Tooltip
          label="Mine: assigned to you, or unassigned tasks you created"
          withArrow
          openDelay={400}
        >
          <SegmentedControl
            aria-label="Whose tasks to show"
            value={scope}
            onChange={(value) => setAssigneeScope(value as AssigneeScope)}
            data={scopeOptions}
          />
        </Tooltip>
      </Group>

      <Group gap="xs" mb="lg" align="center">
        <CategoryPill
          label="All"
          active={selectedCategory === 'All'}
          onClick={() => handleCategorySelect('All')}
        />
        {categoryGroups.map((group) => (
          <Group key={group.orgId} gap={6} align="center" wrap="wrap">
            {showGroupLabels && (
              <Tooltip
                label={
                  group.isShared
                    ? sharedWithLabel(group.orgId)
                      ? `Shared with ${sharedWithLabel(group.orgId)}`
                      : 'Shared workspace'
                    : 'Only you can see these'
                }
                withArrow
              >
                <Group gap={4} ml="xs" wrap="nowrap" data-testid={`workspace-label-${group.orgId}`}>
                  {group.isShared && <IconUsers size={14} color="var(--mantine-color-grape-6)" />}
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                    {group.label}
                  </Text>
                </Group>
              </Tooltip>
            )}
            {group.categories.map((category) => (
              <CategoryPill
                key={`${group.orgId}-${category}`}
                label={category}
                active={isCategorySelected(selectedCategory, category)}
                shared={group.isShared}
                onClick={() => handleCategorySelect(category)}
              />
            ))}
          </Group>
        ))}
      </Group>

      {isLoading && !summaryQuery.data && <BoardSkeleton />}
      {isError && (
        <Alert title="Error" color="red" mb="md">
          There was a problem fetching your projects: {error?.message}
        </Alert>
      )}
      {summaryQuery.data && countsQuery.isError && (
        <Alert title="Counts unavailable" color="yellow" mb="md">
          Board counts could not be refreshed: {countsQuery.error?.message}
        </Alert>
      )}

      {summaryQuery.data && visibleCount === 0 && (
        <Paper withBorder radius="md" p="xl" mb="lg" data-testid="board-empty">
          <Stack align="center" gap="sm">
            <Text c="dimmed" ta="center">
              {selectedCategory !== 'All' || selectedCustomer !== 'all' || selectedOrgId !== 'all'
                ? 'No tasks match these filters.'
                : SCOPE_EMPTY_COPY[scope]}
            </Text>
            {scope !== 'everyone' && (
              <Button variant="light" size="xs" onClick={() => setAssigneeScope('everyone')}>
                Show everyone&apos;s tasks
              </Button>
            )}
          </Stack>
        </Paper>
      )}

      {summaryQuery.data && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <Stack>
            {STATUSES.filter((section) => section !== 'done').map((section) => (
              <ProjectSection
                key={`${accountId || 'anonymous'}:${section}`}
                id={section}
                title={
                  section === 'do'
                    ? 'Do'
                    : section === 'delay'
                      ? 'Delay'
                      : section === 'awaiting'
                        ? 'Awaiting'
                        : 'Delegate'
                }
                projects={projectsByStatus[section]}
                taskCount={sectionCountsValue(statusCounts[section])}
                sectionExpanded={isSectionExpanded(section)}
                onToggleSection={() => toggleSection(section)}
                groupBy={groupBy}
                groups={groupsByStatus[section]}
                visibleLimit={sectionWindows[section]}
                onShowMore={() => onShowMore(section)}
                expandedTaskIds={expandedCardIds}
                onExpandedTaskIdsChange={setExpandedCardIds}
                onMountedIdsChange={mountedCallbacks[section]}
                onUpdateProject={handleUpdateProject}
                onStatusChange={handleStatusChange}
              />
            ))}
            <DoneProjectList
              key={`${accountId || 'anonymous'}:done`}
              title="Done"
              projects={projectsByStatus.done}
              totalCount={statusCounts.done}
              expanded={isSectionExpanded('done')}
              onToggle={() => toggleSection('done')}
              groupBy={groupBy}
              epicTitles={epicTitles}
              visibleLimit={sectionWindows.done}
              onShowMore={() => onShowMore('done')}
              historyOpen={historyOpen}
              historyItems={historyItems}
              historyLoading={
                historyQuery.isLoading || (historyQuery.isFetching && historyItems.length === 0)
              }
              historyLoadingMore={historyQuery.isFetchingNextPage}
              historyError={historyQuery.isError ? historyQuery.error : null}
              historyHasNext={!!historyQuery.hasNextPage}
              onShowOlder={showDoneHistory}
              onLoadMoreOlder={() => void historyQuery.fetchNextPage()}
              onRetryOlder={() => void historyQuery.refetch()}
            />
          </Stack>
          <DragOverlay>
            {activeProject ? <ProjectCardPreview project={activeProject} /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <QuickSearchModal opened={searchModalOpen} onClose={() => setSearchModalOpen(false)} />
    </Container>
  );
}

function sectionCountsValue(count: number): number {
  return Number.isFinite(count) ? count : 0;
}

function recalculatePriorities(projects: ProjectSummary[]): ProjectSummary[] {
  if (projects.length === 0) {
    return [];
  }
  if (projects.length === 1) {
    return [{ ...projects[0], priority: 10 }];
  }
  return projects.map((project, index) => ({
    ...project,
    priority: Math.round(10 - (index * 9) / (projects.length - 1)),
  }));
}

function CategoryPill({
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
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {label}
    </Pill>
  );
}

export default function BoardPage() {
  return (
    <Suspense fallback={<Loader role="status" aria-label="Loading board" />}>
      <BoardContent />
    </Suspense>
  );
}
