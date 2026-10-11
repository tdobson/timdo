'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  IconAlertTriangle,
  IconCopy,
  IconFolder,
  IconHierarchy2,
  IconMicrophone,
  IconUser,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  Alert,
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Container,
  Grid,
  Group,
  List,
  Loader,
  Progress,
  Radio,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { RefKindIcon } from '../../../components/TaskDetail/refDisplay';
import {
  clearVoiceReview,
  loadVoiceReview,
  readVoiceReview,
  type VoiceChangeType,
  type VoiceCommandResult,
  type VoiceDraft,
  type VoiceProposal,
  type VoiceReviewLoadResult,
} from '../../../components/VoiceCommand/voiceTypes';
import { ROLE_LABELS } from '../../../workers/src/lib/refs';
import {
  captureTaskCacheScope,
  invalidateBoardCaches,
  isTaskCacheScopeCurrent,
  type TaskCacheScope,
} from '../../lib/taskCache';
import type { Project, RefRole } from '../../types/project.types';
import {
  applyAsNote,
  applyVoiceChange,
  newApplySession,
  noteTextFor,
  refChangesOf,
  similarOf,
  VoiceApplyError,
  type VoiceProposalWithRefs,
  type VoiceSimilarTask,
} from './applyVoiceChange';

const ACTION: Record<VoiceChangeType, { label: string; color: string }> = {
  create: { label: 'New task', color: 'green' },
  update: { label: 'Update task', color: 'blue' },
  delete: { label: 'Delete task', color: 'red' },
  claim: { label: 'Claim task', color: 'violet' },
  createEpic: { label: 'New epic', color: 'teal' },
  createProject: { label: 'New project', color: 'grape' },
};

const STATUS_LABEL: Record<string, string> = {
  do: 'Do',
  delay: 'Delay',
  done: 'Done',
  delegate: 'Delegate',
  awaiting: 'Awaiting',
};

function TaskSummary({
  task,
  assigneeName,
  muted,
}: {
  task: Partial<Project> | VoiceDraft;
  assigneeName?: string | null;
  muted?: boolean;
}) {
  const status = task.status ? STATUS_LABEL[task.status] || task.status : null;
  return (
    <Stack gap={6} opacity={muted ? 0.6 : 1}>
      <Text size="sm" fw={700} td={muted ? 'line-through' : undefined}>
        {task.project}
      </Text>
      {task.reason && (
        <Text size="xs" c="dimmed">
          {task.reason}
        </Text>
      )}
      <Group gap="xs">
        {status && (
          <Badge size="sm" variant="light" color="gray">
            {status}
            {task.status === 'awaiting' && task.awaitUntil ? ` until ${task.awaitUntil}` : ''}
          </Badge>
        )}
        {task.priority !== undefined && (
          <Badge size="sm" variant="light" color="gray">
            P{task.priority}
          </Badge>
        )}
        {task.size && (
          <Badge size="sm" variant="light" color="gray">
            {task.size}
          </Badge>
        )}
      </Group>
      {assigneeName !== undefined && (
        <Text size="xs" c="dimmed">
          {assigneeName ? `Assigned to ${assigneeName}` : 'Unassigned'}
        </Text>
      )}
      {task.notes && (
        <Text size="xs" c="dimmed" lineClamp={4}>
          {task.notes}
        </Text>
      )}
    </Stack>
  );
}

/** "Assign to Robin Fairweather", "Assign to you", "Stays with Robin Fairweather" */
function assigneeLine(change: VoiceProposal, meId?: string | null): string | null {
  if (change.type === 'createEpic' || change.type === 'createProject') {
    return null;
  }
  if (change.type === 'delete') {
    return change.before?.assigneeName ? `Assigned to ${change.before.assigneeName}` : null;
  }
  const isMe = !!meId && change.assigneeId === meId;
  const name = isMe ? 'you' : change.assigneeName;
  if (change.type === 'create' || change.type === 'claim') {
    if (change.assigneeId === null) {
      return 'Leave unassigned';
    }
    if (change.assigneeId === undefined && !change.assigneeName) {
      return 'Assign to you';
    }
    return `Assign to ${name ?? 'you'}`;
  }
  if (change.assigneeChanged) {
    if (change.assigneeId === null) {
      return 'Unassign';
    }
    const from = change.before?.assigneeName;
    return `Reassign to ${name}${from ? ` (from ${from})` : ''}`;
  }
  return change.assigneeName ? `Stays with ${change.assigneeName}` : 'Unassigned';
}

