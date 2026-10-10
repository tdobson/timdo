/**
 * Workspaces (Organisations), their members and the projects inside them.
 *
 * Sharing rules:
 * - owner: everything; only owners can make someone an owner or admin, or delete the workspace
 * - admin: add/remove members and viewers, add/move/rename projects
 * - member: work on tasks, epics and notes
 * - viewer: read only
 * A workspace always keeps at least one owner. Anyone can leave a workspace they don't own alone.
 */
import { and, asc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import {
  AccessError,
  canEdit,
  canManage,
  createProjectInOrg,
  getOrgRole,
  type Role,
} from './accessService';
import { logActivity } from './activityService';
import { generateSlug } from './migrationService';
import { assertSourcesFreeIn, updateRefOrgs } from './refService';

type DB = DrizzleD1Database<typeof schema>;

export interface OrganisationWithRole {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  isPersonal: boolean;
  role: Role;
  memberCount: number;
  projectCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AutocompleteUserResult {
  id: string;
  name: string | null;
  email: string;
  isMember: boolean;
  role?: Role;
}

const orgColumns = {
  id: schema.organisations.id,
  name: schema.organisations.name,
  slug: schema.organisations.slug,
  createdBy: schema.organisations.createdBy,
  isPersonal: schema.organisations.isPersonal,
  createdAt: schema.organisations.createdAt,
  updatedAt: schema.organisations.updatedAt,
  role: schema.organisationMembers.role,
  memberCount: sql<number>`(select count(*) from OrganisationMembers om where om.org_id = Organisations.id)`,
  projectCount: sql<number>`(select count(*) from Projects p where p.org_id = Organisations.id and coalesce(p.is_archived, 0) = 0)`,
};

function normaliseOrg(row: any): OrganisationWithRole {
  return {
    ...row,
    isPersonal: !!row.isPersonal,
    memberCount: Number(row.memberCount || 0),
    projectCount: Number(row.projectCount || 0),
  };
}

/**
 * All workspaces the user belongs to, personal first.
 */
export async function getUserOrganisations(
  db: DB,
  userId: string
): Promise<OrganisationWithRole[]> {
  const rows = await db
    .select(orgColumns)
    .from(schema.organisations)
    .innerJoin(
      schema.organisationMembers,
      eq(schema.organisations.id, schema.organisationMembers.orgId)
    )
    .where(eq(schema.organisationMembers.userId, userId))
    .orderBy(sql`${schema.organisations.isPersonal} desc`, asc(schema.organisations.name))
    .all();
  return rows.map(normaliseOrg);
}

export async function getOrganisationById(
  db: DB,
  userId: string,
  orgId: string
): Promise<OrganisationWithRole | null> {
  const row = await db
    .select(orgColumns)
    .from(schema.organisations)
    .innerJoin(
      schema.organisationMembers,
      eq(schema.organisations.id, schema.organisationMembers.orgId)
    )
    .where(and(eq(schema.organisations.id, orgId), eq(schema.organisationMembers.userId, userId)))
    .get();
  return row ? normaliseOrg(row) : null;
}

async function requireRole(db: DB, userId: string, orgId: string, check: (r: Role) => boolean) {
  const role = await getOrgRole(db, userId, orgId);
  if (!role) {
    throw new AccessError('Workspace not found', 404);
  }
  if (!check(role)) {
    throw new AccessError('You do not have permission to do that here');
  }
  return role;
}

/**
 * Create a shared workspace with the creator as owner.
 */
export async function createOrganisation(db: DB, userId: string, name: string, slug?: string) {
  const orgId = uuidv4();
  const now = new Date().toISOString();
  await db.insert(schema.organisations).values({
    id: orgId,
    name: name.trim(),
    slug: slug || `${generateSlug(name)}-${orgId.slice(0, 6)}`,
    isPersonal: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.organisationMembers).values({
    id: uuidv4(),
    orgId,
    userId,
    role: 'owner',
    createdAt: now,
    updatedAt: now,
  });
  await logActivity(db, {
    actorId: userId,
    orgId,
    entityType: 'organisation',
    entityId: orgId,
    action: 'created',
    summary: `Created the ${name.trim()} workspace`,
  });
  return (await getOrganisationById(db, userId, orgId))!;
}

export async function renameOrganisation(db: DB, userId: string, orgId: string, name: string) {
  await requireRole(db, userId, orgId, canManage);
  const before = await db
    .select({ name: schema.organisations.name })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId))
    .get();
  await db
    .update(schema.organisations)
    .set({ name: name.trim(), updatedAt: new Date().toISOString() })
    .where(eq(schema.organisations.id, orgId));
  await logActivity(db, {
    actorId: userId,
    orgId,
    entityType: 'organisation',
    entityId: orgId,
    action: 'renamed',
    summary: `Renamed the workspace from ${before?.name} to ${name.trim()}`,
  });
  return getOrganisationById(db, userId, orgId);
}

/** Only empty, non-personal workspaces can be deleted, and only by an owner. */
export async function deleteOrganisation(db: DB, userId: string, orgId: string) {
  await requireRole(db, userId, orgId, (r) => r === 'owner');
  const org = await getOrganisationById(db, userId, orgId);
  if (!org) {
    throw new AccessError('Workspace not found', 404);
  }
  if (org.isPersonal) {
    throw new AccessError('Your personal workspace cannot be deleted');
  }
  const projects = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.orgId, orgId));
  if (projects.length > 0) {
    throw new AccessError('Move or delete its projects before deleting this workspace');
  }
  await db.delete(schema.organisations).where(eq(schema.organisations.id, orgId));
  return true;
}

