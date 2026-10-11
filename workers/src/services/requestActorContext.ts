import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

export type ActorVia = 'web' | 'token' | 'owner_secret' | 'system';

export interface ActorContext {
  readonly via: ActorVia;
  readonly viaDetail?: string;
}

type DB = DrizzleD1Database<typeof schema>;
const contexts = new WeakMap<object, ActorContext>();

export function bindActorContext(db: DB, context: ActorContext): void {
  contexts.set(db as object, Object.freeze({ ...context }));
}

export function getActorContext(db: DB): ActorContext | null {
  return contexts.get(db as object) ?? null;
}

export function clearActorContext(db: DB): void {
  contexts.delete(db as object);
}

export async function withActorContext<T>(
  db: DB,
  context: ActorContext,
  work: () => Promise<T>
): Promise<T> {
  const previous = getActorContext(db);
  bindActorContext(db, context);
  try {
    return await work();
  } finally {
    if (previous) {
      bindActorContext(db, previous);
    } else {
      clearActorContext(db);
    }
  }
}
