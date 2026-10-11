import type { SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { DrizzleD1Database, SQLiteD1Session } from 'drizzle-orm/d1';
import type { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema';

type DB = DrizzleD1Database<typeof schema>;

/** D1 batch accepts prepared statements, not SQLiteRaw's per-query `all` or `run` results. */
export function preparedSqlBatchItem(
  db: DB,
  query: SQL,
  method: 'all' | 'run'
): BatchItem<'sqlite'> {
  const internalDb = db as DB & {
    dialect: SQLiteAsyncDialect;
    session: SQLiteD1Session<typeof schema, any>;
  };
  const prepared = internalDb.session.prepareQuery(
    internalDb.dialect.sqlToQuery(query),
    undefined,
    method,
    false
  );
  return {
    _: { dialect: 'sqlite', result: undefined },
    _prepare: () => prepared,
  } as BatchItem<'sqlite'> & { _prepare: () => typeof prepared };
}
