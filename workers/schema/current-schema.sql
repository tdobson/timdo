-- TimDo D1 schema snapshot, taken from production on 2026-10-08 after migrations 0000-0007,
-- with 0008 (TaskRefs) and 0009 (report-note dedupe) folded in by hand.
-- Use this to create a fresh database (the early migrations don't replay cleanly from empty).

CREATE TABLE ActivityLog (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES Users(id) ON DELETE SET NULL,
  org_id TEXT REFERENCES Organisations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES Projects(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL, -- 'task' | 'epic' | 'note' | 'project' | 'organisation' | 'member'
  entity_id TEXT NOT NULL,
  task_id TEXT, -- set for task and note events so a task timeline is one query
  epic_id TEXT,
  action TEXT NOT NULL, -- 'created' | 'updated' | 'status_changed' | 'assigned' | 'deleted' | ...
  summary TEXT NOT NULL,
  changes TEXT, -- JSON: { field: { from, to } }
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ApiTokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL, -- first characters, for recognising a token in the list
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE Epics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  goal_id TEXT REFERENCES Goals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active', 
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
, project_id TEXT REFERENCES Projects(id) ON DELETE SET NULL, updated_by TEXT REFERENCES Users(id) ON DELETE SET NULL);

CREATE TABLE Goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, 
  title TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE OrganisationInvites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES Organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', 
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
, accepted_by TEXT REFERENCES Users(id) ON DELETE SET NULL, accepted_at TEXT);

CREATE TABLE OrganisationMembers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES Organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', 
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE Organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
, is_personal INTEGER NOT NULL DEFAULT 0);

