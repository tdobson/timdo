import { describe, expect, it } from 'vitest';
import { processAwaitingReturns } from '../services/projectService';
import { ensureUser } from '../services/userService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

describe('system activity provenance', () => {
  it('labels awaiting-return processing as system work', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    raw
      .prepare(
        "INSERT INTO Tasks (id, project_id, reporter_id, title, status, await_until) VALUES ('system-return-task', 'proj-acme-solar', ?, 'Fixture return task', 'awaiting', '2000-01-01')"
      )
      .run(TIM);

    const result = await processAwaitingReturns(db);

    expect(result).toMatchObject({ flipped: 1, total: 1 });
    expect(
      raw
        .prepare(
          "SELECT actor_id, via, via_detail FROM ActivityLog WHERE task_id = 'system-return-task'"
        )
        .get()
    ).toEqual({
      actor_id: null,
      via: 'system',
      via_detail: null,
    });
  });

  it('labels invite claims during internal account provisioning as system work', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    raw
      .prepare(
        "INSERT INTO OrganisationInvites (id, org_id, email, role, token, invited_by, expires_at) VALUES ('system-invite', 'org-md', 'fixture-provisioned@example.test', 'member', 'system-invite-token', ?, '2099-01-01T00:00:00.000Z')"
      )
      .run(TIM);

    await ensureUser(db, {
      id: 'user-fixture-provisioned',
      email: 'fixture-provisioned@example.test',
      name: 'Fixture Provisioned Member',
      emailVerified: true,
    });

    expect(
      raw
        .prepare("SELECT actor_id, via, via_detail FROM ActivityLog WHERE action = 'member_joined'")
        .get()
    ).toEqual({
      actor_id: 'user-fixture-provisioned',
      via: 'system',
      via_detail: null,
    });
  });
});