export async function getOrganisationMembers(db: DB, orgId: string) {
  return db
    .select({
      id: schema.organisationMembers.id,
      orgId: schema.organisationMembers.orgId,
      userId: schema.organisationMembers.userId,
      role: schema.organisationMembers.role,
      createdAt: schema.organisationMembers.createdAt,
      userName: schema.users.name,
      userEmail: schema.users.email,
    })
    .from(schema.organisationMembers)
    .innerJoin(schema.users, eq(schema.organisationMembers.userId, schema.users.id))
    .where(eq(schema.organisationMembers.orgId, orgId))
    .orderBy(asc(schema.users.name))
    .all();
}

/**
 * Find people to add. Only matches on 2+ characters, so the user list can't be browsed.
 */
export async function searchUsersForAutocomplete(
  db: DB,
  callerId: string,
  query: string,
  orgId: string
): Promise<AutocompleteUserResult[]> {
  await requireRole(db, callerId, orgId, canManage);
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    return [];
  }
  // Only people you already work with (any shared workspace), or an exact email match.
  // Nobody can browse the whole user list.
  const pattern = `%${q}%`;
  const matchingUsers = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(
      or(
        sql`lower(${schema.users.email}) = ${q}`,
        and(
          or(like(schema.users.name, pattern), like(schema.users.email, pattern)),
          sql`${schema.users.id} in (
            select om2.user_id from OrganisationMembers om1
            join OrganisationMembers om2 on om2.org_id = om1.org_id
            where om1.user_id = ${callerId})`
        )
      )
    )
    .limit(10);

  const existingMembers = await getOrganisationMembers(db, orgId);
  const memberMap = new Map(existingMembers.map((m) => [m.userId, m.role as Role]));

  return matchingUsers.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    isMember: memberMap.has(u.id),
    role: memberMap.get(u.id),
  }));
}

async function addMemberRow(db: DB, orgId: string, userId: string, role: Role) {
  const now = new Date().toISOString();
  await db.insert(schema.organisationMembers).values({
    id: uuidv4(),
    orgId,
    userId,
    role,
    createdAt: now,
    updatedAt: now,
  });
}

async function orgName(db: DB, orgId: string) {
  const row = await db
    .select({ name: schema.organisations.name })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId))
    .get();
  return row?.name ?? 'the workspace';
}