/** A visible short ID keeps duplicate candidates distinguishable even if their titles match. */
const titleWithProject = (task: VoiceSimilarTask) =>
  `#${task.shortId ?? task.id.slice(0, 8)} ${task.title}${task.projectName ? ` (${task.projectName})` : ''}`;

function ChangeContext({
  change,
  meId,
  noteOn,
}: {
  change: VoiceProposal;
  meId?: string | null;
  /** Set when this new task is being added as a note to an existing one instead */
  noteOn?: VoiceSimilarTask | null;
}) {
  if (noteOn) {
    const where = [noteOn.orgName, noteOn.projectName].filter(Boolean).join(' / ');
    return (
      <Group gap="sm" wrap="wrap">
        <Badge color="cyan" variant="filled" size="lg">
          Add a note
        </Badge>
        {where && (
          <Group gap={4} wrap="nowrap">
            <IconFolder size={16} stroke={1.5} />
            <Text size="sm">{where}</Text>
          </Group>
        )}
      </Group>
    );
  }
  const action = ACTION[change.type] ?? { label: change.type, color: 'gray' };
  const where =
    change.type === 'createProject'
      ? change.orgName
      : [change.orgName, change.projectName].filter(Boolean).join(' / ');
  const assignee = assigneeLine(change, meId);
  const highlightAssignee =
    change.type === 'claim' || change.assigneeChanged || change.type === 'create';
  const movedFrom =
    change.type === 'update' &&
    change.before?.projectName &&
    change.projectName &&
    change.before.projectName !== change.projectName
      ? change.before.projectName
      : null;

  return (
    <Group gap="sm" wrap="wrap">
      <Badge color={action.color} variant="filled" size="lg">
        {action.label}
      </Badge>
      {where && (
        <Group gap={4} wrap="nowrap">
          <IconFolder size={16} stroke={1.5} />
          <Text size="sm">
            {movedFrom ? `Move from ${movedFrom} to ` : ''}
            {where}
          </Text>
          {change.isNewProject && change.type !== 'createProject' && (
            <Badge size="xs" variant="outline" color="grape">
              new project
            </Badge>
          )}
        </Group>
      )}
      {assignee && (
        <Group gap={4} wrap="nowrap">
          {change.assigneeName && change.assigneeId !== null ? (
            <Avatar size={20} radius="xl" color="blue">
              {change.assigneeName.slice(0, 2).toUpperCase()}
            </Avatar>
          ) : (
            <IconUser size={16} stroke={1.5} />
          )}
          <Text size="sm" fw={highlightAssignee ? 600 : 400}>
            {assignee}
          </Text>
        </Group>
      )}
      {change.epicTitle && (change.type === 'create' || change.type === 'update') && (
        <Group gap={4} wrap="nowrap">
          <IconHierarchy2 size={16} stroke={1.5} />
          <Text size="sm">Epic: {change.epicTitle}</Text>
        </Group>
      )}
    </Group>
  );
}