CREATE TABLE ProjectUpdates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  gmail_thread_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES "Projects_Legacy"(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

CREATE TABLE "Projects" (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES Organisations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  lead_user_id TEXT REFERENCES Users(id) ON DELETE SET NULL,
  is_archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Projects_Legacy" (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'do' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`size` text DEFAULT '***' NOT NULL,
	`notes` text,
	`status_last_changed_on` text,
	`is_deleted` integer DEFAULT false,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP, await_until text, gmail_thread_id TEXT, category TEXT, epic_id TEXT REFERENCES Epics(id) ON DELETE SET NULL, goal_id TEXT REFERENCES Goals(id) ON DELETE SET NULL, customer TEXT, tags TEXT,
	FOREIGN KEY (`user_id`) REFERENCES `Users`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE TaskRelations (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'relates_to', -- 'relates_to' | 'blocks' | 'blocked_by' | 'duplicates'
  reason TEXT,
  created_by TEXT REFERENCES Users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_task_id, target_task_id, relation_type)
);

CREATE TABLE TaskRefs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES Tasks(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES Organisations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'link' CHECK (role IN ('link','source','reported_by','about')),
  kind TEXT NOT NULL, -- 'github.issue', 'gmail.thread', 'url', 'acme.member', ...
  ref TEXT NOT NULL, -- the id inside that kind; canonical form is kind:ref
  url TEXT,
  label TEXT, -- display text only, never written to the activity log
  created_by TEXT REFERENCES Users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE TaskUpdates (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES Tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  gmail_thread_id TEXT,
  dedupe_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE TaskUserGoals (
  task_id TEXT NOT NULL REFERENCES Tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES Goals(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, user_id, goal_id)
);

CREATE TABLE Tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES "Projects"(id) ON DELETE CASCADE,
  epic_id TEXT REFERENCES Epics(id) ON DELETE SET NULL,
  reporter_id TEXT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
  assignee_id TEXT REFERENCES Users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'do', 
  priority INTEGER NOT NULL DEFAULT 5,
  size TEXT NOT NULL DEFAULT '***',
  notes TEXT,
  status_last_changed_on TEXT,
  await_until TEXT,
  gmail_thread_id TEXT,
  is_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
, customer TEXT, tags TEXT, updated_by TEXT REFERENCES Users(id) ON DELETE SET NULL);

CREATE VIRTUAL TABLE Tasks_FTS USING fts5(
  task_id UNINDEXED,
  title,
  reason,
  notes,
  customer,
  tags,
  update_notes,
  tokenize='porter unicode61'
);

CREATE TABLE `Users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX `Users_email_unique` ON `Users` (`email`);

CREATE INDEX idx_activity_epic ON ActivityLog(epic_id, created_at);

CREATE INDEX idx_activity_org ON ActivityLog(org_id, created_at);

CREATE INDEX idx_activity_project ON ActivityLog(project_id, created_at);

CREATE INDEX idx_activity_task ON ActivityLog(task_id, created_at);

CREATE INDEX idx_api_tokens_user ON ApiTokens(user_id);

CREATE INDEX idx_epics_category ON Epics(category);

CREATE INDEX idx_epics_goal_id ON Epics(goal_id);

CREATE INDEX idx_epics_project_id ON Epics(project_id);

CREATE INDEX idx_epics_user_id ON Epics(user_id);

CREATE INDEX idx_goals_type ON Goals(type);

CREATE INDEX idx_goals_user_id ON Goals(user_id);

CREATE INDEX idx_legacy_projects_customer ON Projects_Legacy(customer);

CREATE INDEX idx_org_invites_email ON OrganisationInvites(email);

CREATE INDEX idx_org_invites_org_id ON OrganisationInvites(org_id);

CREATE INDEX idx_org_invites_token ON OrganisationInvites(token);

CREATE INDEX idx_org_members_org_id ON OrganisationMembers(org_id);

CREATE UNIQUE INDEX idx_org_members_org_user ON OrganisationMembers(org_id, user_id);

CREATE INDEX idx_org_members_user_id ON OrganisationMembers(user_id);

CREATE INDEX idx_organisations_created_by ON Organisations(created_by);

CREATE INDEX idx_organisations_slug ON Organisations(slug);

CREATE INDEX idx_project_updates_project_id ON ProjectUpdates (project_id);

CREATE INDEX idx_project_updates_user_id ON ProjectUpdates (user_id);

CREATE INDEX idx_projects_category ON "Projects_Legacy"(category);

CREATE INDEX idx_projects_epic_id ON "Projects_Legacy"(epic_id);

CREATE INDEX idx_projects_goal_id ON "Projects_Legacy"(goal_id);

CREATE INDEX idx_projects_key ON "Projects"(org_id, key);

CREATE INDEX idx_projects_org_id ON "Projects"(org_id);

CREATE INDEX idx_task_relations_source ON TaskRelations(source_task_id);

CREATE INDEX idx_task_relations_target ON TaskRelations(target_task_id);

CREATE INDEX idx_task_refs_lookup ON TaskRefs(org_id, kind, ref);

CREATE UNIQUE INDEX idx_task_refs_org_source ON TaskRefs(org_id, kind, ref) WHERE role = 'source';

CREATE INDEX idx_task_refs_task ON TaskRefs(task_id);

CREATE UNIQUE INDEX idx_task_refs_task_role_ref ON TaskRefs(task_id, role, kind, ref);

CREATE INDEX idx_task_updates_author_id ON TaskUpdates(author_id);

CREATE INDEX idx_task_updates_task_id ON TaskUpdates(task_id);

CREATE UNIQUE INDEX idx_task_updates_dedupe_key
  ON TaskUpdates(task_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_task_user_goals_goal ON TaskUserGoals(goal_id);

CREATE INDEX idx_task_user_goals_user ON TaskUserGoals(user_id);

CREATE INDEX idx_tasks_assignee_id ON Tasks(assignee_id);

CREATE INDEX idx_tasks_customer ON Tasks(customer);

CREATE INDEX idx_tasks_epic_id ON Tasks(epic_id);

CREATE INDEX idx_tasks_project_id ON Tasks(project_id);

CREATE INDEX idx_tasks_reporter_id ON Tasks(reporter_id);

CREATE INDEX idx_tasks_status ON Tasks(status);

CREATE TRIGGER trg_task_updates_fts_delete AFTER DELETE ON TaskUpdates BEGIN
  UPDATE Tasks_FTS SET update_notes = coalesce(
    (SELECT group_concat(note, ' ') FROM TaskUpdates WHERE task_id = old.task_id), '')
  WHERE task_id = old.task_id;
END;

CREATE TRIGGER trg_task_updates_fts_insert AFTER INSERT ON TaskUpdates BEGIN
  UPDATE Tasks_FTS SET
    update_notes = coalesce(update_notes, '') || ' ' || new.note
  WHERE task_id = new.task_id;
END;

CREATE TRIGGER trg_task_updates_fts_update AFTER UPDATE OF note, task_id ON TaskUpdates BEGIN
  UPDATE Tasks_FTS SET update_notes = coalesce(
    (SELECT group_concat(note, ' ') FROM TaskUpdates WHERE task_id = old.task_id), '')
  WHERE task_id = old.task_id;
  UPDATE Tasks_FTS SET update_notes = coalesce(
    (SELECT group_concat(note, ' ') FROM TaskUpdates WHERE task_id = new.task_id), '')
  WHERE task_id = new.task_id;
END;

CREATE TRIGGER trg_tasks_fts_delete AFTER DELETE ON Tasks BEGIN
  DELETE FROM Tasks_FTS WHERE task_id = old.id;
END;

CREATE TRIGGER trg_tasks_fts_insert AFTER INSERT ON Tasks BEGIN
  INSERT INTO Tasks_FTS (task_id, title, reason, notes, customer, tags, update_notes)
  VALUES (new.id, new.title, coalesce(new.reason, ''), coalesce(new.notes, ''), coalesce(new.customer, ''), coalesce(new.tags, ''), '');
END;

CREATE TRIGGER trg_tasks_fts_update AFTER UPDATE ON Tasks BEGIN
  UPDATE Tasks_FTS SET
    title = new.title,
    reason = coalesce(new.reason, ''),
    notes = coalesce(new.notes, ''),
    customer = coalesce(new.customer, ''),
    tags = coalesce(new.tags, '')
  WHERE task_id = old.id;
END;

