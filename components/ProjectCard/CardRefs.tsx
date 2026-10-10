import React, { type KeyboardEvent, type MouseEvent } from 'react';
import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { sortRefs } from '../../app/hooks/useRefQueries';
import type { RefView } from '../../app/types/project.types';
import { shortRefLabel } from '../../workers/src/lib/refs';
import { RefKindIcon, roleLabel } from '../TaskDetail/refDisplay';

/** How many refs a card shows before "+N". */
const MAX_ON_CARD = 3;

// Links on a card sit inside the card's toggle and drag handle: keep clicks and keys to themselves
const stopClick = (e: MouseEvent) => e.stopPropagation();
const stopKeys = (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation();
  }
};

/**
 * One compact line of ref icons with short labels (`#12`, `PR 7`, `4411`) and `+N`.
 * Renders nothing when the task has no refs, so those cards keep their height.
 */
export function CardRefs({ refs }: { refs?: RefView[] }) {
  if (!refs || refs.length === 0) {
    return null;
  }
  const sorted = sortRefs(refs);
  const shown = sorted.slice(0, MAX_ON_CARD);
  const more = sorted.length - shown.length;

  return (
    <Group
      gap={10}
      wrap="nowrap"
      mt={2}
      data-testid="task-card-refs"
      aria-label={`${refs.length} ${refs.length === 1 ? 'link' : 'links'}`}
      style={{ overflow: 'hidden', lineHeight: 1 }}
    >
      {shown.map((ref) => {
        const content = (
          <Group gap={3} wrap="nowrap" c="dimmed">
            <RefKindIcon kind={ref.kind} size={12} />
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {shortRefLabel(ref.kind, ref.ref)}
            </Text>
          </Group>
        );
        const tip = `${roleLabel(ref.role)}: ${ref.displayLabel}`;
        return (
          <Tooltip key={ref.id} label={tip} withArrow openDelay={300}>
            {ref.url ? (
              <UnstyledButton
                component="a"
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${tip} (opens in a new tab)`}
                onClick={stopClick}
                onKeyDown={stopKeys}
                data-testid="task-card-ref"
              >
                {content}
              </UnstyledButton>
            ) : (
              // role="img" so screen readers read the label (role and ref), not just "4411"
              <span role="img" aria-label={tip} data-testid="task-card-ref">
                {content}
              </span>
            )}
          </Tooltip>
        );
      })}
      {more > 0 && (
        <Tooltip
          label={sorted
            .slice(MAX_ON_CARD)
            .map((r) => `${roleLabel(r.role)}: ${r.displayLabel}`)
            .join(', ')}
          withArrow
          multiline
          maw={320}
          openDelay={300}
        >
          <Text size="xs" c="dimmed" data-testid="task-card-refs-more">
            +{more}
          </Text>
        </Tooltip>
      )}
    </Group>
  );
}