function ChangeBody({
  change,
  noteOn,
}: {
  change: VoiceProposal;
  noteOn?: VoiceSimilarTask | null;
}) {
  if (noteOn) {
    return (
      <Card withBorder p="md" data-testid="voice-note-preview">
        <Stack gap={6}>
          <Text size="sm" fw={700}>
            Note on &ldquo;{noteOn.title}&rdquo;
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {noteTextFor(change)}
          </Text>
          <Text size="xs" c="dimmed">
            No new task is made. The note is signed with your name.
          </Text>
        </Stack>
      </Card>
    );
  }

  if (change.type === 'createProject' || change.type === 'createEpic') {
    return (
      <Card withBorder p="md">
        <Stack gap={4}>
          <Text size="sm" fw={700}>
            {change.after?.project}
          </Text>
          {(change.after?.notes || change.after?.reason) && (
            <Text size="xs" c="dimmed">
              {change.after?.notes || change.after?.reason}
            </Text>
          )}
        </Stack>
      </Card>
    );
  }

  if (change.type === 'create' && change.after) {
    return (
      <Card withBorder p="md">
        <TaskSummary task={change.after} />
      </Card>
    );
  }

  if ((change.type === 'delete' || change.type === 'claim') && change.before) {
    return (
      <Card withBorder p="md">
        <TaskSummary
          task={change.before}
          assigneeName={change.before.assigneeName ?? null}
          muted={change.type === 'delete'}
        />
      </Card>
    );
  }

  return (
    <Grid>
      <Grid.Col span={{ base: 12, md: 6 }}>
        <Stack gap="xs">
          <Text fw={600} size="sm" c="dimmed">
            Now
          </Text>
          <Card withBorder p="md">
            {change.before ? (
              <TaskSummary task={change.before} assigneeName={change.before.assigneeName ?? null} />
            ) : (
              <Text c="dimmed" size="sm">
                Not found
              </Text>
            )}
          </Card>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 6 }}>
        <Stack gap="xs">
          <Text fw={600} size="sm" c="dimmed">
            After
          </Text>
          <Card withBorder p="md">
            {change.after ? (
              <TaskSummary task={change.after} assigneeName={change.assigneeName ?? null} />
            ) : (
              <Text c="dimmed" size="sm">
                No details
              </Text>
            )}
          </Card>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/**
 * "Looks like an existing task: Broken offer page (Acme Solar)", with a switch (off by default) to
 * add this as a note there instead. With several matches, the switch lets you pick which one.
 */
function DuplicateHint({
  change,
  noteOn,
  onChange,
  disabled,
}: {
  change: VoiceProposal;
  noteOn: string | null;
  onChange: (taskId: string | null) => void;
  disabled?: boolean;
}) {
  const similar = similarOf(change);
  if (similar.length === 0) {
    return null;
  }
  const [best, ...others] = similar;
  const editableSimilar = similar.filter((task) => task.canEdit !== false);
  const defaultNoteTask = editableSimilar[0] ?? null;
  const open = (task: VoiceSimilarTask) => {
    const shortId = task.shortId ?? task.id.slice(0, 8);
    return (
      // A new tab, so this review keeps its place
      <Anchor
        href={`/tasks/${task.id}`}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
        fw={600}
        aria-label={`Open ${titleWithProject(task)}`}
      >
        #{shortId} {task.title}
      </Anchor>
    );
  };
  return (
    <Alert
      color="blue"
      variant="light"
      icon={<IconCopy size={18} />}
      p="xs"
      data-testid="voice-duplicate-hint"
    >
      <Stack gap="xs">
        <Stack gap={2}>
          <Text size="sm">
            Looks like an existing task: {open(best)}
            {best.projectName ? ` (${best.projectName})` : ''}
          </Text>
          {best.assigneeName && (
            <Text size="xs" c="dimmed">
              Assigned to {best.assigneeName}
            </Text>
          )}
          {others.length > 0 && (
            <Text size="xs" c="dimmed">
              Also similar:{' '}
              {others.map((task, i) => (
                <span key={task.id}>
                  {i > 0 ? ', ' : ''}
                  {open(task)}
                  {task.projectName ? ` (${task.projectName})` : ''}
                  {task.canEdit === false ? ' (view only)' : ''}
                </span>
              ))}
            </Text>
          )}
          {best.canEdit === false && editableSimilar.length > 0 && (
            <Text size="xs" c="dimmed">
              The closest match is view only. You can add a note to an editable match instead.
            </Text>
          )}
          {editableSimilar.length === 0 && (
            <Text size="xs" c="dimmed">
              You can view this task, but you cannot add a note here.
            </Text>
          )}
        </Stack>
        <Switch
          label="Add as a note there instead"
          checked={noteOn !== null}
          onChange={(event) =>
            onChange(event.currentTarget.checked ? (defaultNoteTask?.id ?? null) : null)
          }
          disabled={disabled || editableSimilar.length === 0}
        />
        {noteOn !== null &&
          editableSimilar.length > 0 &&
          (editableSimilar.length > 1 || best.canEdit === false) && (
            <Radio.Group
              label="Add the note to"
              size="sm"
              value={noteOn}
              onChange={(value) => onChange(value)}
            >
              <Stack gap={4} mt={4}>
                {editableSimilar.map((task) => (
                  <Radio
                    key={task.id}
                    value={task.id}
                    label={titleWithProject(task)}
                    disabled={disabled}
                  />
                ))}
              </Stack>
            </Radio.Group>
          )}
      </Stack>
    </Alert>
  );
}

