// Build a local SQLite DB: live schema + backup data + pending migrations + legacy sync +
// a demo shared workspace. Usage: node scripts/build-local-db.mjs <backupDir> <sqliteFile>
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [backupDir, file] = process.argv.slice(2);
const db = new DatabaseSync(file);
for (const t of db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_cf_%'").all()) {
  db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
}
db.exec(fs.readFileSync('src/__tests__/fixtures/live-schema.sql', 'utf8'));
db.exec('PRAGMA foreign_keys=OFF');
for (const t of ['Users', 'Organisations', 'OrganisationMembers', 'Projects', 'Goals', 'Epics',
  'Projects_Legacy', 'ProjectUpdates', 'Tasks', 'TaskUpdates', 'TaskUserGoals', 'TaskRelations']) {
  const p = `${backupDir}/${t}.sql`;
  if (!fs.existsSync(p)) continue;
  db.exec(fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.startsWith('INSERT')).join('\n'));
}
db.exec('PRAGMA foreign_keys=ON');
db.exec(fs.readFileSync('migrations/0006_collaboration.sql', 'utf8'));
db.exec(fs.readFileSync('migrations/0007_api_tokens.sql', 'utf8'));
db.exec(fs.readFileSync('migrations/0011_activity_sequence.sql', 'utf8'));
db.exec(fs.readFileSync('scripts/sql/collab-initial-sync.sql', 'utf8'));
if (fs.existsSync('scripts/sql/demo-share-migrating-dragons.sql')) {
  db.exec(fs.readFileSync('scripts/sql/demo-share-migrating-dragons.sql', 'utf8'));
}
console.log(db.prepare('select (select count(*) from Tasks) tasks, (select count(*) from Organisations) orgs').get());
