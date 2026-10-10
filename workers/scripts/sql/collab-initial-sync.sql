-- ONE-SHOT: copy the legacy single-user tables (Projects_Legacy, ProjectUpdates) into the
-- multi-user tables (Organisations, Projects, Tasks, TaskUpdates, TaskUserGoals). Run once,
-- after 0006 and immediately before deploying the multi-user API.
--
-- Do NOT re-run once the new API is live: it rebuilds goal links and re-inserts notes from the
-- legacy tables and matches projects by name. For writes the old API made during the deploy
-- window, use collab-catchup-sync.template.sql instead.
-- Instance-specific workspace, project-renaming and stale-project cleanup is not included.

-- 1. Personal workspaces --------------------------------------------------------------------

INSERT INTO Organisations (id, name, slug, is_personal, created_by, created_at, updated_at)
SELECT 'org-personal-' || replace(u.id, 'google-oauth2|', ''),
       coalesce(u.name, u.email),
       'personal-' || replace(u.id, 'google-oauth2|', ''),
       1, u.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM Users u
WHERE NOT EXISTS (SELECT 1 FROM Organisations o WHERE o.created_by = u.id AND o.is_personal = 1);

INSERT INTO OrganisationMembers (id, org_id, user_id, role, created_at, updated_at)
SELECT 'mem-' || o.id, o.id, o.created_by, 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM Organisations o
WHERE o.is_personal = 1
  AND NOT EXISTS (SELECT 1 FROM OrganisationMembers m WHERE m.org_id = o.id AND m.user_id = o.created_by);

-- 2. One project per legacy category (and epic category) ------------------------------------

INSERT INTO Projects (id, org_id, key, name, lead_user_id, is_archived, created_at, updated_at)
SELECT 'proj-' || lower(hex(randomblob(8))),
       (SELECT o.id FROM Organisations o WHERE o.created_by = c.user_id AND o.is_personal = 1),
       upper(substr(replace(c.cat, ' ', ''), 1, 3)),
       c.cat, c.user_id, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT user_id, min(cat) AS cat FROM (
    SELECT user_id, coalesce(nullif(trim(category), ''), 'General') AS cat FROM Projects_Legacy
    UNION ALL
    SELECT user_id, trim(category) FROM Epics WHERE category IS NOT NULL AND trim(category) != ''
  ) GROUP BY user_id, lower(cat)
) c
WHERE NOT EXISTS (
  SELECT 1 FROM Projects p
  JOIN OrganisationMembers m ON m.org_id = p.org_id AND m.user_id = c.user_id AND m.role = 'owner'
  WHERE lower(p.name) = lower(c.cat)
);

-- 3. Tasks ----------------------------------------------------------------------------------
INSERT INTO Tasks (id, project_id, epic_id, reporter_id, assignee_id, title, reason, status,
                   priority, size, notes, status_last_changed_on, await_until, gmail_thread_id,
                   is_deleted, created_at, updated_at, customer, tags, updated_by)
SELECT l.id,
       (SELECT p.id FROM Projects p
          JOIN OrganisationMembers m ON m.org_id = p.org_id AND m.user_id = l.user_id AND m.role = 'owner'
          JOIN Organisations o ON o.id = p.org_id
         WHERE lower(p.name) = lower(coalesce(nullif(trim(l.category), ''), 'General'))
         ORDER BY o.is_personal DESC, p.created_at
         LIMIT 1),
       l.epic_id, l.user_id, l.user_id, l.project, l.reason, l.status,
       l.priority, l.size, l.notes, l.status_last_changed_on, l.await_until, l.gmail_thread_id,
       coalesce(l.is_deleted, 0), l.created_at, l.updated_at, l.customer, l.tags, NULL
FROM Projects_Legacy l
WHERE true
ON CONFLICT(id) DO UPDATE SET
  project_id = excluded.project_id,
  epic_id = excluded.epic_id,
  title = excluded.title,
  reason = excluded.reason,
  status = excluded.status,
  priority = excluded.priority,
  size = excluded.size,
  notes = excluded.notes,
  status_last_changed_on = excluded.status_last_changed_on,
  await_until = excluded.await_until,
  gmail_thread_id = excluded.gmail_thread_id,
  is_deleted = excluded.is_deleted,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  customer = excluded.customer,
  tags = excluded.tags,
  assignee_id = coalesce(Tasks.assignee_id, excluded.assignee_id),
  updated_by = NULL
WHERE Tasks.updated_by IS NULL
   OR datetime(excluded.updated_at) > datetime(Tasks.updated_at);

-- 4. Notes ----------------------------------------------------------------------------------
INSERT INTO TaskUpdates (id, task_id, author_id, note, gmail_thread_id, created_at, updated_at)
SELECT pu.id, pu.project_id, pu.user_id, pu.note, pu.gmail_thread_id, pu.created_at, pu.updated_at
FROM ProjectUpdates pu
WHERE pu.project_id IN (SELECT id FROM Tasks)
ON CONFLICT(id) DO NOTHING;

-- 5. Personal life-goal links, for tasks still owned by the legacy sync ---------------------
DELETE FROM TaskUserGoals
WHERE task_id IN (SELECT t.id FROM Tasks t JOIN Projects_Legacy l ON l.id = t.id WHERE t.updated_by IS NULL)
  AND user_id = (SELECT l.user_id FROM Projects_Legacy l WHERE l.id = TaskUserGoals.task_id);

INSERT OR IGNORE INTO TaskUserGoals (task_id, user_id, goal_id, created_at)
SELECT l.id, l.user_id, l.goal_id, CURRENT_TIMESTAMP
FROM Projects_Legacy l
JOIN Tasks t ON t.id = l.id
WHERE t.updated_by IS NULL
  AND l.goal_id IS NOT NULL
  AND l.goal_id IN (SELECT id FROM Goals);

-- 6. Epics belong to projects ---------------------------------------------------------------
UPDATE Epics SET project_id = (
  SELECT p.id FROM Projects p
  JOIN OrganisationMembers m ON m.org_id = p.org_id AND m.user_id = Epics.user_id AND m.role = 'owner'
  WHERE lower(p.name) = lower(trim(Epics.category))
  LIMIT 1
)
WHERE project_id IS NULL AND category IS NOT NULL AND trim(category) != '';

-- 7. Rebuild full-text search ---------------------------------------------------------------
DELETE FROM Tasks_FTS;
INSERT INTO Tasks_FTS (task_id, title, reason, notes, customer, tags, update_notes)
SELECT t.id, t.title, coalesce(t.reason, ''), coalesce(t.notes, ''), coalesce(t.customer, ''),
       coalesce(t.tags, ''),
       coalesce((SELECT group_concat(u.note, ' ') FROM TaskUpdates u WHERE u.task_id = t.id), '')
FROM Tasks t;