export type InviteResult =
  | { status: 'added'; userId: string; name: string | null; email: string; role: Role }
  | { status: 'already_member'; userId: string; email: string; role: Role }
  | {
      status: 'invited';
      id: string;
      email: string;
      role: Role;
      token: string;
      expiresAt: string;
    };

/**
 * Share a workspace with someone. If they already have a TimDo account they're added
 * straight away; otherwise an invite is created that they claim when they first sign in
 * with that email (or by opening the invite link).
 */
export async function inviteMember(
  db: DB,
  inviterId: string,
  orgId: string,
  email: string,
  role: 'admin' | 'member' | 'viewer' = 'member'
): Promise<InviteResult> {
  const inviterRole = await requireRole(db, inviterId, orgId, canManage);
  if (role === 'admin' && inviterRole !== 'owner') {
    throw new AccessError('Only owners can add admins');
  }
  const cleanEmail = email.toLowerCase().trim();
  const name = await orgName(db, orgId);

  const existingUser = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${cleanEmail}`)
    .get();

  if (existingUser) {
    const currentRole = await getOrgRole(db, existingUser.id, orgId);
    if (currentRole) {
      return {
        status: 'already_member',
        userId: existingUser.id,
        email: existingUser.email,
        role: currentRole,
      };
    }
    await addMemberRow(db, orgId, existingUser.id, role);
    await logActivity(db, {
      actorId: inviterId,
      orgId,
      entityType: 'member',
      entityId: existingUser.id,
      action: 'member_added',
      summary: `Added ${existingUser.name || existingUser.email} to ${name} as ${role}`,
    });
    return {
      status: 'added',
      userId: existingUser.id,
      name: existingUser.name,
      email: existingUser.email,
      role,
    };
  }

  // Replace any earlier pending invite for the same address
  await db
    .delete(schema.organisationInvites)
    .where(
      and(
        eq(schema.organisationInvites.orgId, orgId),
        eq(schema.organisationInvites.email, cleanEmail),
        isNull(schema.organisationInvites.acceptedAt)
      )
    );
  const invite = {
    id: uuidv4(),
    orgId,
    email: cleanEmail,
    role,
    token: uuidv4(),
    invitedBy: inviterId,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await db.insert(schema.organisationInvites).values(invite);
  await logActivity(db, {
    actorId: inviterId,
    orgId,
    entityType: 'member',
    entityId: invite.id,
    action: 'invited',
    summary: `Invited ${cleanEmail} to ${name} as ${role}`,
  });
  return {
    status: 'invited',
    id: invite.id,
    email: cleanEmail,
    role,
    token: invite.token,
    expiresAt: invite.expiresAt,
  };
}

export async function getOrganisationInvites(db: DB, userId: string, orgId: string) {
  await requireRole(db, userId, orgId, canManage);
  return db
    .select()
    .from(schema.organisationInvites)
    .where(
      and(
        eq(schema.organisationInvites.orgId, orgId),
        isNull(schema.organisationInvites.acceptedAt)
      )
    )
    .all();
}

export async function revokeInvite(db: DB, userId: string, orgId: string, inviteId: string) {
  await requireRole(db, userId, orgId, canManage);
  const result = await db
    .delete(schema.organisationInvites)
    .where(
      and(
        eq(schema.organisationInvites.id, inviteId),
        eq(schema.organisationInvites.orgId, orgId),
        isNull(schema.organisationInvites.acceptedAt)
      )
    )
    .returning({ id: schema.organisationInvites.id });
  return result.length > 0;
}

/**
 * Accept an invite by token (the invite link).
 */
export async function acceptInvite(db: DB, userId: string, token: string) {
  const invite = await db
    .select()
    .from(schema.organisationInvites)
    .where(eq(schema.organisationInvites.token, token))
    .get();

  if (!invite) {
    throw new Error('This invite link is invalid or has been cancelled');
  }
  if (invite.acceptedBy) {
    // Opening the link again (e.g. after sign-in already claimed it) is fine for the same person
    if (invite.acceptedBy === userId) {
      const role = await getOrgRole(db, userId, invite.orgId);
      return { success: true, orgId: invite.orgId, role: role ?? invite.role };
    }
    throw new Error('This invite has already been used by someone else');
  }
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    throw new Error('This invite has expired. Ask for a new one.');
  }

  const existing = await getOrgRole(db, userId, invite.orgId);
  if (!existing) {
    await addMemberRow(db, invite.orgId, userId, invite.role as Role);
    await logActivity(db, {
      actorId: userId,
      orgId: invite.orgId,
      entityType: 'member',
      entityId: userId,
      action: 'member_joined',
      summary: `Joined ${await orgName(db, invite.orgId)} as ${invite.role}`,
    });
  }
  await db
    .update(schema.organisationInvites)
    .set({ acceptedBy: userId, acceptedAt: new Date().toISOString() })
    .where(eq(schema.organisationInvites.id, invite.id));

  return { success: true, orgId: invite.orgId, role: existing ?? invite.role };
}

/**
 * On sign-in: any unexpired invites sent to this email become memberships.
 */
export async function claimPendingInvites(db: DB, userId: string, email: string) {
  const invites = await db
    .select()
    .from(schema.organisationInvites)
    .where(
      and(
        eq(schema.organisationInvites.email, email.toLowerCase().trim()),
        isNull(schema.organisationInvites.acceptedAt)
      )
    )
    .all();
  for (const invite of invites) {
    if (new Date(invite.expiresAt).getTime() >= Date.now()) {
      await acceptInvite(db, userId, invite.token);
    }
  }
  return invites.length;
}

async function ownerCount(db: DB, orgId: string) {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.organisationMembers)
    .where(
      and(eq(schema.organisationMembers.orgId, orgId), eq(schema.organisationMembers.role, 'owner'))
    )
    .get();
  return Number(row?.n || 0);
}

export async function updateMemberRole(
  db: DB,
  callerId: string,
  orgId: string,
  targetUserId: string,
  newRole: Role
) {
  const callerRole = await requireRole(db, callerId, orgId, canManage);
  const targetRole = await getOrgRole(db, targetUserId, orgId);
  if (!targetRole) {
    return null;
  }

  const touchesOwnerOrAdmin =
    newRole === 'owner' || newRole === 'admin' || targetRole === 'owner' || targetRole === 'admin';
  if (touchesOwnerOrAdmin && callerRole !== 'owner') {
    throw new AccessError('Only owners can change owner and admin roles');
  }
  if (targetRole === 'owner' && newRole !== 'owner' && (await ownerCount(db, orgId)) <= 1) {
    throw new AccessError('A workspace needs at least one owner');
  }

  const result = await db
    .update(schema.organisationMembers)
    .set({ role: newRole, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.organisationMembers.orgId, orgId),
        eq(schema.organisationMembers.userId, targetUserId)
      )
    )
    .returning();

  if (targetRole !== newRole) {
    const target = await db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, targetUserId))
      .get();
    await logActivity(db, {
      actorId: callerId,
      orgId,
      entityType: 'member',
      entityId: targetUserId,
      action: 'role_changed',
      summary: `Changed ${target?.name || target?.email}'s role from ${targetRole} to ${newRole}`,
    });
  }
  return result[0] || null;
}

