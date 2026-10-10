'use client';

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import { IconCheck, IconCopy, IconLinkPlus, IconX } from '@tabler/icons-react';
import {
  ActionIcon,
  Anchor,
  Button,
  CopyButton,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  isPendingRef,
  REF_ROLE_ORDER,
  RefApiError,
  sortRefs,
  useAddRef,
  useRemoveRef,
} from '../../app/hooks/useRefQueries';
import type { Project, RefInput, RefRole, RefView } from '../../app/types/project.types';
import { canonicalRef, MAX_LABEL_LENGTH, parseRef, ROLE_LABELS } from '../../workers/src/lib/refs';
import { RefKindIcon, roleLabel } from './refDisplay';
import classes from './TaskRefs.module.css';

/** Groups longer than this show the first few and "and N more". */
const COLLAPSE_AFTER = 3;

// Link first: it is what people add most
const ROLE_OPTIONS = (['link', 'source', 'reported_by', 'about'] as RefRole[]).map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));

export const PEOPLE_BY_ID_HINT =
  'Record people by their id in the other system, not by name or email.';

interface TaskRefsProps {
  task: Project;
  canEdit: boolean;
}

/**
 * The "Links" section of a task: refs to things outside TimDo, grouped by role (Source,
 * About, Reported by, Link), with a quick add form for people who can edit the task.
 */
export function TaskRefs({ task, canEdit }: TaskRefsProps) {
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const refs = sortRefs(task.refs || []);

  // Nothing to see and nothing I can add: stay out of the way
  if (refs.length === 0 && !canEdit) {
    return null;
  }

  const closeForm = () => {
    setAdding(false);
    // Put focus back where the form was opened from
    setTimeout(() => addButtonRef.current?.focus(), 0);
  };

  return (
    <Stack gap={6} data-testid="task-refs">
      {refs.length > 0 && (
        <>
          <Text size="sm" fw={500} id={headingId}>
            Links
          </Text>
          <Stack gap={6} aria-labelledby={headingId} role="group">
            {REF_ROLE_ORDER.map((role) => {
              const inRole = refs.filter((r) => r.role === role);
              return inRole.length > 0 ? (
                <RefGroup key={role} role={role} refs={inRole} taskId={task.id} canEdit={canEdit} />
              ) : null;
            })}
          </Stack>
        </>
      )}

      {canEdit &&
        (adding ? (
          <AddRefForm task={task} refs={refs} onClose={closeForm} />
        ) : (
          <Button
            ref={addButtonRef}
            variant="subtle"
            size="compact-sm"
            color="gray"
            leftSection={<IconLinkPlus size={16} />}
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setAdding(true)}
            data-testid="add-ref-open"
          >
            Add a link
          </Button>
        ))}
    </Stack>
  );
}

