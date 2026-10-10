import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { v4 as uuidv4 } from 'uuid';
import * as schema from '../db/schema';

type DB = DrizzleD1Database<typeof schema>;

export interface MigrationResult {
  organisation: {
    id: string;
    name: string;
    slug: string;
  };
  migratedProjectsCount: number;
  migratedTasksCount: number;
}

/**
 * Generate a project key from project name (e.g. "Northstar Labs" -> "NLX", "Field Team" -> "FTX", "Maple Grove Research" -> "MGR")
 */
export function generateProjectKey(name: string): string {
  const cleaned = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const w1 = words[0];
    const w2 = words[1];
    const w3 = words[2];
    if (w3) {
      return (w1[0] + w2[0] + w3[0]).slice(0, 4);
    }
    return (w1[0] + w2[0] + 'X').slice(0, 4);
  }
  if (cleaned.length >= 3) {
    return cleaned.slice(0, 3);
  }
  return (cleaned + 'PRJ').slice(0, 3);
}

/**
 * Generate a slug from an organisation name
 */
export function generateSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'personal'
  );
}

/**
 * Run idempotent migration for a user:
 * 1. Ensures personal organisation exists (creates one if not present)
 * 2. Ensures user is member with role 'owner'
 * 3. Migrates legacy categories to Projects under the personal organisation
 * 4. Migrates legacy Projects rows into Tasks, preserving all properties
 * 5. Migrates legacy goalId links into TaskUserGoals
 */
export async function runMultiUserMigration(db: DB, userId: string): Promise<MigrationResult> {
  // 1. Check if user already has an organisation where they are owner
  let existingMember = await (db.select
    ? db
        .select()
        .from(schema.organisationMembers)
        .where(
          and(
            eq(schema.organisationMembers.userId, userId),
            eq(schema.organisationMembers.role, 'owner')
          )
        )
        .get?.()
    : null);

  let org: { id: string; name: string; slug: string };

  if (existingMember) {
    const foundOrg = await db
      .select()
      .from(schema.organisations)
      .where(eq(schema.organisations.id, existingMember.orgId))
      .get();
    org = foundOrg || { id: existingMember.orgId, name: 'Personal Workspace', slug: 'personal' };
  } else {
    // Check if user exists to get name
    const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();

    const orgName = user?.name ? `${user.name}` : 'Personal Workspace';
    const baseSlug = generateSlug(orgName);
    const orgId = uuidv4();
    const slug = `${baseSlug}-${orgId.slice(0, 6)}`;

    // Create organisation
    await db.insert(schema.organisations).values({
      id: orgId,
      name: orgName,
      slug,
      createdBy: userId,
    });

    // Add user as owner in organisationMembers
    await db.insert(schema.organisationMembers).values({
      id: uuidv4(),
      orgId,
      userId,
      role: 'owner',
    });

    org = { id: orgId, name: orgName, slug };
  }

  // 2. Query legacy projects (which are single-user tasks)
  const legacyRows =
    (await (db.select() as any)
      .from(schema.legacyProjects)
      .where(eq(schema.legacyProjects.userId, userId))
      .all?.()) || [];

  // Group by category to create projects
  const categoryMap = new Map<string, string>(); // category -> projectId
  let migratedProjectsCount = 0;
  let migratedTasksCount = 0;

  // Find existing projects in this org
  const existingProjects =
    (await db.select().from(schema.projects).where(eq(schema.projects.orgId, org.id)).all?.()) ||
    [];

  for (const proj of existingProjects) {
    if (proj && proj.name) {
      categoryMap.set(proj.name.toLowerCase(), proj.id);
    }
  }

  // Identify all distinct categories in legacy data
  const categories = new Set<string>();
  for (const row of legacyRows) {
    const cat = row.category?.trim() || 'General';
    categories.add(cat);
  }

  // Ensure default "General" exists if needed
  if (categories.size === 0) {
    categories.add('General');
  }

  // Create projects for any category that doesn't have a project yet
  for (const cat of categories) {
    if (!categoryMap.has(cat.toLowerCase())) {
      const projId = uuidv4();
      const projKey = generateProjectKey(cat);
      await db.insert(schema.projects).values({
        id: projId,
        orgId: org.id,
        key: projKey,
        name: cat,
        leadUserId: userId,
      });
      categoryMap.set(cat.toLowerCase(), projId);
      migratedProjectsCount++;
    }
  }

  // 3. Migrate each legacy task into the Tasks table
  for (const row of legacyRows) {
    // Check if task already migrated
    const existingTask = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, row.id))
      .get?.();

    if (!existingTask) {
      const cat = row.category?.trim() || 'General';
      const projectId = categoryMap.get(cat.toLowerCase())!;

      await db.insert(schema.tasks).values({
        id: row.id,
        projectId,
        epicId: row.epicId || null,
        reporterId: userId,
        assigneeId: userId, // Default assignment to current user
        title: row.project,
        reason: row.reason || null,
        status: row.status || 'do',
        priority: row.priority ?? 5,
        size: row.size || '***',
        notes: row.notes || null,
        statusLastChangedOn: row.statusLastChangedOn || null,
        awaitUntil: row.awaitUntil || null,
        gmailThreadId: row.gmailThreadId || null,
        isDeleted: row.isDeleted ?? false,
      });

      // If there was a goalId, migrate it to taskUserGoals
      if (row.goalId) {
        await db.insert(schema.taskUserGoals).values({
          taskId: row.id,
          userId,
          goalId: row.goalId,
        });
      }

      migratedTasksCount++;
    }
  }

  return {
    organisation: org,
    migratedProjectsCount,
    migratedTasksCount,
  };
}