/**
 * Remove someone from a workspace, or leave it yourself.
 */
export async function removeMember(db: DB, callerId: string, orgId: string, targetUserId: string) {
  const leaving = callerId === targetUserId;
  const callerRole = leaving
    ? await requireRole(db, callerId, orgId, () => true)
    : await requireRole(db, callerId, orgId, canManage);
  const targetRole = await getOrgRole(db, targetUserId, orgId);
  if (!targetRole) {
    return false;
  }

  const org = await getOrganisationById(db, callerId, orgId);
  if (org?.isPersonal && targetRole === 'owner') {
    throw new AccessError('You cannot leave your own personal workspace');
  }
  if (!leaving && (targetRole === 'owner' || targetRole === 'admin') && callerRole !== 'owner') {
    throw new AccessError('Only owners can remove owners and admins');
  }
  if (targetRole === 'owner' && (await ownerCount(db, orgId)) <= 1) {
    throw new AccessError('A workspace needs at least one owner');
  }

  const target = await db
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .get();

  const result = await db
    .delete(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.orgId, orgId),
        eq(schema.organisationMembers.userId, targetUserId)
      )
    )
    .returning({ id: schema.organisationMembers.id });

  if (result.length > 0) {
    await logActivity(db, {
      actorId: callerId,
      orgId,
      entityType: 'member',
      entityId: targetUserId,
      action: leaving ? 'member_left' : 'member_removed',
      summary: leaving
        ? `Left ${org?.name ?? 'the workspace'}`
        : `Removed ${target?.name || target?.email} from ${org?.name ?? 'the workspace'}`,
    });
  }
  return result.length > 0;
}

