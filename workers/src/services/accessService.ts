/**
 * Who can see and change what.
 *
 * Access flows from workspace (Organisations) membership: a member of a workspace can see
 * every project in it. Roles:
 *   owner  - everything, including deleting the workspace and changing roles
 *   admin  - manage members and projects
 *   member - read and edit tasks, epics and notes
 *   viewer - read only
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';
import { generateProjectKey, generateSlug } from './migrationService';
import { getPeople, getUserKind } from './personService';

type DB = DrizzleD1Database<typeof schema>;

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface AccessibleProject {
  id: string;
  key: string;
  name: string;
  orgId: string;
  orgName: string;
  orgIsPersonal: boolean;
  role: Role;
  memberCount: number;
  isArchived: boolean;
}

export class AccessError extends Error {
  status: 403 | 404;
  constructor(message: string, status: 403 | 404 = 403) {
    super(message);
    this.status = status;
  }
}

export const canEdit = (role: Role | null | undefined) =>
  role === 'owner' || role === 'admin' || role === 'member';
export const canManage = (role: Role | null | undefined) => role === 'owner' || role === 'admin';

/** Exact category matches in the same order used by task creation. */
export function matchingProjectsForCategory(
  projects: AccessibleProject[],
  categoryName: string
): AccessibleProject[] {
  const name = categoryName.trim().toLowerCase();
  const rank = (project: AccessibleProject) =>
    project.orgIsPersonal ? 0 : project.role === 'owner' ? 1 : 2;
  return projects
    .filter((project) => project.name.toLowerCase() === name)
    .sort((a, b) => rank(a) - rank(b));
}

export async function getAccessibleProjects(db: DB, userId: string): Promise<AccessibleProject[]> {
  const rows = await db
    .select({
      id: schema.projects.id,
      key: schema.projects.key,
      name: schema.projects.name,
      orgId: schema.projects.orgId,
      orgName: schema.organisations.name,
      orgIsPersonal: schema.organisations.isPersonal,
      role: schema.organisationMembers.role,
      isArchived: schema.projects.isArchived,
      memberCount: sql<number>`(select count(*) from OrganisationMembers om where om.org_id = Projects.org_id)`,
    })
    .from(schema.projects)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.projects.orgId))
    .innerJoin(
      schema.organisationMembers,
      and(
        eq(schema.organisationMembers.orgId, schema.projects.orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .orderBy(asc(schema.projects.name));

  return rows.map((r) => ({
    ...r,
    orgIsPersonal: !!r.orgIsPersonal,
    isArchived: !!r.isArchived,
    memberCount: Number(r.memberCount || 0),
    role: r.role as Role,
  }));
}

export async function getProjectAccess(
  db: DB,
  userId: string,
  projectId: string
): Promise<AccessibleProject | null> {
  const all = await getAccessibleProjects(db, userId);
  return all.find((p) => p.id === projectId) ?? null;
}

export async function getOrgRole(db: DB, userId: string, orgId: string): Promise<Role | null> {
  const row = await db
    .select({ role: schema.organisationMembers.role })
    .from(schema.organisationMembers)
    .where(
      and(
        eq(schema.organisationMembers.orgId, orgId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .get();
  return (row?.role as Role) ?? null;
}

/**
 * Every user gets one personal workspace. Returns its id, creating it on first use.
 */
export async function ensurePersonalOrg(db: DB, userId: string): Promise<string> {
  const existing = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .innerJoin(
      schema.organisationMembers,
      eq(schema.organisationMembers.orgId, schema.organisations.id)
    )
    .where(
      and(
        eq(schema.organisations.isPersonal, true),
        eq(schema.organisations.createdBy, userId),
        eq(schema.organisationMembers.userId, userId)
      )
    )
    .get();
  if (existing) {
    return existing.id;
  }

  const user = await db
    .select({ name: schema.users.name, email: schema.users.email, kind: schema.users.kind })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (user?.kind === 'bot') {
    throw new AccessError('Bots cannot have personal workspaces');
  }

  const orgId = uuidv4();
  const name = user?.name || user?.email?.split('@')[0] || 'Personal';
  const now = new Date().toISOString();
  await db.insert(schema.organisations).values({
    id: orgId,
    name,
    slug: `${generateSlug(name)}-${orgId.slice(0, 6)}`,
    isPersonal: true,
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
  return orgId;
}

export async function createProjectInOrg(
  db: DB,
  userId: string,
  orgId: string,
  name: string,
  description?: string | null
) {
  if ((await getUserKind(db, userId)) === 'bot') {
    throw new AccessError('Bots cannot create projects');
  }
  const role = await getOrgRole(db, userId, orgId);
  if (!canEdit(role)) {
    throw new AccessError('You cannot add projects to this workspace');
  }
  const now = new Date().toISOString();
  const project = {
    id: uuidv4(),
    orgId,
    key: generateProjectKey(name),
    name: name.trim(),
    description: description ?? null,
    leadUserId: userId,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.projects).values(project);
  return project;
}

/**
 * Turn a category name ("Acme Solar") into a project the user can write to.
 * Prefers an exact match the user can edit; if none exists and createIfMissing is set,
 * creates the project in the user's personal workspace.
 */
export async function resolveProjectForWrite(
  db: DB,
  userId: string,
  categoryName: string | null | undefined,
  createIfMissing = true
): Promise<AccessibleProject> {
  const name = (categoryName || '').trim() || 'General';
  const all = await getAccessibleProjects(db, userId);
  const matches = matchingProjectsForCategory(all, name);
  const editable = matches.find((p) => canEdit(p.role));
  if (editable) {
    return editable;
  }
  if (matches.length > 0) {
    throw new AccessError(`You have view-only access to "${matches[0].name}"`);
  }
  if (!createIfMissing) {
    throw new AccessError(`No project called "${name}"`, 404);
  }
  const bot = await db
    .select({ kind: schema.users.kind, botOrgId: schema.users.botOrgId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (bot?.kind === 'bot') {
    const workspace = bot.botOrgId
      ? await db
          .select({ name: schema.organisations.name })
          .from(schema.organisations)
          .where(eq(schema.organisations.id, bot.botOrgId))
          .get()
      : null;
    throw new AccessError(
      `Bots can only add tasks to projects in "${workspace?.name ?? 'their workspace'}"`
    );
  }
  const orgId = await ensurePersonalOrg(db, userId);
  await createProjectInOrg(db, userId, orgId, name);
  const created = (await getAccessibleProjects(db, userId)).find(
    (p) => p.orgId === orgId && p.name.toLowerCase() === name.toLowerCase()
  );
  if (!created) {
    throw new Error('Failed to create project');
  }
  return created;
}

/** Map of user id -> display name, for attribution. */
export async function getUserNames(db: DB, ids: Array<string | null | undefined>) {
  const people = await getPeople(db, ids);
  return new Map(Array.from(people, ([id, person]) => [id, person.name ?? 'Someone']));
}
