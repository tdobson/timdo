import { eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

type DB = DrizzleD1Database<typeof schema>;
export type PersonKind = 'human' | 'bot';

export interface PersonProjection {
  id: string;
  name: string | null;
  kind: PersonKind;
}

/** Load bounded, safe person display data without returning a bot's internal email. */
export async function getPeople(
  db: DB,
  ids: Array<string | null | undefined>
): Promise<Map<string, PersonProjection>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => !!id)));
  const people = new Map<string, PersonProjection>();
  for (let index = 0; index < unique.length; index += 90) {
    const chunk = unique.slice(index, index + 90);
    const rows = await db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        kind: schema.users.kind,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, chunk));
    for (const row of rows) {
      const kind: PersonKind = row.kind === 'bot' ? 'bot' : 'human';
      people.set(row.id, {
        id: row.id,
        kind,
        name: row.name || (kind === 'human' ? row.email : null),
      });
    }
  }
  return people;
}

export async function getPerson(db: DB, id: string): Promise<PersonProjection | null> {
  return (await getPeople(db, [id])).get(id) ?? null;
}

export async function getUserKind(db: DB, id: string): Promise<PersonKind | null> {
  const row = await db
    .select({ kind: schema.users.kind })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .get();
  if (!row) return null;
  return row.kind === 'bot' ? 'bot' : 'human';
}