/* ---------------------------------------------------------------- projects in workspaces */

export async function getOrganisationProjects(db: DB, userId: string, orgId: string) {
  await requireRole(db, userId, orgId, () => true);
  return db
    .select({
      id: schema.projects.id,
      key: schema.projects.key,
      name: schema.projects.name,
      description: schema.projects.description,
      isArchived: schema.projects.isArchived,
      openTasks: sql<number>`(select count(*) from Tasks t where t.project_id = Projects.id and t.is_deleted = 0 and t.status != 'done')`,
      doneTasks: sql<number>`(select count(*) from Tasks t where t.project_id = Projects.id and t.is_deleted = 0 and t.status = 'done')`,
      epicCount: sql<number>`(select count(*) from Epics e where e.project_id = Projects.id)`,
    })
    .from(schema.projects)
    .where(eq(schema.projects.orgId, orgId))
    .orderBy(asc(schema.projects.name))
    .all();
}

export async function addProject(
  db: DB,
  userId: string,
  orgId: string,
  name: string,
  description?: string | null
) {
  await requireRole(db, userId, orgId, canManage);
  const clash = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.orgId, orgId),
        sql`lower(${schema.projects.name}) = ${name.trim().toLowerCase()}`
      )
    )
    .get();
  if (clash) {
    throw new AccessError(`There is already a project called "${name.trim()}" here`);
  }
  const project = await createProjectInOrg(db, userId, orgId, name, description);
  await logActivity(db, {
    actorId: userId,
    orgId,
    projectId: project.id,
    entityType: 'project',
    entityId: project.id,
    action: 'created',
    summary: `Created the ${project.name} project`,
  });
  return project;
}

/**
 * Rename, archive, or move a project to another workspace. Moving needs owner/admin in
 * the source workspace and edit rights in the destination; everyone in the destination
 * workspace can then see the project's tasks and epics.
 */
