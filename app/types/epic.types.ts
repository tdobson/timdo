/**
 * @fileoverview Canonical Epic data contracts shared across the Next.js frontend.
 * @module app/types/epic.types
 */

import type { PersonKind } from './collaboration.types';
import type { WorkspaceRole } from './project.types';

export type EpicStatus = 'active' | 'completed' | 'on_hold';

export interface Epic {
  id: string;
  userId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  goalId?: string | null;
  status: EpicStatus;
  totalTasks?: number;
  doneTasks?: number;
  progressPercentage?: number;
  /** Project (container) and workspace the epic belongs to. */
  projectId?: string | null;
  projectKey?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  isShared?: boolean;
  myRole?: WorkspaceRole | null;
  /** False for viewers. Treat a missing value as editable (older API responses). */
  canEdit?: boolean;
  createdById?: string | null;
  createdByName?: string | null;
  createdByKind?: PersonKind;
  updatedById?: string | null;
  updatedByName?: string | null;
  updatedByKind?: PersonKind;
  createdAt: string;
  updatedAt: string;
}

export interface EpicCreateInput {
  title: string;
  description?: string | null;
  category?: string | null;
  projectId?: string | null;
  /** Only stored for the epic's creator; never shown to anyone else. */
  goalId?: string | null;
  status?: EpicStatus;
}

export interface EpicUpdateInput {
  title?: string;
  description?: string | null;
  category?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  status?: EpicStatus;
}

export interface CategorySummary {
  category: string;
  totalTasks: number;
  doneTasks: number;
  activeEpicsCount: number;
}