function RefGroup({
  role,
  refs,
  taskId,
  canEdit,
}: {
  role: RefRole;
  refs: RefView[];
  taskId: string;
  canEdit: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = refs.length > COLLAPSE_AFTER;
  const shown = collapsible && !expanded ? refs.slice(0, COLLAPSE_AFTER) : refs;
  const label = roleLabel(role);

  return (
    <Group gap="xs" align="flex-start" wrap="nowrap" data-testid={`ref-group-${role}`}>
      <Text size="xs" c="dimmed" className={classes.roleLabel}>
        {label}
      </Text>
      <Group gap={6} wrap="wrap" style={{ flex: 1, minWidth: 0 }} role="list" aria-label={label}>
        {shown.map((ref) => (
          <RefChip key={ref.id} refView={ref} taskId={taskId} canEdit={canEdit} />
        ))}
        {collapsible && (
          <Button
            variant="subtle"
            size="compact-xs"
            color="gray"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show fewer' : `and ${refs.length - COLLAPSE_AFTER} more`}
          </Button>
        )}
      </Group>
    </Group>
  );
}

function RefChip({
  refView: ref,
  taskId,
  canEdit,
}: {
  refView: RefView;
  taskId: string;
  canEdit: boolean;
}) {
  const removeRef = useRemoveRef();
  const pending = isPendingRef(ref);
  const tooltip = ref.createdByName
    ? `${ref.canonical}, added by ${ref.createdByName}`
    : ref.canonical;

  return (
    <Group
      gap={4}
      wrap="nowrap"
      role="listitem"
      className={`${classes.chip} ${pending ? classes.pending : ''}`}
      data-testid="ref-chip"
      aria-busy={pending || undefined}
    >
      <RefKindIcon kind={ref.kind} />
      <Tooltip label={tooltip} withArrow openDelay={400} multiline maw={360}>
        {ref.url ? (
          <Anchor
            href={ref.url}
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            truncate
            maw={280}
            aria-label={`${ref.displayLabel} (opens in a new tab)`}
          >
            {ref.displayLabel}
          </Anchor>
        ) : (
          <Text size="sm" truncate maw={280}>
            {ref.displayLabel}
          </Text>
        )}
      </Tooltip>
      <CopyButton value={ref.canonical} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : `Copy ${ref.canonical}`} withArrow openDelay={300}>
            <ActionIcon
              variant="subtle"
              color={copied ? 'teal' : 'gray'}
              size="sm"
              radius="xl"
              onClick={copy}
              aria-label={`Copy ${ref.canonical}`}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      {canEdit && ref.canDelete && (
        <Tooltip label="Remove" withArrow openDelay={300}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            radius="xl"
            disabled={pending}
            onClick={() => removeRef.mutate({ taskId, refId: ref.id })}
            aria-label={`Remove ${ref.displayLabel} (${roleLabel(ref.role)})`}
            data-testid="ref-remove"
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

/** `X is already the source of 3f2a91c0 "Broken offer page"` -> `Broken offer page` */
function clashTitle(message: string): string | null {
  const m = /is already the source of \S+ "(.*)"$/.exec(message);
  return m ? m[1] : null;
}

function AddRefForm({
  task,
  refs,
  onClose,
}: {
  task: Project;
  refs: RefView[];
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const [role, setRole] = useState<RefRole>('link');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, label });
  latest.current = { value, label };
  const previewId = useId();
  const addRef = useAddRef();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = value.trim() ? parseRef(value) : null;
  const canonical = parsed?.ok ? canonicalRef(parsed.value) : null;
  const duplicate = !!canonical && refs.some((r) => r.role === role && r.canonical === canonical);
  const canAdd = !!parsed?.ok && !duplicate;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) {
      return;
    }
    const input: RefInput = { ref: value.trim(), role };
    if (label.trim()) {
      input.label = label.trim();
    }
    // Clear straight away so the next link can go in; put it back if the API says no
    setValue('');
    setLabel('');
    setError(null);
    if (role === 'source') {
      // A task has one source, so the next paste is most likely a plain link
      setRole('link');
    }
    inputRef.current?.focus();
    addRef.mutate(
      { taskId: task.id, input },
      {
        onError: (err) => {
          setError(err);
          if (!latest.current.value && !latest.current.label) {
            setValue(input.ref);
            setLabel(input.label || '');
            setRole(input.role || 'link');
          }
        },
      }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && !value) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <form onSubmit={handleSubmit} className={classes.addForm} data-testid="add-ref-form">
      <Stack gap={6}>
        <Group gap="xs" align="flex-start" wrap="wrap">
          <TextInput
            ref={inputRef}
            aria-label="Link to add"
            placeholder="Paste a link, or type kind:id"
            value={value}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            error={!!(parsed && !parsed.ok)}
            aria-describedby={previewId}
            style={{ flex: '1 1 240px' }}
            data-testid="add-ref-input"
          />
          <Select
            aria-label="Role"
            data={ROLE_OPTIONS}
            value={role}
            onChange={(v) => v && setRole(v as RefRole)}
            allowDeselect={false}
            w={140}
            data-testid="add-ref-role"
          />
          <TextInput
            aria-label="Label (optional)"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            maxLength={MAX_LABEL_LENGTH}
            w={180}
          />
          <Button type="submit" disabled={!canAdd} data-testid="add-ref-submit">
            Add
          </Button>
          <Button variant="subtle" color="gray" onClick={onClose}>
            Done
          </Button>
        </Group>

        <div id={previewId} aria-live="polite" data-testid="add-ref-preview">
          <RefPreview parsed={parsed} duplicate={duplicate} role={role} error={error} />
        </div>
        {(role === 'reported_by' || role === 'about') && (
          <Text size="xs" c="dimmed">
            {PEOPLE_BY_ID_HINT}
          </Text>
        )}
      </Stack>
    </form>
  );
}

function RefPreview({
  parsed,
  duplicate,
  role,
  error,
}: {
  parsed: ReturnType<typeof parseRef> | null;
  duplicate: boolean;
  role: RefRole;
  error: Error | null;
}) {
  if (error) {
    const otherTaskId = error instanceof RefApiError ? error.taskId : null;
    const title = otherTaskId ? clashTitle(error.message) : null;
    if (otherTaskId && title) {
      return (
        <Text size="xs" c="red" data-testid="add-ref-error">
          Already the source of{' '}
          <Anchor component={Link} href={`/tasks/${otherTaskId}`} size="xs" fw={600}>
            {title}
          </Anchor>
          . Choose Link to add it here as well.
        </Text>
      );
    }
    return (
      <Text size="xs" c="red" data-testid="add-ref-error">
        {error.message}
      </Text>
    );
  }
  if (!parsed) {
    return (
      <Text size="xs" c="dimmed">
        A web address, an email address, or kind:id such as acme.member:123456. Enter adds it.
      </Text>
    );
  }
  if (!parsed.ok) {
    return (
      <Text size="xs" c="red" data-testid="add-ref-error">
        {parsed.error}
      </Text>
    );
  }
  const canonical = canonicalRef(parsed.value);
  return (
    <Group gap={6} wrap="nowrap">
      <RefKindIcon kind={parsed.value.kind} size={14} />
      <Text size="xs" truncate>
        <Text span fw={600} size="xs">
          {parsed.value.label}
        </Text>
        {parsed.value.label !== canonical && (
          <Text span c="dimmed" size="xs">
            {' · '}
            {canonical}
          </Text>
        )}
        {duplicate && (
          <Text span c="dimmed" size="xs">
            {' '}
            (already on this task as {ROLE_LABELS[role]})
          </Text>
        )}
      </Text>
    </Group>
  );
}
