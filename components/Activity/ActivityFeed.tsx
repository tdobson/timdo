'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import {
  IconArchive,
  IconArchiveOff,
  IconArrowBackUp,
  IconArrowRight,
  IconCheck,
  IconGitMerge,
  IconHistory,
  IconKey,
  IconMailForward,
  IconMessage,
  IconMessageOff,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconShield,
  IconTrash,
  IconUserCheck,
  IconUserMinus,
  IconUserPlus,
  type Icon,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useActivity } from '../../app/hooks/useActivityQueries';
import { organisationKeys } from '../../app/hooks/useOrganisationQueries';
import { useMe } from '../../app/hooks/useSharingQueries';
import { fetchWorkspaces } from '../../app/lib/collaborationApi';
import type { ActivityEntry } from '../../app/types/collaboration.types';
import { BotMarker } from '../Team/BotMarker';
import {
  absoluteTime,
  continueSentence,
  dayLabel,
  parseTimestamp,
  relativeTime,
  splitQuoted,
} from './activityFormat';
import { PersonAvatar } from './PersonAvatar';

export interface ActivityFeedProps {
  taskId?: string;
  epicId?: string;
  projectId?: string;
  orgId?: string;
  /** How many entries to fetch (default 10 compact, 50 full) */
  limit?: number;
  /** Tighter layout for task and epic detail panels */
  compact?: boolean;
  /** Optional heading above the feed */
  title?: string;
}

export const SYSTEM_ACTOR_NAME = 'TimDo';

const ACTION_ICONS: Record<string, { icon: Icon; color: string }> = {
  created: { icon: IconPlus, color: 'green' },
  updated: { icon: IconPencil, color: 'gray' },
  status_changed: { icon: IconArrowRight, color: 'blue' },
  completed: { icon: IconCheck, color: 'teal' },
  assigned: { icon: IconUserCheck, color: 'violet' },
  moved: { icon: IconArrowRight, color: 'blue' },
  deleted: { icon: IconTrash, color: 'red' },
  restored: { icon: IconArrowBackUp, color: 'green' },
  merged: { icon: IconGitMerge, color: 'grape' },
  note_added: { icon: IconMessage, color: 'cyan' },
  note_deleted: { icon: IconMessageOff, color: 'gray' },
  renamed: { icon: IconPencil, color: 'gray' },
  archived: { icon: IconArchive, color: 'gray' },
  unarchived: { icon: IconArchiveOff, color: 'gray' },
  invited: { icon: IconMailForward, color: 'orange' },
  member_added: { icon: IconUserPlus, color: 'green' },
  member_joined: { icon: IconUserPlus, color: 'green' },
  member_left: { icon: IconUserMinus, color: 'orange' },
  member_removed: { icon: IconUserMinus, color: 'red' },
  role_changed: { icon: IconShield, color: 'indigo' },
};

/** Workspace names, so member and workspace events can say where they happened. */
function useWorkspaceNames(enabled: boolean) {
  const { data: session } = useSession();
  const token = session?.accessToken;
  const accountId = session?.user?.id || session?.user?.email || null;
  const { data } = useQuery({
    queryKey: organisationKeys.lists(accountId),
    queryFn: ({ signal }) => fetchWorkspaces(token, signal),
    enabled: enabled && !!token && !!accountId,
    staleTime: 5 * 60 * 1000,
  });
  return useMemo(
    () => new Map((Array.isArray(data) ? data : []).map((w) => [w.id, w.name])),
    [data]
  );
}

function linkFor(
  entry: ActivityEntry,
  filters: { taskId?: string; epicId?: string }
): string | null {
  if (entry.action === 'deleted') {
    return null;
  }
  if (entry.taskId) {
    return entry.taskId === filters.taskId ? null : `/tasks/${entry.taskId}`;
  }
  if (entry.epicId) {
    return entry.epicId === filters.epicId ? null : `/epics/${entry.epicId}`;
  }
  return null;
}

interface ItemProps {
  entry: ActivityEntry;
  meId?: string;
  compact: boolean;
  href: string | null;
  contextLabel: string | null;
  now: Date;
}

