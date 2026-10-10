import React from 'react';
import { IconBrandGithub, IconBug, IconLink, IconMail, IconUser } from '@tabler/icons-react';
import type { RefRole } from '../../app/types/project.types';
import { ROLE_LABELS } from '../../workers/src/lib/refs';

// Kinds from error trackers get a bug; any other system can still use its own kind names
const ERROR_TRACKERS = ['sentry', 'bugsnag', 'rollbar', 'honeybadger', 'airbrake', 'raygun'];

/** Which icon a ref kind gets: GitHub, mail, bug for error trackers, person, or a plain link. */
export function refIconFor(kind: string): typeof IconLink {
  const system = kind.split('.')[0];
  const type = kind.split('.').pop() || '';
  if (system === 'github') {
    return IconBrandGithub;
  }
  if (kind === 'email' || ['member', 'user', 'person', 'account', 'contact'].includes(type)) {
    return IconUser;
  }
  if (system === 'gmail' || system === 'mail') {
    return IconMail;
  }
  if (ERROR_TRACKERS.includes(system)) {
    return IconBug;
  }
  return IconLink;
}

export function RefKindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const Icon = refIconFor(kind);
  return <Icon size={size} aria-hidden style={{ flexShrink: 0 }} />;
}

/** "Source", "Reported by"... */
export function roleLabel(role: RefRole): string {
  return ROLE_LABELS[role] || role;
}
