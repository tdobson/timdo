import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import type { UserCreatePayload } from '../validators/userValidators';
import { AccessError, ensurePersonalOrg } from './accessService';
import { claimPendingInvites } from './organisationService';
import { withActorContext } from './requestActorContext';

type DB = DrizzleD1Database<typeof schema>;

/**
 * Called on every sign-in. Creates or refreshes the user, makes sure they have a personal
 * workspace, and turns any invites sent to their email into memberships.
 */
export async function ensureUser(db: DB, data: UserCreatePayload) {
  if (
    data.id.toLowerCase().startsWith('bot|') ||
    (data.email.toLowerCase().startsWith('bot+') &&
      data.email.toLowerCase().endsWith('@bots.timdo.invalid'))
  ) {
    throw new AccessError('Reserved bot identities cannot be provisioned as people');
  }
  const { emailVerified: _verified, ...profile } = data;
  return withActorContext(db, { via: 'system' }, async () => {
    const user = await upsertUser(db, profile);
    if (user) {
      try {
        await ensurePersonalOrg(db, user.id);
        if (data.emailVerified) {
          await claimPendingInvites(db, user.id, user.email);
        }
      } catch (err) {
        console.error('[ensureUser] workspace setup failed', err);
      }
    }
    return user;
  });
}

async function upsertUser(db: DB, data: UserCreatePayload) {
  // Check if user exists by ID
  const existingUser = await db.query.users.findFirst({
    where: eq(schema.users.id, data.id),
  });

  if (existingUser) {
    // Only update if email or name actually changed to avoid unnecessary D1 writes (and limit breaches)
    if (existingUser.name === data.name && existingUser.email === data.email) {
      return existingUser;
    }

    try {
      const result = await db
        .update(schema.users)
        .set({
          name: data.name,
          email: data.email,
        })
        .where(eq(schema.users.id, data.id))
        .returning();
      return result[0] || existingUser;
    } catch (err) {
      console.warn('Failed to update existing user in D1 (possibly write limit):', err);
      return existingUser;
    }
  }

  // User doesn't exist, create new
  const newUser = {
    id: data.id,
    email: data.email,
    name: data.name,
  };
  const result = await db.insert(schema.users).values(newUser).returning();
  return result[0];
}
