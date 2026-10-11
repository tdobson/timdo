import { signIn } from 'next-auth/react';
import type { Epic, EpicCreateInput, EpicUpdateInput } from '../types/epic.types';
import type { Goal, GoalCreateInput, GoalType, GoalUpdateInput } from '../types/goal.types';
import type {
  AutocompleteUserResult,
  InviteMemberInput,
  Organisation,
  OrganisationCreateInput,
  OrganisationInvite,
  OrganisationMember,
  ProjectContainer,
} from '../types/organisation.types';
import type {
  CurrentUser,
  Project,
  ProjectCounts,
  ProjectDetail,
  ProjectListFilters,
  ProjectListPage,
  ProjectSummary,
  ProjectUpdate,
} from '../types/project.types';
import { getWorkerApiBaseUrl } from './apiConfig';

/**
 * API client with automatic 401 handling
 * Redirects to sign-in page when access token expires
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, options);

  // Handle expired/invalid token
  if (response.status === 401) {
    // Redirect to sign-in page
    await signIn('auth0', { callbackUrl: window.location.pathname });
    throw new Error('Session expired. Please sign in again.');
  }

  return response;
}

/**
 * Error thrown for non-2xx API responses. `message` is readable and safe to show to the user
 * (the API sends `{ error }` bodies such as `You have view-only access to "Acme Solar"`).
 */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Turns a failed response into an {@link ApiError}. JSON `{ error }` bodies become the message
 * as-is; anything else keeps the older `API error (status): body` form.
 */
export async function readApiError(response: Response, fallback?: string): Promise<ApiError> {
  let text = '';
  let body: unknown;
  if (typeof response.text === 'function') {
    text = await response.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON, keep the raw text
      }
    }
  } else if (typeof (response as Partial<Response>).json === 'function') {
    body = await response.json().catch(() => undefined);
  }

  let message = '';
  if (body && typeof body === 'object') {
    const { error, message: bodyMessage } = body as { error?: unknown; message?: unknown };
    if (typeof error === 'string' && error) {
      message = error;
    } else if (typeof bodyMessage === 'string' && bodyMessage) {
      message = bodyMessage;
    }
  }
  if (!message) {
    message = fallback || `API error (${response.status}): ${text || 'Unknown error'}`;
  }
  return new ApiError(message, response.status);
}

/** True when an error means "you can't do that" or "you can't see that". */
export function isAccessError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/**
 * API client that automatically handles JSON and errors
 */
export async function apiCall<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(url, options);

  if (!response.ok) {
    throw await readApiError(response);
  }

  return response.json();
}

