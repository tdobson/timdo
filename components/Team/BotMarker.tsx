'use client';

import React from 'react';
import { Badge } from '@mantine/core';
import type { PersonKind } from '../../app/types/collaboration.types';

export function BotMarker({ kind, size = 'xs' }: { kind?: PersonKind | null; size?: 'xs' | 'sm' }) {
  if (kind !== 'bot') {
    return null;
  }

  return (
    <Badge component="span" size={size} variant="light" color="grape" aria-label="Bot identity">
      [bot]
    </Badge>
  );
}
