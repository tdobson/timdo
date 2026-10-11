/**
 * @fileoverview API calls for sharing, invites and the activity log (see docs/collaboration.md).
 * Every call takes the Auth0 access token and throws a CollaborationApiError whose message is
 * the server's readable error, ready to show in a notification.
 * @module app/lib/collaborationApi
 */

import type {
  AcceptInviteResult,
  ActivityEntry,
  ActivityFilters,
  BotRole,
  BotView,
  CreatedBotResult,
  CreatedBotToken,
  InviteResult,
  InviteRole,
  Me,
  ProjectContainerUpdate,
  SharingProject,
  SharingWorkspace,
  UserSearchResult,
  WorkspaceRole,
  WorkspaceSummary,
} from '../types/collaboration.types';
import { apiFetch } from './apiClient';
import { getWorkerApiBaseUrl } from './apiConfig';

/** Public web address used in invite links. */
export const INVITE_BASE_URL = 'https://timdo.tdobson.net/invite';

export function inviteLink(token: string): string {
  return `${INVITE_BASE_URL}/${token}`;
}

export class CollaborationApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'CollaborationApiError';
    this.status = status;
  }
}

/** Pull a readable message out of an error body: `{ error: "..." }` or a zod issue list. */
export function readErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown; message?: unknown }).error;
    if (typeof err === 'string' && err.trim()) {
      return err;
    }
    if (err && typeof err === 'object') {
      const issues = (err as { issues?: Array<{ message?: string }> }).issues;
      if (Array.isArray(issues) && issues[0]?.message) {
        return issues[0].message;
      }
      const name = (err as { message?: unknown }).message;
      if (typeof name === 'string' && name.trim()) {
        return name;
      }
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  if (status === 403) {
    return 'You do not have permission to do that';
  }
  if (status === 404) {
    return 'Not found, or you no longer have access';
  }
  return 'Something went wrong. Please try again.';
}

async function request<T>(
  path: string,
  token: string | undefined,
  options: { method?: string; body?: unknown; signal?: AbortSignal; cache?: RequestCache } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await apiFetch(`${getWorkerApiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    cache: options.cache,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new CollaborationApiError(readErrorMessage(body, res.status), res.status);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ who am I */

export function fetchMe(token?: string, signal?: AbortSignal): Promise<Me> {
  return request<Me>('/users/me', token, { signal });
}

/* ------------------------------------------------------------------ workspaces */

export function fetchWorkspaces(token?: string, signal?: AbortSignal): Promise<WorkspaceSummary[]> {
  return request<WorkspaceSummary[]>('/organisations', token, { signal });
}

export function fetchSharingOverview(
  token?: string,
  signal?: AbortSignal
): Promise<SharingWorkspace[]> {
  return request<SharingWorkspace[]>('/organisations/sharing', token, { signal });
}

export function createWorkspace(name: string, token?: string): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>('/organisations', token, { method: 'POST', body: { name } });
}

export function renameWorkspace(
  orgId: string,
  name: string,
  token?: string
): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>(`/organisations/${orgId}`, token, {
    method: 'PUT',
    body: { name },
  });
}

export function deleteWorkspace(orgId: string, token?: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/organisations/${orgId}`, token, { method: 'DELETE' });
}

/* ------------------------------------------------------------------ people */

export function searchPeople(
  orgId: string,
  query: string,
  token?: string,
  signal?: AbortSignal
): Promise<UserSearchResult[]> {
  return request<UserSearchResult[]>(
    `/organisations/${orgId}/users/search?q=${encodeURIComponent(query)}`,
    token,
    { signal }
  );
}

export function sharePerson(
  orgId: string,
  email: string,
  role: InviteRole,
  token?: string
): Promise<InviteResult> {
  return request<InviteResult>(`/organisations/${orgId}/invites`, token, {
    method: 'POST',
    body: { email, role },
  });
}

export function revokeInvite(
  orgId: string,
  inviteId: string,
  token?: string
): Promise<{ message: string }> {
  return request<{ message: string }>(`/organisations/${orgId}/invites/${inviteId}`, token, {
    method: 'DELETE',
  });
}