function ActivityItem({ entry, meId, compact, href, contextLabel, now }: ItemProps) {
  const isSystem = !entry.actorId || entry.actorName === SYSTEM_ACTOR_NAME;
  const isMe = !!meId && entry.actorId === meId;
  const actor = isSystem ? SYSTEM_ACTOR_NAME : isMe ? 'You' : entry.actorName;
  const when = parseTimestamp(entry.createdAt);
  const avatarSize = compact ? 26 : 34;
  const action = ACTION_ICONS[entry.action];
  const ActionIcon = action?.icon;

  const summary = continueSentence(entry.summary);
  const parts = href ? splitQuoted(summary) : null;

  return (
    <Group
      component="li"
      wrap="nowrap"
      align="flex-start"
      gap={compact ? 'xs' : 'sm'}
      data-testid="activity-item"
      style={{ listStyle: 'none' }}
    >
      <Box pos="relative" style={{ flexShrink: 0 }}>
        {isSystem ? (
          <ThemeIcon
            size={avatarSize}
            radius="xl"
            variant="light"
            color="gray"
            aria-hidden
            data-testid="activity-system-icon"
          >
            <IconRobot size={compact ? 14 : 18} />
          </ThemeIcon>
        ) : (
          <PersonAvatar
            size={avatarSize}
            name={entry.actorName}
            seed={entry.actorId}
            fz={compact ? 10 : 12}
          />
        )}
        {ActionIcon && !compact && (
          <ThemeIcon
            size={16}
            radius="xl"
            color={action.color}
            variant="filled"
            aria-hidden
            pos="absolute"
            bottom={-3}
            right={-3}
            style={{ border: '2px solid var(--mantine-color-body)' }}
          >
            <ActionIcon size={9} stroke={3} />
          </ThemeIcon>
        )}
      </Box>

      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size={compact ? 'xs' : 'sm'} style={{ overflowWrap: 'anywhere' }} lh={1.45}>
          <Text span inherit fw={600}>
            {actor}
          </Text>
          {!isSystem && <BotMarker kind={entry.actorKind} />}
          {entry.via === 'owner_secret' && (
            <Text span inherit size="xs" c="dimmed">
              (via owner secret)
            </Text>
          )}{' '}
          {parts && href ? (
            <>
              {parts.before}
              <Anchor component={Link} href={href} inherit fw={500}>
                &ldquo;{parts.quoted}&rdquo;
              </Anchor>
              {parts.after}
            </>
          ) : href ? (
            <Anchor component={Link} href={href} inherit c="inherit" underline="hover">
              {summary}
            </Anchor>
          ) : (
            summary
          )}
        </Text>
        <Group gap={6} mt={2} wrap="wrap">
          {when && (
            <Tooltip label={absoluteTime(when)} withArrow openDelay={200}>
              <Text
                component="time"
                dateTime={when.toISOString()}
                size="xs"
                c="dimmed"
                aria-label={absoluteTime(when)}
              >
                {relativeTime(when, now)}
              </Text>
            </Tooltip>
          )}
          {entry.via === 'token' && (
            <Tooltip
              label={entry.viaDetail ? `Via token "${entry.viaDetail}"` : 'Via token'}
              withArrow
              openDelay={200}
            >
              <span
                role="img"
                aria-label={entry.viaDetail ? `Via token "${entry.viaDetail}"` : 'Via token'}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <IconKey size={14} aria-hidden />
              </span>
            </Tooltip>
          )}
          {contextLabel && (
            <Badge size="xs" variant="light" color="gray" radius="sm" tt="none" fw={500}>
              {contextLabel}
            </Badge>
          )}
        </Group>
      </Box>
    </Group>
  );
}

