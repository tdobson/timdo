/**
 * @fileoverview Who may do what on the sharing page. Mirrors the server rules in
 * workers/src/services/organisationService.ts so the UI only offers actions that can work.
 * The server still has the final say; its errors are shown as notifications.
 */
import type {
  InviteRole,
  SharingMember,
  SharingWorkspace,
  WorkspaceRole,
} from '../../app/types/collaboration.types';

export const ROLE_ORDER: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer'];

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: 'Everything',
  admin: 'Manage people and projects',
  member: 'Work on tasks, epics and notes',
  viewer: 'Read only',
};

export const ROLE_COLOURS: Record<WorkspaceRole, string> = {
  owner: 'yellow',
  admin: 'blue',
  member: 'teal',
  viewer: 'gray',
};

export const canManage = (role: WorkspaceRole | null | undefined) =>
  role === 'owner' || role === 'admin';

export const canEdit = (role: WorkspaceRole | null | undefined) =>
  role === 'owner' || role === 'admin' || role === 'member';

export function ownerCount(ws: Pick<SharingWorkspace, 'members'>): number {
  return ws.members.filter((m) => m.role === 'owner').length;
}

/**
 * Roles I can pick for this person, or null when their role can't be changed by me.
 * Owners can change anyone (including other owners and admins); admins only members and viewers.
 * Your own role is only offered when another owner would remain.
 */
export function assignableRoles(
  ws: Pick<SharingWorkspace, 'role' | 'members' | 'isPersonal'>,
  target: SharingMember
): WorkspaceRole[] | null {
  const myRole = ws.role;
  if (target.kind === 'bot' || target.userId.startsWith('bot|')) {
    return null;
  }
  if (target.isMe) {
    if (myRole === 'owner' && !ws.isPersonal && ownerCount(ws) > 1) {
      return [...ROLE_ORDER];
    }
    return null;
  }
  if (myRole === 'owner') {
    return [...ROLE_ORDER];
  }
  if (myRole === 'admin' && (target.role === 'member' || target.role === 'viewer')) {
    return ['member', 'viewer'];
  }
  return null;
}

/** Can I remove this (other) person? */
export function canRemove(
  ws: Pick<SharingWorkspace, 'role' | 'members'>,
  target: SharingMember
): boolean {
  if (target.isMe || target.kind === 'bot' || target.userId.startsWith('bot|')) {
    return false;
  }
  if (ws.role === 'owner') {
    return !(target.role === 'owner' && ownerCount(ws) <= 1);
  }
  if (ws.role === 'admin') {
    return target.role === 'member' || target.role === 'viewer';
  }
  return false;
}

/** Whether I can leave, and if not, a short reason to show. */
export function leaveState(ws: Pick<SharingWorkspace, 'role' | 'members' | 'isPersonal'>): {
  canLeave: boolean;
  reason?: string;
} {
  if (ws.isPersonal && ws.role === 'owner') {
    return { canLeave: false, reason: "You can't leave your own personal workspace" };
  }
  if (ws.role === 'owner' && ownerCount(ws) <= 1) {
    return { canLeave: false, reason: 'Make someone else an owner first' };
  }
  return { canLeave: true };
}

/** Roles I can give when sharing: admins can only be added by owners. */
export function inviteRoles(myRole: WorkspaceRole): InviteRole[] {
  return myRole === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
}

export function personName(
  m: Pick<SharingMember, 'userName' | 'userEmail' | 'kind' | 'userId'>
): string {
  return (
    m.userName ||
    (m.kind === 'bot' || m.userId.startsWith('bot|') ? 'Bot' : m.userEmail || 'Someone')
  );
}

/** "A", "A and B", "A, B and C" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] || '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function memberLabel(member: SharingMember): string {
  const name = personName(member);
  return member.kind === 'bot' || member.userId.startsWith('bot|') ? `${name} [bot]` : name;
}

/** "Only you", "Shared with Robin Fairweather", "Shared with A, B and 3 others" */
export function whoCanSee(ws: Pick<SharingWorkspace, 'members'>): string {
  const others = ws.members.filter((m) => !m.isMe).map(memberLabel);
  if (others.length === 0) {
    return 'Only you';
  }
  if (others.length <= 3) {
    return `Shared with ${joinNames(others)}`;
  }
  const rest = others.length - 2;
  return `Shared with ${others.slice(0, 2).join(', ')} and ${rest} others`;
}

/** Who gains and who loses access when a project moves from one workspace to another. */
export function moveImpact(
  source: Pick<SharingWorkspace, 'members'>,
  destination: Pick<SharingWorkspace, 'members'>
): { losing: string[]; gaining: string[] } {
  const destIds = new Set(destination.members.map((m) => m.userId));
  const sourceIds = new Set(source.members.map((m) => m.userId));
  return {
    losing: source.members.filter((m) => !destIds.has(m.userId)).map(memberLabel),
    gaining: destination.members.filter((m) => !sourceIds.has(m.userId)).map(memberLabel),
  };
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Display name for a workspace card: personal workspaces are just "Personal". */
export function workspaceLabel(ws: Pick<SharingWorkspace, 'isPersonal' | 'name'>): string {
  return ws.isPersonal ? 'Personal' : ws.name;
}
