import { describe, expect, it } from 'vitest';
import * as epicService from '../services/epicService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

const BOT_ID = 'bot|epic-life-001';
const EPIC_ID = 'fixture-bot-epic';
const HUMAN_EPIC_ID = 'fixture-human-epic';
const HUMAN_GOAL_ID = 'fixture-human-goal';
const SCOPE_TRIGGER_ERROR = 'Bots can only update scoped epics in their workspace';
const BOT_GOAL_ERROR = 'Bots do not have life goals';
const BOT_CREATOR_ERROR = 'Bots cannot change epic creators';

function seedBotEpic() {
  const { db, raw } = createTestDb();
  seedCollaboration(raw);
  raw
    .prepare(
      `INSERT INTO Users (id, email, name, kind, bot_org_id, created_by)
     VALUES (?, ?, ?, 'bot', 'org-md', ?)`
    )
    .run(BOT_ID, 'bot+epic-life-001@bots.timdo.invalid', 'Example Fixture Bot', TIM);
  raw
    .prepare(
      `INSERT INTO Epics (id, user_id, title, description, category, project_id, status)
     VALUES (?, ?, 'Example bot epic', 'Before edit', 'Acme Solar', 'proj-acme-solar', 'active')`
    )
    .run(EPIC_ID, BOT_ID);
  return { db, raw };
}

function seedHumanEpic(raw: any) {
  raw
    .prepare(
      "INSERT INTO Goals (id, user_id, type, title) VALUES (?, ?, 'aim', 'Example private goal')"
    )
    .run(HUMAN_GOAL_ID, TIM);
  raw
    .prepare(
      `INSERT INTO Epics (id, user_id, title, description, category, project_id, status)
     VALUES (?, ?, 'Example human epic', 'Private goal owner', 'Acme Solar', 'proj-acme-solar', 'active')`
    )
    .run(HUMAN_EPIC_ID, TIM);
}

