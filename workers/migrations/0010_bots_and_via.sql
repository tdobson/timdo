ALTER TABLE Users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'bot'));
ALTER TABLE Users ADD COLUMN bot_org_id TEXT REFERENCES Organisations(id) ON DELETE CASCADE;
ALTER TABLE Users ADD COLUMN created_by TEXT REFERENCES Users(id) ON DELETE SET NULL;
ALTER TABLE Users ADD COLUMN disabled_at TEXT;

ALTER TABLE ActivityLog ADD COLUMN via TEXT CHECK (via IN ('web', 'token', 'owner_secret', 'system'));
ALTER TABLE ActivityLog ADD COLUMN via_detail TEXT;

CREATE INDEX idx_users_bot_org_id ON Users(bot_org_id) WHERE kind = 'bot';
CREATE INDEX idx_activity_actor_task_created ON ActivityLog(actor_id, entity_type, action, created_at, project_id, org_id);

CREATE TRIGGER trg_users_bot_identity_insert
BEFORE INSERT ON Users
WHEN (NEW.kind = 'bot' AND (
    length(NEW.id) <= 4
    OR substr(NEW.id, 1, 4) != 'bot|'
    OR lower(NEW.email) != lower('bot+' || substr(NEW.id, 5) || '@bots.timdo.invalid')
    OR NEW.bot_org_id IS NULL
    OR EXISTS (SELECT 1 FROM Organisations o WHERE o.id = NEW.bot_org_id AND o.is_personal = 1)
    OR (NEW.created_by IS NOT NULL AND EXISTS (
      SELECT 1 FROM Users creator WHERE creator.id = NEW.created_by AND creator.kind = 'bot'
    ))
  ))
  OR (NEW.kind = 'human' AND (
    substr(lower(NEW.id), 1, 4) = 'bot|'
    OR lower(NEW.email) LIKE 'bot+%@bots.timdo.invalid'
  ))
BEGIN
  SELECT RAISE(ABORT, 'Reserved bot identity');
END;

CREATE TRIGGER trg_users_bot_identity_update
BEFORE UPDATE ON Users
WHEN OLD.kind != NEW.kind
  OR (OLD.kind = 'bot' AND (
    NEW.kind != 'bot'
    OR NEW.id != OLD.id
    OR lower(NEW.email) != lower(OLD.email)
    OR NEW.bot_org_id IS NOT OLD.bot_org_id
  ))
  OR (NEW.kind = 'human' AND (
    substr(lower(NEW.id), 1, 4) = 'bot|'
    OR lower(NEW.email) LIKE 'bot+%@bots.timdo.invalid'
  ))
BEGIN
  SELECT RAISE(ABORT, 'Bot identity is reserved');
END;

CREATE TRIGGER trg_users_bot_membership_create
AFTER INSERT ON Users
WHEN NEW.kind = 'bot' AND NEW.disabled_at IS NULL
BEGIN
  INSERT INTO OrganisationMembers (id, org_id, user_id, role, created_at, updated_at)
  VALUES (substr(NEW.id, 5), NEW.bot_org_id, NEW.id, 'member', NEW.created_at, NEW.updated_at);
END;

CREATE TRIGGER trg_users_bot_disabled_state
BEFORE UPDATE OF disabled_at ON Users
WHEN OLD.kind = 'bot' AND OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NOT OLD.disabled_at
BEGIN
  SELECT RAISE(ABORT, 'Disabled bot state is permanent');
END;

CREATE TRIGGER trg_users_bot_disable_cleanup
AFTER UPDATE OF disabled_at ON Users
WHEN OLD.kind = 'bot' AND OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
BEGIN
  UPDATE ApiTokens SET revoked_at = NEW.disabled_at
    WHERE user_id = NEW.id AND revoked_at IS NULL;
  DELETE FROM OrganisationMembers WHERE user_id = NEW.id AND org_id = NEW.bot_org_id;
END;

CREATE TRIGGER trg_users_no_active_bot_delete
BEFORE DELETE ON Users
WHEN OLD.kind = 'bot' AND OLD.disabled_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Disable the bot before deleting it');
END;

CREATE TRIGGER trg_bot_membership_insert
BEFORE INSERT ON OrganisationMembers
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  AND (
    NEW.org_id != (SELECT u.bot_org_id FROM Users u WHERE u.id = NEW.user_id)
    OR NEW.role NOT IN ('member', 'viewer')
    OR EXISTS (SELECT 1 FROM OrganisationMembers m WHERE m.user_id = NEW.user_id)
    OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.disabled_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'Invalid bot membership');
END;

