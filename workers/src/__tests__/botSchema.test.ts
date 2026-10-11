import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

describe('bot identity and database guards', () => {
  let raw: any;

  beforeEach(() => {
    ({ raw } = createTestDb());
    seedCollaboration(raw);
  });

  it('adds human defaults and nullable activity provenance without rewriting old rows', () => {
    raw
      .prepare(
        "INSERT INTO ActivityLog (id, actor_id, entity_type, entity_id, action, summary) VALUES ('old-event', ?, 'task', 'task-1', 'created', 'old event')"
      )
      .run(TIM);

    const user = raw
      .prepare('SELECT kind, bot_org_id, created_by, disabled_at FROM Users WHERE id = ?')
      .get(TIM);
    const event = raw
      .prepare('SELECT via, via_detail FROM ActivityLog WHERE id = ?')
      .get('old-event');

    expect(user).toEqual({ kind: 'human', bot_org_id: null, created_by: null, disabled_at: null });
    expect(event).toEqual({ via: null, via_detail: null });
  });

  it('allows one active bot membership only in its home workspace with member or viewer role', () => {
    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|fixture-001', 'bot+fixture-001@bots.timdo.invalid', 'Fixture Monitor', 'bot', 'org-md', ?)"
      )
      .run(TIM);

    expect(
      raw
        .prepare('SELECT org_id, role FROM OrganisationMembers WHERE user_id = ?')
        .get('bot|fixture-001')
    ).toEqual({
      org_id: 'org-md',
      role: 'member',
    });
    expect(() =>
      raw
        .prepare(
          "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('bot-member', 'org-md', 'bot|fixture-001', 'member')"
        )
        .run()
    ).toThrow();

    expect(() =>
      raw
        .prepare(
          "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('bot-member-2', 'org-tim', 'bot|fixture-001', 'viewer')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare("UPDATE OrganisationMembers SET role = 'admin' WHERE user_id = 'bot|fixture-001'")
        .run()
    ).toThrow();
  });

  it('rejects reserved identity namespaces, elevated bot memberships and bot assignees', () => {
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Users (id, email, name) VALUES ('bot|reserved', 'human@example.test', 'Fixture User')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Users (id, email, name) VALUES ('human-id', 'bot+reserved@bots.timdo.invalid', 'Fixture User')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|fixture-002', 'bot+fixture-002@bots.timdo.invalid', 'Fixture Monitor', 'bot', 'org-md', 'user-tim')"
        )
        .run()
    ).not.toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('bot-admin', 'org-md', 'bot|fixture-002', 'admin')"
        )
        .run()
    ).toThrow();

    expect(() =>
      raw
        .prepare("UPDATE OrganisationMembers SET role = 'admin' WHERE user_id = 'bot|fixture-002'")
        .run()
    ).toThrow();
    raw
      .prepare(
        "INSERT INTO Projects (id, org_id, key, name) VALUES ('bot-project', 'org-md', 'BOT', 'Fixture Project')"
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Tasks (id, project_id, reporter_id, assignee_id, title) VALUES ('bot-task', 'bot-project', 'user-tim', 'bot|fixture-002', 'Fixture task')"
        )
        .run()
    ).toThrow();
  });

  it('prevents bot identity reassignment, personal goals, unscoped epics and non-home workspace creation', () => {
    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|fixture-004', 'bot+fixture-004@bots.timdo.invalid', 'Fixture Monitor', 'bot', 'org-md', 'user-tim')"
      )
      .run();
    expect(() =>
      raw.prepare("UPDATE Users SET kind = 'bot' WHERE id = 'user-robin'").run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "UPDATE OrganisationMembers SET user_id = 'user-robin' WHERE user_id = 'bot|fixture-004'"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Goals (id, user_id, type, title) VALUES ('bot-goal', 'bot|fixture-004', 'aim', 'Fixture goal')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Epics (id, user_id, title) VALUES ('bot-unscoped-epic', 'bot|fixture-004', 'Fixture epic')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Organisations (id, name, slug, created_by) VALUES ('bot-org', 'Fixture Workspace', 'fixture-bot-workspace', 'bot|fixture-004')"
        )
        .run()
    ).toThrow();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO Projects (id, org_id, key, name, lead_user_id) VALUES ('bot-led-project', 'org-md', 'BLD', 'Fixture Project', 'bot|fixture-004')"
        )
        .run()
    ).toThrow();
  });

  it('does not allow bot kind or home workspace changes', () => {
    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|fixture-003', 'bot+fixture-003@bots.timdo.invalid', 'Fixture Monitor', 'bot', 'org-md', 'user-tim')"
      )
      .run();
    expect(() =>
      raw.prepare("UPDATE Users SET kind = 'human' WHERE id = 'bot|fixture-003'").run()
    ).toThrow();
    expect(() =>
      raw.prepare("UPDATE Users SET bot_org_id = 'org-tim' WHERE id = 'bot|fixture-003'").run()
    ).toThrow();
  });
});
