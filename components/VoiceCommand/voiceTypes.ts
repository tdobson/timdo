/**
 * What POST /api/v2/ai/voice-command returns, and how the result is handed to the review
 * screen. The server resolves names to ids (workspace, project, assignee, epic) and adds
 * the labels shown on each card.
 */
import type { Project, ProjectSize, ProjectStatus, RefRole } from '../../app/types/project.types';

export type VoiceChangeType =
  | 'create'
  | 'update'
  | 'delete'
  | 'createEpic'
  | 'createProject'
  | 'claim';

/** A link the change adds: canonical `kind:ref` plus what the server worked out about it. */
export interface VoiceRefAdd {
  ref: string;
  role: RefRole;
  kind?: string;
  url?: string | null;
  label?: string;
}

/** A link the change takes off; role null means every role it has on the task. */
export interface VoiceRefRemove {
  ref: string;
  role: RefRole | null;
}

/** An open task a proposed new task looks like, from the server's similar-task check. */
export interface VoiceSimilarTask {
  id: string;
  shortId?: string;
  title: string;
  status?: string;
  projectId?: string;
  projectName?: string | null;
  orgId?: string;
  orgName?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  score?: number;
  /** Whether the caller can add a note or otherwise edit the task. */
  canEdit?: boolean;
}

/** The proposed task, epic or project, as the model described it. */
export interface VoiceDraft {
  id?: string;
  project: string;
  reason?: string | null;
  status?: ProjectStatus;
  priority?: number;
  size?: ProjectSize;
  notes?: string | null;
  awaitUntil?: string | null;
  category?: string | null;
  customer?: string | null;
  tags?: string | null;
  assignee?: string | null;
  assigneeName?: string | null;
  epicTitle?: string | null;
  goalTitle?: string | null;
  workspace?: string | null;
}

export interface VoiceProposal {
  type: VoiceChangeType;
  /** The task as it is now (update, delete, claim) */
  before: Project | null;
  after: VoiceDraft | null;
  /** Existing task id (update, delete, claim) */
  taskId?: string | null;
  /** The project the change lands in. null when applying creates it. */
  projectId?: string | null;
  projectName?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  isNewProject?: boolean;
  /** undefined = leave as is (new tasks then go to their creator), null = unassigned */
  assigneeId?: string | null;
  assigneeName?: string | null;
  assigneeChanged?: boolean;
  epicId?: string | null;
  epicTitle?: string | null;
  goalId?: string | null;
  /** Links to add (create and update) and take off (update only) */
  refs?: VoiceRefAdd[];
  removeRefs?: VoiceRefRemove[];
  /** Likely duplicate tasks found for a new task proposal. */
  similar?: VoiceSimilarTask[];
  warnings?: string[];
}

export interface VoiceCommandResult {
  transcript: string;
  summary: string;
  /** Set when the user asked a question, e.g. "What's Robin working on?" */
  answer?: string | null;
  warnings?: string[];
  me?: { id: string; name: string } | null;
  proposedChanges: VoiceProposal[];
}

const STORAGE_KEY = 'timdo:voice-review';
const REVIEW_VERSION = 1;

export interface VoiceReviewEnvelope {
  version: typeof REVIEW_VERSION;
  reviewId: string;
  accountId: string;
  result: VoiceCommandResult;
}

export type VoiceReviewLoadResult =
  | { status: 'loaded'; review: VoiceReviewEnvelope }
  | { status: 'missing' | 'unowned' | 'different-account' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isVoiceReviewEnvelope(value: unknown): value is VoiceReviewEnvelope {
  if (!isRecord(value) || !isRecord(value.result)) {
    return false;
  }
  return (
    value.version === REVIEW_VERSION &&
    typeof value.reviewId === 'string' &&
    value.reviewId.length > 0 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    Array.isArray(value.result.proposedChanges)
  );
}

function createReviewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Classify stored or URL review data without assigning legacy/unowned data to the current user. */
export function readVoiceReview(value: unknown, accountId: string): VoiceReviewLoadResult {
  if (!isVoiceReviewEnvelope(value)) {
    return { status: 'unowned' };
  }
  if (value.accountId !== accountId) {
    return { status: 'different-account' };
  }
  return { status: 'loaded', review: value };
}

/** Bind a generated review to its account before storing it in this tab. */
export function createVoiceReview(
  result: VoiceCommandResult,
  accountId: string
): VoiceReviewEnvelope | null {
  if (!accountId) {
    return null;
  }
  return {
    version: REVIEW_VERSION,
    reviewId: createReviewId(),
    accountId,
    result,
  };
}

/** Store a review in session storage; session storage keeps long change lists out of the URL. */
export function saveVoiceReview(review: VoiceReviewEnvelope): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(review));
    return true;
  } catch {
    return false;
  }
}

export function loadVoiceReview(accountId: string): VoiceReviewLoadResult {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? readVoiceReview(JSON.parse(raw) as unknown, accountId) : { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
}

/** Clear only the review this flow owns; a later review in the same tab is left intact. */
export function clearVoiceReview(expected: { accountId: string; reviewId: string }): boolean {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isVoiceReviewEnvelope(value) ||
      value.accountId !== expected.accountId ||
      value.reviewId !== expected.reviewId
    ) {
      return false;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
