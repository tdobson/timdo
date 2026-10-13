/**
 * Real-SQL test database: node:sqlite in memory, loaded with the live D1 schema
 * (fixtures/live-schema.sql) plus pending migrations, wrapped in drizzle's sqlite-proxy
 * so services run their actual queries.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../../db/schema';

// Vite doesn't know node:sqlite yet, so load it through Node's own require.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: any };
type DatabaseSync = any;

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'live-schema.sql');
const MIGRATIONS = path.join(__dirname, '..', '..', '..', 'migrations');
export const PENDING_MIGRATIONS = [
  '0006_collaboration.sql',
  '0007_api_tokens.sql',
  '0008_task_refs.sql',
  '0009_report_note_dedupe.sql',
  '0010_bots_and_via.sql',
  '0011_activity_sequence.sql',
];

export const TIM = 'user-tim';
export const ROBIN = 'user-robin';
export const STRANGER = 'user-stranger';

/** Run one migration file against a raw database (e.g. to test a backfill on older data). */
export function applyMigration(raw: DatabaseSync, file: string) {
  raw.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
}

/**
 * `stats.queries` counts statements sent by services. Each statement records its full bind count,
 * SQL text and result-row count. Result rows are not a measure of rows scanned by SQLite.
 */
export function createTestDb({ migrations = PENDING_MIGRATIONS } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(fs.readFileSync(FIXTURE, 'utf8'));
  for (const file of migrations) {
    applyMigration(raw, file);
  }
  const stats = {
    queries: 0,
    maxBindings: 0,
    rowsReturned: 0,
    statements: [] as Array<{
      sql: string;
      method: string;
      parameterCount: number;
      rowsReturned: number;
    }>,
    reset() {
      this.queries = 0;
      this.maxBindings = 0;
      this.rowsReturned = 0;
      this.statements.length = 0;
    },
  };

  const execute = (query: string, params: any[], method: string) => {
    stats.queries++;
    stats.maxBindings = Math.max(stats.maxBindings, params.length);
    if (params.length > 100) {
      throw new Error(`Test database bind ceiling exceeded: ${params.length} parameters`);
    }
    const stmt = raw.prepare(query);
    const args = (params as any[]).map((param) =>
      typeof param === 'boolean' ? Number(param) : param
    );
    let result: any;
    if (method === 'run') {
      stmt.run(...args);
      result = { rows: [] };
    } else {
      // Positional rows: joins return duplicate column names that objects would collapse
      stmt.setReturnArrays(true);
      if (method === 'get') {
        result = { rows: stmt.get(...args) } as any;
      } else {
        result = { rows: stmt.all(...args) };
      }
    }
    const rowsReturned =
      method === 'run' ? 0 : method === 'get' ? Number(!!result.rows) : result.rows.length;
    stats.rowsReturned += rowsReturned;
    stats.statements.push({ sql: query, method, parameterCount: params.length, rowsReturned });
    return result;
  };

  const db = drizzle(
    async (query, params, method) => execute(query, params, method),
    // D1 runs a batch as one transaction: all of it lands, or none of it
    async (queries) => {
      raw.exec('BEGIN');
      try {
        const results = queries.map((query) => {
          const result = execute(query.sql, query.params, query.method);
          // Batched 'get' results are read as rows[0]
          return query.method === 'get' ? { rows: [result.rows] } : result;
        });
        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    { schema }
  );

  return { db: db as any, raw, stats };
}

/** The owner has a personal workspace and a shared one; a member belongs to the shared one. */
export function seedCollaboration(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO Users (id, email, name) VALUES
      ('${TIM}', 'casey@example.test', 'Casey Example'),
      ('${ROBIN}', 'jordan@example.test', 'Jordan Example'),
      ('${STRANGER}', 'stranger@example.com', 'Stranger');
    INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES
      ('org-tim', 'Casey Example', 'casey-example', '${TIM}', 1),
      ('org-md', 'Northstar Workshop', 'northstar-workshop', '${TIM}', 0),
      ('org-stranger', 'Stranger', 'stranger', '${STRANGER}', 1);
    INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES
      ('m1', 'org-tim', '${TIM}', 'owner'),
      ('m2', 'org-md', '${TIM}', 'owner'),
      ('m3', 'org-md', '${ROBIN}', 'member'),
      ('m4', 'org-stranger', '${STRANGER}', 'owner');
    INSERT INTO Projects (id, org_id, key, name) VALUES
      ('proj-personal', 'org-tim', 'PER', 'Personal'),
      ('proj-acme-solar', 'org-md', 'ACS', 'Acme Solar'),
      ('proj-md', 'org-md', 'NSW', 'Northstar Workshop'),
      ('proj-stranger', 'org-stranger', 'STR', 'Outside Projects');
  `);
}