function authHeaders(token?: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch the signed-in user (`GET /users/me`)
 */
export async function fetchCurrentUser(token?: string): Promise<CurrentUser> {
  return apiCall<CurrentUser>(`${getWorkerApiBaseUrl()}/users/me`, {
    headers: authHeaders(token),
  });
}

/**
 * Fetch one task (`GET /projects/:id`). Resolves to null when the task does not exist or is
 * not visible to the caller.
 */
export async function getProjectById(
  projectId: string,
  token?: string,
  signal?: AbortSignal
): Promise<ProjectDetail | null> {
  const response = await apiFetch(
    `${getWorkerApiBaseUrl()}/projects/${encodeURIComponent(projectId)}`,
    { headers: authHeaders(token), signal }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await readApiError(response);
  }
  const project = await response.json();
  // A legacy null is an empty full body; a missing field is still only a summary.
  return project.notes === null ? { ...project, notes: '' } : project;
}

/**
 * Fetch one epic (`GET /epics/:id`). Resolves to null when it is missing or not visible.
 */
export async function getEpicById(epicId: string, token?: string): Promise<Epic | null> {
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/epics/${encodeURIComponent(epicId)}`, {
    headers: authHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await readApiError(response);
  }
  return response.json();
}

/**
 * Fetch the projects (containers) inside a workspace
 */
export async function fetchOrganisationProjects(
  orgId: string,
  token?: string
): Promise<ProjectContainer[]> {
  return apiCall<ProjectContainer[]>(
    `${getWorkerApiBaseUrl()}/organisations/${encodeURIComponent(orgId)}/projects`,
    { headers: authHeaders(token) }
  );
}

/**
 * Full-text search over every task the caller can see (`GET /tasks/search`)
 */
export async function searchTasks<T>(
  query: string,
  includeDone: boolean,
  token?: string
): Promise<T[]> {
  const params = new URLSearchParams({
    q: query.trim(),
    includeDone: includeDone ? 'true' : 'false',
  });
  return apiCall<T[]>(`${getWorkerApiBaseUrl()}/tasks/search?${params.toString()}`, {
    headers: authHeaders(token),
  });
}

/** Where to look for tasks like a new title: one project's workspace, one workspace, or all. */
export interface SimilarTasksQuery {
  title: string;
  projectId?: string | null;
  orgId?: string | null;
  excludeId?: string | null;
  limit?: number;
}

/**
 * Open tasks that look like a title someone is about to create (`GET /tasks/similar`), best
 * first. Pass the query's `signal` so a stale request is dropped when the title changes.
 */
export async function findSimilarTasks<T>(
  query: SimilarTasksQuery,
  token?: string,
  signal?: AbortSignal
): Promise<T[]> {
  const params = new URLSearchParams({ title: query.title.trim() });
  if (query.projectId) {
    params.set('projectId', query.projectId);
  }
  if (query.orgId) {
    params.set('orgId', query.orgId);
  }
  if (query.excludeId) {
    params.set('excludeId', query.excludeId);
  }
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  return apiCall<T[]>(`${getWorkerApiBaseUrl()}/tasks/similar?${params.toString()}`, {
    headers: authHeaders(token),
    signal,
  });
}

/**
 * Fetch all updates/notes for a project
 */
export async function getProjectUpdates(
  projectId: string,
  token?: string
): Promise<ProjectUpdate[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<ProjectUpdate[]>(`${getWorkerApiBaseUrl()}/projects/${projectId}/updates`, {
    headers,
  });
}

/**
 * Add a new update/note to a project
 */
export async function addProjectUpdate(
  projectId: string,
  data: { note: string; gmailThreadId?: string },
  token?: string
): Promise<ProjectUpdate> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<ProjectUpdate>(`${getWorkerApiBaseUrl()}/projects/${projectId}/updates`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Delete an update/note from a project
 */
export async function deleteProjectUpdate(
  projectId: string,
  updateId: string,
  token?: string
): Promise<{ message: string }> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<{ message: string }>(
    `${getWorkerApiBaseUrl()}/projects/${projectId}/updates/${updateId}`,
    {
      method: 'DELETE',
      headers,
    }
  );
}

// --- Goals API Methods ---

/**
 * Fetch all goals for user (optionally filtered by type)
 */
export async function getGoals(type?: GoalType, token?: string): Promise<Goal[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return apiCall<Goal[]>(`${getWorkerApiBaseUrl()}/goals${query}`, {
    headers,
  });
}

/**
 * Create a new goal
 */
export async function createGoal(data: GoalCreateInput, token?: string): Promise<Goal> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Goal>(`${getWorkerApiBaseUrl()}/goals`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Update an existing goal
 */
export async function updateGoal(
  goalId: string,
  data: GoalUpdateInput,
  token?: string
): Promise<Goal> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Goal>(`${getWorkerApiBaseUrl()}/goals/${goalId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Delete a goal
 */
export async function deleteGoal(goalId: string, token?: string): Promise<{ message: string }> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<{ message: string }>(`${getWorkerApiBaseUrl()}/goals/${goalId}`, {
    method: 'DELETE',
    headers,
  });
}

/**
 * Get dynamic vector poster SVG URL
 */
export function getPosterSvgUrl(): string {
  return `${getWorkerApiBaseUrl()}/goals/poster.svg`;
}

// --- Epics API Methods ---

/**
 * Fetch all epics for user (optionally filtered by category)
 */
export async function getEpics(category?: string, token?: string): Promise<Epic[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const query = category ? `?category=${encodeURIComponent(category)}` : '';
  return apiCall<Epic[]>(`${getWorkerApiBaseUrl()}/epics${query}`, {
    headers,
  });
}

/**
 * Create a new epic
 */
export async function createEpic(data: EpicCreateInput, token?: string): Promise<Epic> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Epic>(`${getWorkerApiBaseUrl()}/epics`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Update an existing epic
 */
export async function updateEpic(
  epicId: string,
  data: EpicUpdateInput,
  token?: string
): Promise<Epic> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Epic>(`${getWorkerApiBaseUrl()}/epics/${epicId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Delete an epic
 */
export async function deleteEpic(epicId: string, token?: string): Promise<{ message: string }> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<{ message: string }>(`${getWorkerApiBaseUrl()}/epics/${epicId}`, {
    method: 'DELETE',
    headers,
  });
}

/**
 * Fetch all projects for user
 */
export async function getProjects(token?: string): Promise<Project[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Project[]>(`${getWorkerApiBaseUrl()}/projects`, {
    headers,
  });
}

function projectListParams(filters: ProjectListFilters): URLSearchParams {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (key === 'status' && Array.isArray(value)) {
      if (value.length > 0) {
        params.set(key, value.join(','));
      }
      return;
    }
    if (typeof value === 'boolean') {
      params.set(key, String(value));
      return;
    }
    params.set(key, String(value));
  });
  return params;
}

/** Fetch one opt-in task page. The API body remains an array; continuation lives in headers. */
export async function getProjectPage<T = ProjectSummary>(
  filters: ProjectListFilters,
  token?: string,
  signal?: AbortSignal
): Promise<ProjectListPage<T>> {
  const params = projectListParams(filters);
  const query = params.toString();
  const response = await apiFetch(`${getWorkerApiBaseUrl()}/projects${query ? `?${query}` : ''}`, {
    headers: authHeaders(token),
    signal,
  });
  if (!response.ok) {
    throw await readApiError(response, 'Failed to fetch tasks');
  }
  const items = (await response.json()) as T[];
  const headers = response.headers;
  const rawTotal = headers?.get?.('X-Total-Count');
  const rawNextCursor = headers?.get?.('X-Next-Cursor');
  const total = rawTotal !== null && rawTotal !== undefined ? Number(rawTotal) : undefined;
  return {
    items,
    ...(Number.isFinite(total) ? { total } : {}),
    ...(rawNextCursor ? { nextCursor: rawNextCursor } : {}),
  };
}

/** Fetch list rows without imposing a page size. Existing getProjects remains the full legacy API. */
export async function getProjectList<T = ProjectSummary>(
  filters: ProjectListFilters,
  token?: string,
  signal?: AbortSignal
): Promise<T[]> {
  return (await getProjectPage<T>(filters, token, signal)).items;
}

/** Aggregate counts for the same server-side membership filters used by the list endpoint. */
export async function getProjectCounts(
  filters: ProjectListFilters,
  token?: string,
  signal?: AbortSignal
): Promise<ProjectCounts> {
  const { fields: _fields, limit: _limit, cursor: _cursor, ...membershipFilters } = filters;
  const params = projectListParams(membershipFilters);
  const query = params.toString();
  return apiCall<ProjectCounts>(
    `${getWorkerApiBaseUrl()}/projects/counts${query ? `?${query}` : ''}`,
    { headers: authHeaders(token), signal }
  );
}

/**
 * Merge source project into target project
 */
export async function mergeProjects(
  targetId: string,
  sourceId: string,
  token?: string
): Promise<Project> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await apiFetch(`${getWorkerApiBaseUrl()}/projects/${targetId}/merge`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceId }),
  });

  if (!res.ok) {
    throw await readApiError(res, 'Failed to merge tasks');
  }

  return res.json();
}

// --- Poster API Methods ---

export interface WallOfDonePosterOptions {
  categories?: string[];
  tiled?: boolean;
  timeframe?: '6m' | '12m' | 'all';
  format?: 'svg' | 'json';
}

export interface ActiveTasksPosterOptions {
  categories?: string[];
  tiled?: boolean;
  format?: 'svg' | 'json';
}

export interface LifeGoalsPosterOptions {
  tiled?: boolean;
  format?: 'svg' | 'json';
}

export interface WallOfDoneTiledResponse {
  totalCount: number;
  generatedAt: string;
  tiles: Array<{
    sheetIndex: number;
    label: string;
    tier: number;
    colOffset: number;
    svg: string;
  }>;
}

export interface WallOfDoneJsonResponse {
  data: any;
  svg: string;
}

export interface ActiveTasksJsonResponse {
  categories?: string[];
  tasks: Project[];
  svg: string;
}

/**
 * Fetch the Wall of Done poster from Worker API
 * Supports format: 'svg' (raw SVG string) or 'json' (structured data + SVG),
 * tiled=true (returns 6 distinct A4 SVG tiles), and categories filter.
 */
export async function getWallOfDonePoster(
  options: WallOfDonePosterOptions = {},
  token?: string
): Promise<string | WallOfDoneJsonResponse | WallOfDoneTiledResponse> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const queryParams = new URLSearchParams();
  if (options.format) {
    queryParams.set('format', options.format);
  }
  if (options.tiled) {
    queryParams.set('tiled', 'true');
  }
  if (options.timeframe) {
    queryParams.set('timeframe', options.timeframe);
  }
  if (options.categories && options.categories.length > 0) {
    queryParams.set('categories', options.categories.join(','));
  }

  const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
  const url = `${getWorkerApiBaseUrl()}/poster/wall-of-done${queryString}`;

  if (options.tiled || options.format === 'json') {
    return apiCall<WallOfDoneJsonResponse | WallOfDoneTiledResponse>(url, { headers });
  }

  // Default format: svg (returns raw SVG text)
  const response = await apiFetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  return response.text();
}

/**
 * Fetch the Active Tasks poster from Worker API
 * Supports format: 'svg' (raw SVG string) or 'json' (structured data + SVG),
 * and categories filter.
 */
export async function getActiveTasksPoster(
  options: ActiveTasksPosterOptions = {},
  token?: string
): Promise<string | any> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const queryParams = new URLSearchParams();
  if (options.format) {
    queryParams.set('format', options.format);
  }
  if (options.tiled) {
    queryParams.set('tiled', 'true');
  }
  if (options.categories && options.categories.length > 0) {
    queryParams.set('categories', options.categories.join(','));
  }

  const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
  const url = `${getWorkerApiBaseUrl()}/poster/active${queryString}`;

  if (options.tiled || options.format === 'json') {
    return apiCall<any>(url, { headers });
  }

  // Default format: svg (returns raw SVG text)
  const response = await apiFetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  return response.text();
}

/**
 * Fetch Life Goals poster (with optional 4x A4 tiling)
 */
export async function getLifeGoalsPoster(
  options: LifeGoalsPosterOptions = {},
  token?: string
): Promise<string | any> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const queryParams = new URLSearchParams();
  if (options.format) {
    queryParams.set('format', options.format);
  }
  if (options.tiled) {
    queryParams.set('tiled', 'true');
  }

  const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
  const url = `${getWorkerApiBaseUrl()}/poster/goals-rhythm${queryString}`;

  if (options.tiled || options.format === 'json') {
    return apiCall<any>(url, { headers });
  }

  const response = await apiFetch(url, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  return response.text();
}

// --- Organisations API Methods ---

/**
 * Fetch all organisations the current user belongs to
 */
export async function fetchOrganisations(token?: string): Promise<Organisation[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Organisation[]>(`${getWorkerApiBaseUrl()}/organisations`, {
    headers,
  });
}

/**
 * Create a new organisation
 */
export async function createOrganisation(
  data: OrganisationCreateInput,
  token?: string
): Promise<Organisation> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Organisation>(`${getWorkerApiBaseUrl()}/organisations`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Fetch organisation by ID
 */
export async function fetchOrganisation(orgId: string, token?: string): Promise<Organisation> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Organisation>(`${getWorkerApiBaseUrl()}/organisations/${orgId}`, {
    headers,
  });
}

/**
 * Fetch members of an organisation
 */
export async function fetchOrganisationMembers(
  orgId: string,
  token?: string
): Promise<OrganisationMember[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<OrganisationMember[]>(`${getWorkerApiBaseUrl()}/organisations/${orgId}/members`, {
    headers,
  });
}

/**
 * Search users for autocomplete within an organisation
 */
export async function searchUsers(
  orgId: string,
  query: string,
  token?: string
): Promise<AutocompleteUserResult[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<AutocompleteUserResult[]>(
    `${getWorkerApiBaseUrl()}/organisations/${orgId}/users/search?q=${encodeURIComponent(query)}`,
    {
      headers,
    }
  );
}

/**
 * Invite a member to an organisation
 */
export async function inviteUser(
  orgId: string,
  data: InviteMemberInput,
  token?: string
): Promise<OrganisationInvite> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<OrganisationInvite>(`${getWorkerApiBaseUrl()}/organisations/${orgId}/invites`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

/**
 * Fetch pending invites for an organisation
 */
export async function fetchOrganisationInvites(
  orgId: string,
  token?: string
): Promise<OrganisationInvite[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<OrganisationInvite[]>(`${getWorkerApiBaseUrl()}/organisations/${orgId}/invites`, {
    headers,
  });
}

/**
 * Update member role in organisation
 */
export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
  token?: string
): Promise<OrganisationMember> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<OrganisationMember>(
    `${getWorkerApiBaseUrl()}/organisations/${orgId}/members/${userId}`,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({ role }),
    }
  );
}

/**
 * Remove member from organisation
 */
export async function removeMember(
  orgId: string,
  userId: string,
  token?: string
): Promise<{ message: string }> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<{ message: string }>(
    `${getWorkerApiBaseUrl()}/organisations/${orgId}/members/${userId}`,
    {
      method: 'DELETE',
      headers,
    }
  );
}

// --- Tasks / Collaborative Task API Methods ---

export interface TaskFiltersClient {
  orgId?: string;
  projectId?: string;
  assigneeId?: string;
  status?: string;
  mine?: boolean;
  unassigned?: boolean;
}

/**
 * Fetch tasks with multi-user filters
 */
export async function fetchTasks(
  filters: TaskFiltersClient = {},
  token?: string
): Promise<Project[]> {
  const headers: HeadersInit = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const params = new URLSearchParams();
  if (filters.orgId) {
    params.set('orgId', filters.orgId);
  }
  if (filters.projectId) {
    params.set('projectId', filters.projectId);
  }
  if (filters.assigneeId) {
    params.set('assigneeId', filters.assigneeId);
  }
  if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.mine) {
    params.set('mine', 'true');
  }
  if (filters.unassigned) {
    params.set('unassigned', 'true');
  }

  const queryString = params.toString() ? `?${params.toString()}` : '';
  return apiCall<Project[]>(`${getWorkerApiBaseUrl()}/tasks${queryString}`, {
    headers,
  });
}

/**
 * Claim a task for current user (1-click claim)
 */
export async function claimTask(taskId: string, token?: string): Promise<Project> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<Project>(`${getWorkerApiBaseUrl()}/tasks/${taskId}/claim`, {
    method: 'POST',
    headers,
  });
}

/**
 * Assign task to a user (or null to unassign) via `PUT /projects/:id`
 */
export async function assignTask(
  taskId: string,
  assigneeId: string | null,
  token?: string
): Promise<Project> {
  return apiCall<Project>(`${getWorkerApiBaseUrl()}/projects/${taskId}`, {
    method: 'PUT',
    headers: authHeaders(token, true),
    body: JSON.stringify({ assigneeId }),
  });
}

/**
 * Link a task to a personal goal (private overlay)
 */
export async function linkTaskGoal(
  taskId: string,
  goalId: string,
  token?: string
): Promise<{ taskId: string; goalId: string; userId: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return apiCall<{ taskId: string; goalId: string; userId: string }>(
    `${getWorkerApiBaseUrl()}/tasks/${taskId}/goals`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ goalId }),
    }
  );
}