export async function updateProjectContainer(
  db: DB,
  userId: string,
  orgId: string,
  projectId: string,
  data: { name?: string; description?: string | null; isArchived?: boolean; orgId?: string }
) {
  const project = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.orgId, orgId)))
    .get();
  if (!project) {
    throw new AccessError('Project not found', 404);
  }
  await requireRole(db, userId, orgId, canManage);

  const patch: Partial<typeof schema.projects.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (data.name !== undefined && data.name.trim() && data.name.trim() !== project.name) {
    patch.name = data.name.trim();
    const clash = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, data.orgId ?? orgId),
          sql`lower(${schema.projects.name}) = ${patch.name.toLowerCase()}`,
          sql`${schema.projects.id} != ${projectId}`
        )
      )
      .get();
    if (clash) {
      throw new AccessError(`There is already a project called "${patch.name}" here`);
    }
  }
  if (data.description !== undefined) {
    patch.description = data.description;
  }
  if (data.isArchived !== undefined) {
    patch.isArchived = data.isArchived;
  }

  let destinationName: string | null = null;
  let sourceReleases: Awaited<ReturnType<typeof assertSourcesFreeIn>> = [];
  if (data.orgId && data.orgId !== orgId) {
    const destRole = await getOrgRole(db, userId, data.orgId);
    if (!canEdit(destRole)) {
      throw new AccessError('You need to be able to edit the destination workspace');
    }
    const clash = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.orgId, data.orgId),
          sql`lower(${schema.projects.name}) = ${(patch.name ?? project.name).toLowerCase()}`
        )
      )
      .get();
    if (clash) {
      throw new AccessError(
        `The destination workspace already has a project called "${patch.name ?? project.name}"`
      );
    }
    // A ref can be the source of only one task per workspace
    sourceReleases = await assertSourcesFreeIn(db, data.orgId, { projectId });
    patch.orgId = data.orgId;
    destinationName = await orgName(db, data.orgId);
  }

  const projectUpdate = db
    .update(schema.projects)
    .set(patch)
    .where(eq(schema.projects.id, projectId));
  if (patch.orgId) {
    // Refs carry their task's workspace, so they move in the same batch as the project
    await db.batch([
      ...sourceReleases,
      projectUpdate,
      updateRefOrgs(db, patch.orgId, { projectId }),
    ] as unknown as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
  } else {
    await projectUpdate;
  }

  // Keep the epics' denormalised category name in step with a rename
  if (patch.name) {
    await db
      .update(schema.epics)
      .set({ category: patch.name })
      .where(eq(schema.epics.projectId, projectId));
  }

  const label = patch.name ?? project.name;
  if (destinationName) {
    const fromName = await orgName(db, orgId);
    for (const logOrg of [orgId, data.orgId!]) {
      await logActivity(db, {
        actorId: userId,
        orgId: logOrg,
        projectId: logOrg === data.orgId ? projectId : null,
        entityType: 'project',
        entityId: projectId,
        action: 'moved',
        summary: `Moved the ${label} project from ${fromName} to ${destinationName}`,
      });
    }
  }
  if (patch.name) {
    await logActivity(db, {
      actorId: userId,
      orgId: patch.orgId ?? orgId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'renamed',
      summary: `Renamed the ${project.name} project to ${patch.name}`,
    });
  }
  if (data.isArchived !== undefined && !!data.isArchived !== !!project.isArchived) {
    await logActivity(db, {
      actorId: userId,
      orgId: patch.orgId ?? orgId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: data.isArchived ? 'archived' : 'unarchived',
      summary: `${data.isArchived ? 'Archived' : 'Unarchived'} the ${label} project`,
    });
  }

  return db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
}

/* ---------------------------------------------------------------- sharing overview */

/**
 * Everything the Sharing page needs in one call: each workspace, your role, its people,
 * pending invites (if you manage it) and its projects.
 */
export async function getSharingOverview(db: DB, userId: string) {
  const orgs = await getUserOrganisations(db, userId);
  return Promise.all(
    orgs.map(async (org) => {
      const [members, projects, invites] = await Promise.all([
        getOrganisationMembers(db, org.id),
        getOrganisationProjects(db, userId, org.id),
        canManage(org.role)
          ? db
              .select({
                id: schema.organisationInvites.id,
                email: schema.organisationInvites.email,
                role: schema.organisationInvites.role,
                token: schema.organisationInvites.token,
                expiresAt: schema.organisationInvites.expiresAt,
              })
              .from(schema.organisationInvites)
              .where(
                and(
                  eq(schema.organisationInvites.orgId, org.id),
                  isNull(schema.organisationInvites.acceptedAt)
                )
              )
              .all()
          : Promise.resolve([]),
      ]);
      return {
        ...org,
        members: members.map((m) => ({ ...m, isMe: m.userId === userId })),
        projects: projects.map((p) => ({
          ...p,
          isArchived: !!p.isArchived,
          openTasks: Number(p.openTasks || 0),
          doneTasks: Number(p.doneTasks || 0),
          epicCount: Number(p.epicCount || 0),
        })),
        invites,
      };
    })
  );
}