function FeedSkeleton({ rows, compact }: { rows: number; compact: boolean }) {
  const size = compact ? 26 : 34;
  return (
    <Stack gap={compact ? 'sm' : 'md'} aria-busy="true" aria-label="Loading activity">
      {Array.from({ length: rows }).map((_, i) => (
        <Group key={i} wrap="nowrap" align="flex-start" gap={compact ? 'xs' : 'sm'}>
          <Skeleton circle height={size} width={size} style={{ flexShrink: 0 }} />
          <Box style={{ flex: 1 }}>
            <Skeleton height={compact ? 10 : 12} width={`${70 - (i % 3) * 12}%`} radius="sm" />
            <Skeleton height={8} width={80} mt={8} radius="sm" />
          </Box>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * Who did what, newest first. Fetches GET /activity with the given filters.
 * Use `compact` inside task and epic detail panels.
 */
export function ActivityFeed({
  taskId,
  epicId,
  projectId,
  orgId,
  limit,
  compact = false,
  title,
}: ActivityFeedProps) {
  const effectiveLimit = limit ?? (compact ? 10 : 50);
  const { data, isPending, isError, error, refetch, isFetching } = useActivity({
    taskId,
    epicId,
    projectId,
    orgId,
    limit: effectiveLimit,
  });
  const { data: me } = useMe();
  const { data: session } = useSession();
  // The Auth0 id is the API user id, so "You" shows before /users/me has loaded
  const meId = me?.id ?? session?.user?.id;

  // Badges say where something happened, unless the feed is already about one place
  const showProjectBadge = !taskId && !projectId;
  const showWorkspaceBadge = showProjectBadge && !orgId && !epicId;
  const workspaceNames = useWorkspaceNames(showWorkspaceBadge);
  const now = new Date();

  const heading = title ? (
    <Group gap={6} mb={compact ? 'xs' : 'sm'}>
      <IconHistory size={compact ? 14 : 18} aria-hidden />
      <Text fw={600} size={compact ? 'sm' : 'md'}>
        {title}
      </Text>
    </Group>
  ) : null;

  let body: React.ReactNode;
  // isPending also covers the moment before the session token arrives, so no empty-state flash
  if (isPending && !isError) {
    body = <FeedSkeleton rows={compact ? 3 : 6} compact={compact} />;
  } else if (isError) {
    body = (
      <Alert color="red" variant="light" title="Couldn't load activity" p={compact ? 'xs' : 'sm'}>
        <Text size="sm" mb="xs">
          {(error as Error)?.message || 'Something went wrong.'}
        </Text>
        <Button
          size="xs"
          variant="light"
          color="red"
          leftSection={<IconRefresh size={14} />}
          onClick={() => refetch()}
          loading={isFetching}
        >
          Try again
        </Button>
      </Alert>
    );
  } else if (!Array.isArray(data) || data.length === 0) {
    body = compact ? (
      <Text size="xs" c="dimmed">
        No activity yet
      </Text>
    ) : (
      <Stack align="center" gap={4} py="lg">
        <ThemeIcon size={40} radius="xl" variant="light" color="gray" aria-hidden>
          <IconHistory size={22} />
        </ThemeIcon>
        <Text fw={500}>No activity yet</Text>
        <Text size="sm" c="dimmed" ta="center">
          Changes to tasks, epics, notes and people will show up here.
        </Text>
      </Stack>
    );
  } else {
    let lastDay = '';
    body = (
      <Stack
        component="ul"
        gap={compact ? 'sm' : 'md'}
        m={0}
        p={0}
        aria-label={title || 'Activity'}
      >
        {data.map((entry) => {
          const when = parseTimestamp(entry.createdAt);
          const day = !compact && when ? dayLabel(when, now) : '';
          const separator =
            day && day !== lastDay ? (
              <Text
                component="li"
                key={`day-${entry.id}`}
                size="xs"
                fw={700}
                c="dimmed"
                tt="uppercase"
                style={{ listStyle: 'none', letterSpacing: 0.4 }}
                pt={lastDay ? 'xs' : 0}
                aria-hidden
              >
                {day}
              </Text>
            ) : null;
          if (day) {
            lastDay = day;
          }

          const contextLabel = showProjectBadge
            ? entry.projectName ||
              (showWorkspaceBadge && entry.orgId ? workspaceNames.get(entry.orgId) || null : null)
            : null;

          return (
            <React.Fragment key={entry.id}>
              {separator}
              <ActivityItem
                entry={entry}
                meId={meId}
                compact={compact}
                href={linkFor(entry, { taskId, epicId })}
                contextLabel={contextLabel}
                now={now}
              />
            </React.Fragment>
          );
        })}
      </Stack>
    );
  }

  return (
    <Box data-testid="activity-feed">
      {heading}
      {body}
    </Box>
  );
}

export default ActivityFeed;