describe('bot-created epic human lifecycle', () => {
  it('allows a human member to move a bot-created epic while its creator is still a member', async () => {
    const { db } = seedBotEpic();

    const before = await epicService.getEpicForUser(db, ROBIN, EPIC_ID);
    expect(before).toMatchObject({
      myRole: 'member',
      canEdit: true,
      createdById: BOT_ID,
      createdByKind: 'bot',
      projectId: 'proj-acme-solar',
    });

    const moved = await epicService.updateEpic(db, ROBIN, EPIC_ID, { projectId: 'proj-md' });
    expect(moved).toMatchObject({
      projectId: 'proj-md',
      category: 'Northstar Workshop',
      myRole: 'member',
      canEdit: true,
      updatedById: ROBIN,
    });
  });

  it('allows a human member to edit and move a bot-created epic after bot disable', async () => {
    const { db, raw } = seedBotEpic();
    raw
      .prepare('UPDATE Users SET disabled_at = ? WHERE id = ?')
      .run('2026-10-11T12:00:00.000Z', BOT_ID);
    expect(
      raw.prepare('SELECT count(*) AS count FROM OrganisationMembers WHERE user_id = ?').get(BOT_ID)
        .count
    ).toBe(0);

    const visible = await epicService.getEpicForUser(db, ROBIN, EPIC_ID);
    expect(visible).toMatchObject({
      myRole: 'member',
      canEdit: true,
      projectId: 'proj-acme-solar',
    });

    const edited = await epicService.updateEpic(db, ROBIN, EPIC_ID, {
      title: 'Human title after disable',
      description: 'Human description after disable',
      status: 'completed',
    });
    expect(edited).toMatchObject({
      title: 'Human title after disable',
      description: 'Human description after disable',
      status: 'completed',
      projectId: 'proj-acme-solar',
      updatedById: ROBIN,
    });

    raw
      .prepare("INSERT INTO Goals (id, user_id, type, title) VALUES (?, ?, 'aim', 'Example goal')")
      .run(HUMAN_GOAL_ID, ROBIN);
    const goalAttempt = await epicService.updateEpic(db, ROBIN, EPIC_ID, {
      goalId: HUMAN_GOAL_ID,
    });
    expect(goalAttempt).toMatchObject({ goalId: null, projectId: 'proj-acme-solar' });

    const moved = await epicService.updateEpic(db, ROBIN, EPIC_ID, { projectId: 'proj-md' });
    expect(moved).toMatchObject({
      projectId: 'proj-md',
      updatedById: ROBIN,
      myRole: 'member',
      canEdit: true,
    });
  });

  it('allows a human member to move the epic after its bot creator becomes a viewer', async () => {
    const { db, raw } = seedBotEpic();
    raw.prepare("UPDATE OrganisationMembers SET role = 'viewer' WHERE user_id = ?").run(BOT_ID);

    expect(
      raw.prepare('SELECT role FROM OrganisationMembers WHERE user_id = ?').get(BOT_ID).role
    ).toBe('viewer');
    expect(await epicService.getEpicForUser(db, ROBIN, EPIC_ID)).toMatchObject({
      myRole: 'member',
      canEdit: true,
      projectId: 'proj-acme-solar',
    });

    const moved = await epicService.updateEpic(db, ROBIN, EPIC_ID, { projectId: 'proj-md' });
    expect(moved).toMatchObject({ projectId: 'proj-md', updatedById: ROBIN });
  });

  it('allows an authorised human owner to move a bot-created epic across workspaces', async () => {
    const { db } = seedBotEpic();

    const moved = await epicService.updateEpic(db, TIM, EPIC_ID, { projectId: 'proj-personal' });
    expect(moved).toMatchObject({
      projectId: 'proj-personal',
      category: 'Personal',
      orgId: 'org-tim',
      updatedById: TIM,
    });
  });

  it('keeps bot actor scope restrictions and blocks bot goal or creator changes without hiding unchanged human goals', async () => {
    const { db, raw } = seedBotEpic();
    const movedBotEpic = await epicService.updateEpic(db, BOT_ID, EPIC_ID, {
      projectId: 'proj-md',
    });
    expect(movedBotEpic).toMatchObject({ projectId: 'proj-md', updatedById: BOT_ID });

    seedHumanEpic(raw);
    const humanGoal = await epicService.updateEpic(db, TIM, HUMAN_EPIC_ID, {
      goalId: HUMAN_GOAL_ID,
    });
    expect(humanGoal?.goalId).toBe(HUMAN_GOAL_ID);

    // A collaborator cannot change the human creator's private goal.
    await epicService.updateEpic(db, ROBIN, HUMAN_EPIC_ID, { goalId: null });
    expect(raw.prepare('SELECT goal_id FROM Epics WHERE id = ?').get(HUMAN_EPIC_ID).goal_id).toBe(
      HUMAN_GOAL_ID
    );

    // The bot can scope-edit the human-created epic in its home workspace without altering its goal.
    const humanEpicMovedByBot = await epicService.updateEpic(db, BOT_ID, HUMAN_EPIC_ID, {
      projectId: 'proj-md',
    });
    expect(humanEpicMovedByBot).toMatchObject({
      projectId: 'proj-md',
      createdById: TIM,
      updatedById: BOT_ID,
    });
    expect(raw.prepare('SELECT goal_id FROM Epics WHERE id = ?').get(HUMAN_EPIC_ID).goal_id).toBe(
      HUMAN_GOAL_ID
    );

    await expect(
      epicService.updateEpic(db, BOT_ID, HUMAN_EPIC_ID, { goalId: null })
    ).rejects.toThrow(BOT_GOAL_ERROR);

    expect(() =>
      raw
        .prepare('UPDATE Epics SET goal_id = NULL, updated_by = ? WHERE id = ?')
        .run(BOT_ID, HUMAN_EPIC_ID)
    ).toThrow(BOT_GOAL_ERROR);
    expect(() =>
      raw
        .prepare('UPDATE Epics SET user_id = ?, updated_by = ? WHERE id = ?')
        .run(ROBIN, BOT_ID, HUMAN_EPIC_ID)
    ).toThrow(BOT_CREATOR_ERROR);
    expect(() =>
      raw
        .prepare('UPDATE Epics SET project_id = ?, updated_by = ? WHERE id = ?')
        .run('proj-personal', BOT_ID, HUMAN_EPIC_ID)
    ).toThrow(SCOPE_TRIGGER_ERROR);

    raw.prepare("UPDATE OrganisationMembers SET role = 'viewer' WHERE user_id = ?").run(BOT_ID);
    await expect(
      epicService.updateEpic(db, BOT_ID, HUMAN_EPIC_ID, { projectId: 'proj-acme-solar' })
    ).rejects.toThrow('view-only access');
    expect(() =>
      raw
        .prepare('UPDATE Epics SET project_id = ?, updated_by = ? WHERE id = ?')
        .run('proj-acme-solar', BOT_ID, HUMAN_EPIC_ID)
    ).toThrow(SCOPE_TRIGGER_ERROR);

    raw
      .prepare('UPDATE Users SET disabled_at = ? WHERE id = ?')
      .run('2026-10-11T13:00:00.000Z', BOT_ID);
    expect(() =>
      raw
        .prepare('UPDATE Epics SET project_id = ?, updated_by = ? WHERE id = ?')
        .run('proj-acme-solar', BOT_ID, HUMAN_EPIC_ID)
    ).toThrow(SCOPE_TRIGGER_ERROR);
  });
});
