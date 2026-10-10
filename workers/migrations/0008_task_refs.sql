-- Migration: 0008_task_refs.sql
-- Typed references from a task to things outside TimDo (issues, posts, mail, members).
-- org_id copies the task's workspace so lookups and the one-source-per-workspace rule are one index.
CREATE TABLE IF NOT EXISTS TaskRefs (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_refs_task_role_ref ON TaskRefs(task_id, role, kind, ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_refs_org_source ON TaskRefs(org_id, kind, ref) WHERE role = 'source';
CREATE INDEX IF NOT EXISTS idx_task_refs_lookup ON TaskRefs(org_id, kind, ref);
CREATE INDEX IF NOT EXISTS idx_task_refs_task ON TaskRefs(task_id);

-- Existing Gmail threads become link refs
INSERT OR IGNORE INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, created_by, created_at)
SELECT lower(hex(randomblob(16))), t.id, p.org_id, 'link', 'gmail.thread', trim(t.gmail_thread_id),
       'https://mail.google.com/mail/u/0/#all/' || trim(t.gmail_thread_id), t.reporter_id, t.created_at
FROM Tasks t JOIN Projects p ON p.id = t.project_id
WHERE t.gmail_thread_id IS NOT NULL AND trim(t.gmail_thread_id) <> '';
