#!/usr/bin/env node
// Upgrade only a persisted Wrangler local D1 SQLite file. Never use this against a remote DB.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!databasePath || process.argv.length !== 3 || !databasePath.endsWith('.sqlite')) {
  throw new Error('Pass the path to a persisted local D1 .sqlite file');
}
if (!databasePath.split(path.sep).includes('.wrangler')) {
  throw new Error('The database path must be under a .wrangler local persistence directory');
}
if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
  throw new Error(`Local D1 database not found: ${databasePath}`);
}

const database = new DatabaseSync(databasePath);
try {
  database.exec('BEGIN IMMEDIATE');
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'TaskUpdates'")
    .get();
  if (!table) {
    throw new Error('TaskUpdates table is missing from the local D1 database');
  }

  const columns = database.prepare('PRAGMA table_info(TaskUpdates)').all();
  if (!columns.some((column) => column.name === 'dedupe_key')) {
    database.exec('ALTER TABLE TaskUpdates ADD COLUMN dedupe_key TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_updates_dedupe_key
      ON TaskUpdates(task_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL
  `);
  database.exec('COMMIT');
} catch (error) {
  try {
    database.exec('ROLLBACK');
  } catch {
    // A failed BEGIN or a closed transaction needs no further recovery.
  }
  throw error;
} finally {
  database.close();
}