/** What a removed link was to the task, as the activity log words it */
const REMOVED_ROLE: Record<RefRole, string> = {
  link: 'link',
  source: 'source',
  reported_by: 'reporter',
  about: 'about',
};

const refKey = (sign: '+' | '-', ref: string, role: RefRole | null) =>
  `${sign}${role ?? ''} ${ref}`;

function RefLine({
  sign,
  text,
  canonical,
  url,
  label,
  checked,
  onToggle,
  disabled,
}: {
  sign: '+' | '-';
  text: string;
  canonical: string;
  url?: string | null;
  label?: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const kind = canonical.slice(0, Math.max(0, canonical.indexOf(':')));
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Checkbox
        size="xs"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        // A fixed name: the checked state already says whether the change is included
        aria-label={`Include: ${text} ${canonical}`}
      />
      <Text size="sm" c={sign === '+' ? 'green' : 'red'} fw={700} w={12} ta="center">
        {sign}
      </Text>
      <RefKindIcon kind={kind} />
      <Text size="sm" td={checked ? undefined : 'line-through'} c={checked ? undefined : 'dimmed'}>
        {text}{' '}
        {url ? (
          <Anchor href={url} target="_blank" rel="noopener noreferrer" size="sm">
            {canonical}
          </Anchor>
        ) : (
          canonical
        )}
        {label && label !== canonical && (
          <Text span size="xs" c="dimmed">
            {' '}
            ({label})
          </Text>
        )}
      </Text>
    </Group>
  );
}

/** "+ Link github.issue:acme/widgets#12", "- Remove reporter acme.member:123456" */
function RefChanges({
  change,
  leftOut,
  onToggle,
  disabled,
  noteOn,
}: {
  change: VoiceProposal;
  leftOut: Set<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
  noteOn?: VoiceSimilarTask | null;
}) {
  const { add, remove } = refChangesOf(change);
  if (add.length === 0 && remove.length === 0) {
    return null;
  }
  return (
    <Stack gap={4} data-testid="voice-ref-changes">
      <Text fw={600} size="sm" c="dimmed">
        Links
      </Text>
      {remove.map((r) => {
        const key = refKey('-', r.ref, r.role);
        return (
          <RefLine
            key={key}
            sign="-"
            text={`Remove${r.role ? ` ${REMOVED_ROLE[r.role]}` : ''}`}
            canonical={r.ref}
            checked={!leftOut.has(key)}
            onToggle={() => onToggle(key)}
            disabled={disabled}
          />
        );
      })}
      {add.map((r) => {
        const key = refKey('+', r.ref, r.role);
        return (
          <RefLine
            key={key}
            sign="+"
            text={ROLE_LABELS[r.role] ?? r.role}
            canonical={r.ref}
            url={r.url}
            label={r.label}
            checked={!leftOut.has(key)}
            onToggle={() => onToggle(key)}
            disabled={disabled}
          />
        );
      })}
      <Text size="xs" c="dimmed">
        Untick any link you don&apos;t want.{' '}
        {noteOn
          ? `Links are added to "${noteOn.title}" after the note.`
          : change.type === 'create'
            ? 'Selected links are saved with the new task.'
            : 'Links are saved after the task change.'}
      </Text>
    </Stack>
  );
}

/** The change without the links the user unticked. */
function withoutLeftOut(change: VoiceProposal, leftOut: Set<string>): VoiceProposal {
  if (leftOut.size === 0) {
    return change;
  }
  const { add, remove } = refChangesOf(change);
  const trimmed: VoiceProposalWithRefs = {
    ...change,
    refs: add.filter((r) => !leftOut.has(refKey('+', r.ref, r.role))),
    removeRefs: remove.filter((r) => !leftOut.has(refKey('-', r.ref, r.role))),
  };
  return trimmed;
}

