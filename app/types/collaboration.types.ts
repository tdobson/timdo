/**
 * @fileoverview Types for sharing (workspaces, people, invites, projects) and the activity log.
 * Mirrors the API contract in docs/collaboration.md.
 * @module app/types/collaboration.types
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
export type PersonKind = 'human' | 'bot';
export type BotRole = 'member' | 'viewer';

export interface BotTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface BotView {
  id: string;
  kind: 'bot';
  name: string;
  role: BotRole | null;
  createdByName: string | null;
  createdAt: string | null;
  disabledAt: string | null;
  tokens: BotTokenSummary[];
}

export interface CreatedBotResult {
  bot: BotView;
  token: string;
}

export interface CreatedBotToken extends BotTokenSummary {
  token: string;
}

/** Roles that can be given through an invite (owners are promoted afterwards). */
export type InviteRole = Exclude<WorkspaceRole, 'owner'>;

export interface Me {
  id: string;
  email?: string;
  name: string | null;
  kind?: PersonKind;
  workspace?: { id: string; name: string; role: BotRole };
}

export interface SharingMember {
  id?: string;
  orgId?: string;
  userId: string;
  userName: string | null;
  /** Omitted for bot identities, whose internal email is never public. */
  userEmail?: string | null;
  /** Missing on pre-bot responses, which represent human members. */
  kind?: PersonKind;
  role: WorkspaceRole;
  isMe: boolean;
  createdAt?: string | null;
}

export interface SharingProject {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  openTasks: number;
  doneTasks: number;
  epicCount: number;
}

export interface SharingInvite {
  id: string;
  email: string;
  role: InviteRole;
  token: string;
  expiresAt: string;
}

export interface SharingWorkspace {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  role: WorkspaceRole;
  memberCount: number;
  projectCount: number;
  createdBy: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  members: SharingMember[];
  projects: SharingProject[];
  invites: SharingInvite[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  role: WorkspaceRole;
  memberCount: number;
  projectCount: number;
  createdBy: string;
}

export interface UserSearchResult {
  id: string;
  name: string | null;
  email: string;
  isMember: boolean;
  role?: WorkspaceRole;
}

export type InviteResult =
  | { status: 'added'; userId: string; name: string | null; email: string; role: WorkspaceRole }
  | { status: 'already_member'; userId: string; email: string; role: WorkspaceRole }
  | {
      status: 'invited';
      id: string;
      email: string;
      role: WorkspaceRole;
      token: string;
      expiresAt: string;
    };

export interface AcceptInviteResult {
  success: boolean;
  orgId: string;
  role: WorkspaceRole;
}

export interface ProjectContainerUpdate {
  name?: string;
  description?: string | null;
  isArchived?: boolean;
  /** Move the project to this workspace */
  orgId?: string;
}

/* ------------------------------------------------------------------ activity */

export type ActivityAction =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'completed'
  | 'assigned'
  | 'moved'
  | 'deleted'
  | 'restored'
  | 'merged'
  | 'note_added'
  | 'note_deleted'
  | 'renamed'
  | 'archived'
  | 'unarchived'
  | 'invited'
  | 'member_added'
  | 'member_joined'
  | 'member_left'
  | 'member_removed'
  | 'role_changed';

export type ActivityEntityType = 'task' | 'epic' | 'note' | 'project' | 'organisation' | 'member';

export interface ActivityEntry {
  id: string;
  actorId: string | null;
  actorName: string;
  /** Missing on older responses, which represent human actors. */
  actorKind?: PersonKind | null;
  /** Null for historical activity with no known authentication path. */
  via?: 'web' | 'token' | 'owner_secret' | 'system' | null;
  /** Token name only. Render it in accessible detail, never inline. */
  viaDetail?: string | null;
  orgId: string | null;
  projectId: string | null;
  projectName: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  taskId: string | null;
  epicId: string | null;
  /** One of ActivityAction, kept open so new server actions still render */
  action: ActivityAction | (string & {});
  summary: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string | null;
}

export interface ActivityFilters {
  taskId?: string;
  epicId?: string;
  projectId?: string;
  orgId?: string;
  limit?: number;
}

/** One opt-in page from the cursor-backed activity endpoint. */
export interface ActivityPage {
  entries: ActivityEntry[];
  nextCursor?: string;
}