export function acceptInvite(inviteToken: string, token?: string): Promise<AcceptInviteResult> {
  return request<AcceptInviteResult>('/organisations/invites/accept', token, {
    method: 'POST',
    body: { token: inviteToken },
  });
}

export function changeMemberRole(
  orgId: string,
  userId: string,
  role: WorkspaceRole,
  token?: string
): Promise<unknown> {
  return request<unknown>(`/organisations/${orgId}/members/${encodeURIComponent(userId)}`, token, {
    method: 'PUT',
    body: { role },
  });
}

export function removeMember(
  orgId: string,
  userId: string,
  token?: string
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/organisations/${orgId}/members/${encodeURIComponent(userId)}`,
    token,
    { method: 'DELETE' }
  );
}

/* ------------------------------------------------------------------ projects */

export function addWorkspaceProject(
  orgId: string,
  data: { name: string; description?: string | null },
  token?: string
): Promise<SharingProject> {
  return request<SharingProject>(`/organisations/${orgId}/projects`, token, {
    method: 'POST',
    body: data,
  });
}

export function updateWorkspaceProject(
  orgId: string,
  projectId: string,
  data: ProjectContainerUpdate,
  token?: string
): Promise<unknown> {
  return request<unknown>(`/organisations/${orgId}/projects/${projectId}`, token, {
    method: 'PUT',
    body: data,
  });
}

/* ------------------------------------------------------------------ activity */

export function activityQueryString(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.taskId) {
    params.set('taskId', filters.taskId);
  }
  if (filters.epicId) {
    params.set('epicId', filters.epicId);
  }
  if (filters.projectId) {
    params.set('projectId', filters.projectId);
  }
  if (filters.orgId) {
    params.set('orgId', filters.orgId);
  }
  if (filters.limit) {
    params.set('limit', String(filters.limit));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchActivity(
  filters: ActivityFilters,
  token?: string,
  signal?: AbortSignal
): Promise<ActivityEntry[]> {
  return request<ActivityEntry[]>(`/activity${activityQueryString(filters)}`, token, { signal });
}

/* ------------------------------------------------------------------ bots */

const botsPath = (orgId: string) => `/organisations/${encodeURIComponent(orgId)}/bots`;
const botPath = (orgId: string, botId: string) => `${botsPath(orgId)}/${encodeURIComponent(botId)}`;

export function fetchBots(orgId: string, token?: string, signal?: AbortSignal): Promise<BotView[]> {
  return request<BotView[]>(botsPath(orgId), token, { signal });
}

/** Returns a copy-once secret. Call directly from component code, never a query or mutation. */
export function createBot(
  orgId: string,
  input: { name: string; role?: BotRole; tokenName?: string },
  token?: string
): Promise<CreatedBotResult> {
  return request<CreatedBotResult>(botsPath(orgId), token, {
    method: 'POST',
    body: input,
    cache: 'no-store',
  });
}

export function updateBot(
  orgId: string,
  botId: string,
  input: { name?: string; role?: BotRole },
  token?: string
): Promise<BotView> {
  return request<BotView>(botPath(orgId, botId), token, { method: 'PUT', body: input });
}

export function disableBot(orgId: string, botId: string, token?: string): Promise<void> {
  return request<void>(botPath(orgId, botId), token, { method: 'DELETE' });
}

/** Returns a copy-once secret. Call directly from component code, never a query or mutation. */
export function createBotToken(
  orgId: string,
  botId: string,
  name: string,
  token?: string
): Promise<CreatedBotToken> {
  return request<CreatedBotToken>(`${botPath(orgId, botId)}/tokens`, token, {
    method: 'POST',
    body: { name },
    cache: 'no-store',
  });
}

export function revokeBotToken(
  orgId: string,
  botId: string,
  tokenId: string,
  token?: string
): Promise<void> {
  return request<void>(`${botPath(orgId, botId)}/tokens/${encodeURIComponent(tokenId)}`, token, {
    method: 'DELETE',
  });
}