/** Read account-bound review links; legacy unowned change lists are intentionally rejected. */
function readFromUrl(
  reviewParam: string | null,
  legacyChangesParam: string | null,
  accountId: string
): VoiceReviewLoadResult {
  if (reviewParam) {
    try {
      return readVoiceReview(JSON.parse(reviewParam) as unknown, accountId);
    } catch {
      return { status: 'unowned' };
    }
  }
  return legacyChangesParam ? { status: 'unowned' } : { status: 'missing' };
}

interface ReviewOwner {
  accountId: string;
  reviewId: string;
  scope: TaskCacheScope;
}

interface LoadedReview {
  result: VoiceCommandResult;
  owner: ReviewOwner;
}

type ReviewLoadIssue = 'unowned' | 'different-account' | 'not-authenticated';

function ReviewChangesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session, status: sessionStatus } = useSession();
  const accountId = session?.user?.id || session?.user?.email || null;
  const authRef = useRef({
    accountId,
    status: sessionStatus,
    accessToken: session?.accessToken ?? null,
  });
  authRef.current = {
    accountId,
    status: sessionStatus,
    accessToken: session?.accessToken ?? null,
  };

  const [loadedReview, setLoadedReview] = useState<LoadedReview | null>(null);
  const [loadIssue, setLoadIssue] = useState<ReviewLoadIssue | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastErrorTask, setLastErrorTask] = useState<VoiceSimilarTask | null>(null);
  // Links the user unticked on the current change
  const [leftOut, setLeftOut] = useState<Set<string>>(() => new Set());
  // The existing task to add the current new task to as a note, when the switch is on
  const [noteOnId, setNoteOnId] = useState<string | null>(null);
  const counts = useRef({ applied: 0, skipped: 0 });
  const applySession = useRef(newApplySession());
  const finished = useRef(false);
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (sessionStatus === 'loading') {
      return;
    }
    if (
      sessionStatus !== 'authenticated' ||
      !accountId ||
      authRef.current.status !== 'authenticated' ||
      authRef.current.accountId !== accountId
    ) {
      setLoadIssue('not-authenticated');
      return;
    }
    if (loadedOnce.current) {
      return;
    }
    loadedOnce.current = true;

    const fromUrl = readFromUrl(searchParams.get('review'), searchParams.get('changes'), accountId);
    const fromStorage = loadVoiceReview(accountId);
    const loaded =
      fromUrl.status === 'loaded'
        ? fromUrl
        : fromStorage.status === 'loaded'
          ? fromStorage
          : fromUrl.status !== 'missing'
            ? fromUrl
            : fromStorage;

    if (loaded.status === 'loaded' && loaded.review.result.proposedChanges.length > 0) {
      const owner: ReviewOwner = {
        accountId: loaded.review.accountId,
        reviewId: loaded.review.reviewId,
        scope: captureTaskCacheScope(queryClient, accountId),
      };
      setLoadedReview({ result: loaded.review.result, owner });
      setLoadIssue(null);
      return;
    }

    if (loaded.status !== 'loaded' && loaded.status !== 'missing') {
      setLoadIssue(loaded.status);
      return;
    }
    notifications.show({
      title: 'Nothing to review',
      message: 'Record a voice command to suggest some changes.',
      color: 'yellow',
    });
    router.push('/board');
  }, [accountId, queryClient, router, searchParams, sessionStatus]);

  const isReviewOwnerCurrent = (owner: ReviewOwner) =>
    authRef.current.status === 'authenticated' &&
    authRef.current.accountId === owner.accountId &&
    isTaskCacheScopeCurrent(queryClient, owner.scope);

  const result = loadedReview?.result ?? null;
  const changes = result?.proposedChanges ?? [];
  const currentChange = changes[currentIndex];
  const isLastChange = currentIndex === changes.length - 1;
  const progressPercent = changes.length ? ((currentIndex + 1) / changes.length) * 100 : 0;
  const meId = result?.me?.id ?? null;
  const noteOn = currentChange
    ? (similarOf(currentChange).find((task) => task.id === noteOnId) ?? null)
    : null;
  const reviewIsCurrent = !!loadedReview && isReviewOwnerCurrent(loadedReview.owner);

  // Warnings that belong to no card: changes that were left out
  const generalWarnings = useMemo(() => {
    const onCards = new Set(changes.flatMap((c) => c.warnings ?? []));
    return (result?.warnings ?? []).filter((w) => !onCards.has(w));
  }, [result, changes]);

  const finish = (owner: ReviewOwner) => {
    if (!isReviewOwnerCurrent(owner) || finished.current) {
      return;
    }
    finished.current = true;
    clearVoiceReview({ accountId: owner.accountId, reviewId: owner.reviewId });
    const { applied, skipped } = counts.current;
    notifications.show({
      title: 'Review complete',
      message: `Applied ${applied} ${applied === 1 ? 'change' : 'changes'}, skipped ${skipped}.`,
      color: applied > 0 ? 'green' : 'gray',
    });
    router.push('/board');
  };

  const toggleRef = (key: string) =>
    setLeftOut((current) => {
      const updated = new Set(current);
      if (updated.has(key)) {
        updated.delete(key);
      } else {
        updated.add(key);
      }
      return updated;
    });

  const next = (owner: ReviewOwner) => {
    if (!isReviewOwnerCurrent(owner)) {
      return;
    }
    setLastError(null);
    setLastErrorTask(null);
    setLeftOut(new Set());
    setNoteOnId(null);
    if (isLastChange) {
      finish(owner);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleApply = async () => {
    const owner = loadedReview?.owner;
    if (!currentChange || !owner || !isReviewOwnerCurrent(owner)) {
      return;
    }
    const accessToken = authRef.current.accessToken;
    if (!accessToken) {
      notifications.show({
        title: 'Not signed in',
        message: 'Sign in and try again.',
        color: 'red',
      });
      return;
    }

    setIsProcessing(true);
    setLastError(null);
    setLastErrorTask(null);
    try {
      const change = withoutLeftOut(currentChange, leftOut);
      const outcome = noteOn
        ? await applyAsNote(change, noteOn, accessToken)
        : await applyVoiceChange(change, accessToken, applySession.current, meId);
      if (!isReviewOwnerCurrent(owner)) {
        return;
      }

      counts.current.applied += 1;
      notifications.show({ message: outcome.message, color: 'green' });
      if (outcome.problems.length > 0) {
        // The task change stands; only these links need doing by hand
        notifications.show({
          title:
            outcome.problems.length === 1
              ? "One link wasn't changed"
              : `${outcome.problems.length} links weren't changed`,
          message: outcome.problems.join(' '),
          color: 'yellow',
          autoClose: false,
        });
      }

      const taskId = noteOn?.id || currentChange.taskId || currentChange.before?.id;
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['task-search'] }),
        queryClient.invalidateQueries({ queryKey: ['task-similar'] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
        queryClient.invalidateQueries({ queryKey: ['epics'] }),
        queryClient.invalidateQueries({ queryKey: ['organisations'] }),
        ...(taskId
          ? [queryClient.invalidateQueries({ queryKey: ['project-updates', taskId] })]
          : []),
        invalidateBoardCaches(queryClient, owner.scope, taskId),
      ];
      await Promise.all(invalidations);
      if (!isReviewOwnerCurrent(owner)) {
        return;
      }
      next(owner);
    } catch (error) {
      if (!isReviewOwnerCurrent(owner)) {
        return;
      }
      const message = error instanceof Error ? error.message : "Couldn't apply this change.";
      const status = error instanceof VoiceApplyError ? error.status : 0;
      setLastError(message);
      setLastErrorTask(error instanceof VoiceApplyError ? error.existingTask : null);
      notifications.show({
        title:
          status === 409
            ? 'Source already in use'
            : status === 403
              ? 'Not allowed'
              : status === 404
                ? 'Not found'
                : "Couldn't apply this change",
        message,
        color: 'red',
      });
    } finally {
      if (isReviewOwnerCurrent(owner)) {
        setIsProcessing(false);
      }
    }
  };

  const handleSkip = () => {
    const owner = loadedReview?.owner;
    if (!owner || !isReviewOwnerCurrent(owner)) {
      return;
    }
    counts.current.skipped += 1;
    next(owner);
  };

  if (sessionStatus === 'loading') {
    return (
      <Container py="xl">
        <Loader />
      </Container>
    );
  }

  if (!loadedReview || !reviewIsCurrent) {
    const message = !loadedReview
      ? loadIssue === 'unowned'
        ? 'This older voice review cannot be tied to this account. Record a new voice command.'
        : loadIssue === 'different-account'
          ? 'This voice review belongs to a different account. Record a new voice command.'
          : 'Sign in before opening a voice review.'
      : 'This review belongs to an earlier sign-in session. Record a new voice command.';
    return (
      <Container size="lg" py="xl">
        <Stack gap="md">
          <Alert color="yellow" title="Review unavailable">
            {message}
          </Alert>
          <Button variant="subtle" color="gray" onClick={() => router.push('/board')}>
            Back to board
          </Button>
        </Stack>
      </Container>
    );
  }

  if (!currentChange) {
    return (
      <Container py="xl">
        <Loader />
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Stack gap="lg">
        <Box>
          <Title order={2}>Review voice changes</Title>
          <Text c="dimmed" size="sm">
            Change {currentIndex + 1} of {changes.length}
          </Text>
        </Box>

        <Progress value={progressPercent} size="sm" />

        {(result?.transcript || result?.summary) && (
          <Card withBorder p="sm" bg="var(--mantine-color-default-hover)">
            <Stack gap={4}>
              {result?.transcript && (
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <IconMicrophone size={16} stroke={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
                  <Text size="sm" fs="italic">
                    &ldquo;{result.transcript.trim()}&rdquo;
                  </Text>
                </Group>
              )}
              {result?.summary && (
                <Text size="sm" c="dimmed">
                  {result.summary}
                </Text>
              )}
              {result?.answer && <Text size="sm">{result.answer}</Text>}
            </Stack>
          </Card>
        )}

        {generalWarnings.length > 0 && (
          <Alert
            color="yellow"
            variant="light"
            icon={<IconAlertTriangle size={18} />}
            title={
              generalWarnings.length === 1 ? 'One thing was left out' : 'Some things were left out'
            }
          >
            <List size="sm" spacing={2}>
              {generalWarnings.map((w) => (
                <List.Item key={w}>{w}</List.Item>
              ))}
            </List>
          </Alert>
        )}

        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <ChangeContext change={currentChange} meId={meId} noteOn={noteOn} />

            {(currentChange.warnings?.length ?? 0) > 0 && (
              <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
                <Stack gap={2}>
                  {currentChange.warnings!.map((w) => (
                    <Text key={w} size="sm">
                      {w}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}

            <DuplicateHint
              change={currentChange}
              noteOn={noteOn?.id ?? null}
              onChange={setNoteOnId}
              disabled={isProcessing}
            />

            <ChangeBody change={currentChange} noteOn={noteOn} />

            <RefChanges
              change={currentChange}
              leftOut={leftOut}
              onToggle={toggleRef}
              disabled={isProcessing}
              noteOn={noteOn}
            />

            {lastError &&
              (lastErrorTask ? (
                <Alert color="red" variant="light" title="No new task was created.">
                  <Stack gap="xs">
                    <Text size="sm">{lastError}</Text>
                    <Text size="sm">
                      Existing task:{' '}
                      <Anchor
                        href={`/tasks/${lastErrorTask.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${titleWithProject(lastErrorTask)}`}
                      >
                        #{lastErrorTask.shortId ?? lastErrorTask.id.slice(0, 8)}{' '}
                        {lastErrorTask.title}
                      </Anchor>
                      {lastErrorTask.projectName ? ` (${lastErrorTask.projectName})` : ''}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Untick the source link and try again, or open the existing task.
                    </Text>
                  </Stack>
                </Alert>
              ) : (
                <Text size="sm" c="red">
                  {lastError}
                </Text>
              ))}
          </Stack>
        </Card>

        <Group justify="space-between">
          <Button variant="subtle" color="gray" onClick={handleSkip} disabled={isProcessing}>
            Skip
          </Button>
          <Button
            onClick={handleApply}
            loading={isProcessing}
            color={currentChange.type === 'delete' ? 'red' : undefined}
          >
            {isLastChange ? 'Apply and finish' : 'Apply and next'}
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}

export default function ReviewChangesPage() {
  return (
    <Suspense
      fallback={
        <Container py="xl">
          <Loader />
        </Container>
      }
    >
      <ReviewChangesContent />
    </Suspense>
  );
}
