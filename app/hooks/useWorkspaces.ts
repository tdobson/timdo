import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { fetchOrganisationMembers, fetchOrganisationProjects } from '../lib/apiClient';
import type {
  Organisation,
  OrganisationMember,
  ProjectContainer,
} from '../types/organisation.types';
import { organisationKeys, useOrganisations } from './useOrganisationQueries';

/** A workspace with its projects, ready for pickers and overviews. */
export interface WorkspaceWithProjects {
  org: Organisation;
  /** "Personal" for the personal workspace, otherwise the workspace name */
  label: string;
  /** More than one member */
  isShared: boolean;
  /** False for viewers */
  canEdit: boolean;
  projects: ProjectContainer[];
}

/** One option in a grouped project picker. */
export interface ProjectOption {
  value: string;
  label: string;
  projectName: string;
  orgId: string;
  orgLabel: string;
  isShared: boolean;
  canEdit: boolean;
}

function labelFor(org: Organisation) {
  return org.isPersonal ? 'Personal' : org.name;
}

/**
 * Every workspace I belong to with its (non-archived) projects. Personal first, then shared
 * workspaces by name. Also returns grouped Select data for project pickers, leaving out
 * workspaces where I'm a viewer.
 */
export function useWorkspaceProjects() {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const orgsQuery = useOrganisations();
  const orgs = useMemo(
    () => (Array.isArray(orgsQuery.data) ? orgsQuery.data.filter((o) => o && o.id) : []),
    [orgsQuery.data]
  );

  const projectQueries = useQueries({
    queries: orgs.map((org) => ({
      queryKey: [...organisationKeys.account(accountId), 'projects', org.id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchOrganisationProjects(org.id, token, signal),
      enabled: !!token && !!accountId,
      staleTime: 60 * 1000,
    })),
  });

  const projectsKey = projectQueries.map((q) => q.dataUpdatedAt).join(',');

  const workspaces = useMemo<WorkspaceWithProjects[]>(() => {
    const list = orgs.map((org, i) => {
      const data = projectQueries[i]?.data;
      return {
        org,
        label: labelFor(org),
        isShared: !org.isPersonal && (org.memberCount ?? 2) > 1,
        canEdit: org.role !== 'viewer',
        projects: (Array.isArray(data) ? data : [])
          .filter((p) => !p.isArchived)
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
    return list.sort((a, b) => {
      if (!!a.org.isPersonal !== !!b.org.isPersonal) {
        return a.org.isPersonal ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });
  }, [orgs, projectsKey]);

  const projectOptions = useMemo<ProjectOption[]>(
    () =>
      workspaces.flatMap((ws) =>
        ws.projects.map((p) => ({
          value: p.id,
          label: p.name,
          projectName: p.name,
          orgId: ws.org.id,
          orgLabel: ws.label,
          isShared: ws.isShared,
          canEdit: ws.canEdit,
        }))
      ),
    [workspaces]
  );

  /** Grouped Mantine Select data of the projects I can add to. */
  const editableProjectGroups = useMemo(
    () =>
      workspaces
        .filter((ws) => ws.canEdit && ws.projects.length > 0)
        .map((ws) => ({
          group: ws.isShared ? `${ws.label} (shared)` : ws.label,
          items: ws.projects.map((p) => ({ value: p.id, label: p.name })),
        })),
    [workspaces]
  );

  return {
    workspaces,
    projectOptions,
    editableProjectGroups,
    findProject: (projectId: string | null | undefined) =>
      projectOptions.find((p) => p.value === projectId) ?? null,
    hasSharedWorkspace: workspaces.some((ws) => ws.isShared),
    isLoading: orgsQuery.isLoading || projectQueries.some((q) => q.isLoading),
  };
}

/**
 * Members of several workspaces at once, keyed by workspace id. Shares its cache with
 * `useOrganisationMembers`.
 */
export function useWorkspaceMembersMap(orgIds: Array<string | null | undefined>) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const ids = Array.from(new Set(orgIds.filter((id): id is string => !!id))).sort();

  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: organisationKeys.members(id, accountId),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchOrganisationMembers(id, token, signal),
      enabled: !!token && !!accountId,
      staleTime: 5 * 60 * 1000,
    })),
  });

  const key = `${ids.join(',')}|${queries.map((q) => q.dataUpdatedAt).join(',')}`;

  return useMemo(() => {
    const map: Record<string, OrganisationMember[]> = {};
    ids.forEach((id, i) => {
      const data = queries[i]?.data;
      map[id] = Array.isArray(data) ? data : [];
    });
    return map;
  }, [key]);
}

/**
 * Look up a workspace's display details by id: "Personal" for the personal workspace, the
 * workspace name otherwise. Tasks and epics only carry `orgName`, which for a personal
 * workspace is "Personal Workspace" or the owner's name, so always go through this.
 */
export function useWorkspaceLookup() {
  const { data: orgs } = useOrganisations();
  return useMemo(() => {
    const byId = new Map((Array.isArray(orgs) ? orgs : []).map((o) => [o.id, o]));
    return (
      orgId: string | null | undefined,
      fallback?: { orgName?: string | null; isShared?: boolean }
    ) => {
      const org = orgId ? byId.get(orgId) : undefined;
      if (org) {
        return { label: labelFor(org), isPersonal: !!org.isPersonal };
      }
      // Not loaded yet: assume a non-shared workspace is the personal one
      return fallback?.isShared
        ? { label: fallback.orgName || 'Workspace', isPersonal: false }
        : { label: 'Personal', isPersonal: true };
    };
  }, [orgs]);
}