CREATE TRIGGER trg_bot_membership_update
BEFORE UPDATE OF org_id, user_id, role ON OrganisationMembers
WHEN (
    EXISTS (SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.kind = 'bot')
    OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  )
  AND (
    NEW.user_id != OLD.user_id
    OR NEW.org_id != (SELECT u.bot_org_id FROM Users u WHERE u.id = OLD.user_id)
    OR NEW.role NOT IN ('member', 'viewer')
    OR EXISTS (
      SELECT 1 FROM OrganisationMembers m WHERE m.user_id = OLD.user_id AND m.id != OLD.id
    )
    OR EXISTS (SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.disabled_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'Invalid bot membership');
END;

CREATE TRIGGER trg_bot_membership_delete
BEFORE DELETE ON OrganisationMembers
WHEN EXISTS (
  SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.kind = 'bot' AND u.disabled_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Disable the bot before removing its membership');
END;

CREATE TRIGGER trg_tasks_no_bot_assignee_insert
BEFORE INSERT ON Tasks
WHEN NEW.assignee_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.assignee_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot be assigned tasks');
END;

CREATE TRIGGER trg_tasks_no_bot_assignee_update
BEFORE UPDATE OF assignee_id ON Tasks
WHEN NEW.assignee_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.assignee_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot be assigned tasks');
END;

CREATE TRIGGER trg_invites_no_reserved_bot_email
BEFORE INSERT ON OrganisationInvites
WHEN lower(NEW.email) LIKE 'bot+%@bots.timdo.invalid'
BEGIN
  SELECT RAISE(ABORT, 'Reserved bot address');
END;

CREATE TRIGGER trg_invites_no_reserved_bot_email_update
BEFORE UPDATE OF email ON OrganisationInvites
WHEN lower(NEW.email) LIKE 'bot+%@bots.timdo.invalid'
BEGIN
  SELECT RAISE(ABORT, 'Reserved bot address');
END;

CREATE TRIGGER trg_organisations_no_bot_creator_insert
BEFORE INSERT ON Organisations
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.created_by AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot create workspaces');
END;

CREATE TRIGGER trg_organisations_no_bot_creator_update
BEFORE UPDATE OF created_by ON Organisations
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.created_by AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot create workspaces');
END;

CREATE TRIGGER trg_projects_no_bot_lead_insert
BEFORE INSERT ON Projects
WHEN NEW.lead_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.lead_user_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot create projects');
END;

CREATE TRIGGER trg_projects_no_bot_lead_update
BEFORE UPDATE OF lead_user_id ON Projects
WHEN NEW.lead_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.lead_user_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots cannot create projects');
END;

CREATE TRIGGER trg_goals_no_bot_owner_insert
BEFORE INSERT ON Goals
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots do not have life goals');
END;

CREATE TRIGGER trg_goals_no_bot_owner_update
BEFORE UPDATE OF user_id ON Goals
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'Bots do not have life goals');
END;

CREATE TRIGGER trg_task_user_goals_no_bot_insert
BEFORE INSERT ON TaskUserGoals
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  OR EXISTS (
    SELECT 1 FROM Goals g JOIN Users u ON u.id = g.user_id
    WHERE g.id = NEW.goal_id AND u.kind = 'bot'
  )
BEGIN
  SELECT RAISE(ABORT, 'Bots do not have life goals');
END;

CREATE TRIGGER trg_task_user_goals_no_bot_update
BEFORE UPDATE ON TaskUserGoals
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  OR EXISTS (
    SELECT 1 FROM Goals g JOIN Users u ON u.id = g.user_id
    WHERE g.id = NEW.goal_id AND u.kind = 'bot'
  )
BEGIN
  SELECT RAISE(ABORT, 'Bots do not have life goals');
END;

CREATE TRIGGER trg_bot_epics_scope_insert
BEFORE INSERT ON Epics
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  AND (
    NEW.project_id IS NULL
    OR NEW.goal_id IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM Users bot
      JOIN Projects p ON p.id = NEW.project_id
      JOIN OrganisationMembers m ON m.org_id = p.org_id AND m.user_id = bot.id
      WHERE bot.id = NEW.user_id AND p.org_id = bot.bot_org_id AND m.role = 'member'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Bots can only create scoped epics in their workspace');
END;

CREATE TRIGGER trg_bot_epics_scope_update
BEFORE UPDATE OF user_id, project_id, goal_id ON Epics
WHEN EXISTS (SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.kind = 'bot')
  OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
  OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.updated_by AND u.kind = 'bot')
BEGIN
  -- Bot-created epics stay bot-owned and cannot acquire a personal goal, regardless of the editor.
  SELECT (CASE WHEN (
    (
      EXISTS (SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.kind = 'bot')
      OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
    ) AND NEW.user_id IS NOT OLD.user_id
  ) THEN RAISE(ABORT, 'Bots cannot change epic creators') END);
  SELECT (CASE WHEN (
    (
      EXISTS (SELECT 1 FROM Users u WHERE u.id = OLD.user_id AND u.kind = 'bot')
      OR EXISTS (SELECT 1 FROM Users u WHERE u.id = NEW.user_id AND u.kind = 'bot')
    ) AND NEW.goal_id IS NOT NULL
  ) THEN RAISE(ABORT, 'Bots do not have life goals') END);

  -- A bot cannot reassign ownership or change a human creator's private goal.
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM Users actor WHERE actor.id = NEW.updated_by AND actor.kind = 'bot'
  ) AND NEW.user_id IS NOT OLD.user_id
    THEN RAISE(ABORT, 'Bots cannot change epic creators') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM Users actor WHERE actor.id = NEW.updated_by AND actor.kind = 'bot'
  ) AND NEW.goal_id IS NOT OLD.goal_id
    THEN RAISE(ABORT, 'Bots do not have life goals') END);

  -- Scope confinement follows the editor. Human permissions are checked by epicService;
  -- unattributed writes to a bot-owned epic fall back to the bot creator for the DB backstop.
  SELECT (CASE WHEN (
    EXISTS (SELECT 1 FROM Users actor WHERE actor.id = NEW.updated_by AND actor.kind = 'bot')
    OR (
      NEW.updated_by IS NULL
      AND EXISTS (SELECT 1 FROM Users owner WHERE owner.id = OLD.user_id AND owner.kind = 'bot')
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM Users bot
    JOIN Projects p ON p.id = NEW.project_id
    JOIN OrganisationMembers m ON m.org_id = p.org_id AND m.user_id = bot.id
    WHERE bot.id = COALESCE(NEW.updated_by, OLD.user_id)
      AND bot.kind = 'bot'
      AND bot.disabled_at IS NULL
      AND p.org_id = bot.bot_org_id
      AND m.role = 'member'
  ) THEN RAISE(ABORT, 'Bots can only update scoped epics in their workspace') END);
END;
