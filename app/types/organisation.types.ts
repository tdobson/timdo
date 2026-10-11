/**
 * @fileoverview Types for Multi-User Organisations, Members, and Invites.
 * @module app/types/organisation.types
 */

import type { PersonKind } from './collaboration.types';

export type OrganisationRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  /** Everyone has exactly one personal workspace. Show it as "Personal". */
  isPersonal?: boolean;
  role?: OrganisationRole;
  memberCount?: number;
  projectCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface OrganisationMember {
  id: string;
  orgId: string;
  userId: string;
  role: OrganisationRole;
  createdAt?: string | null;
  userName?: string | null;
  /** Omitted for bots so internal email addresses never reach the UI. */
  userEmail?: string;
  /** Missing on old responses, which represent human members. */
  kind?: PersonKind;
}

export interface OrganisationInvite {
  id: string;
  orgId: string;
  email: string;
  role: 'admin' | 'member';
  token: string;
  invitedBy: string;
  expiresAt: string;
  createdAt?: string | null;
}

export interface AutocompleteUserResult {
  id: string;
  name: string | null;
  email: string;
  isMember: boolean;
  role?: OrganisationRole;
}

export interface OrganisationCreateInput {
  name: string;
  slug?: string;
}

export interface InviteMemberInput {
  email: string;
  role?: 'admin' | 'member';
}

export interface ProjectContainer {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description?: string | null;
  leadUserId?: string | null;
  isArchived?: boolean;
  openTasks?: number;
  doneTasks?: number;
  epicCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}
