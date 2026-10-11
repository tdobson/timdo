import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import epicsApp from '../routes/epics';
import * as activityService from '../services/activityService';
import * as botService from '../services/botService';
import * as epicService from '../services/epicService';
import * as goalService from '../services/goalService';
import * as organisationService from '../services/organisationService';
import * as projectService from '../services/projectService';
import * as searchService from '../services/searchService';
import * as taskService from '../services/taskService';
import { ensureUser } from '../services/userService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

function setupBot() {
  const { db, raw } = createTestDb();
  seedCollaboration(raw);
  raw
    .prepare(
      "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|confine-001', 'bot+confine-001@bots.timdo.invalid', 'Fixture Confined Bot', 'bot', 'org-md', ?)"
    )
    .run(TIM);
  raw
    .prepare(
      "INSERT INTO Projects (id, org_id, key, name) VALUES ('confine-project', 'org-md', 'CNF', 'Fixture Existing Project')"
    )
    .run();
  raw
    .prepare(
      "INSERT INTO Goals (id, user_id, type, title) VALUES ('human-goal', ?, 'aim', 'Fixture goal')"
    )
    .run(TIM);
  raw
    .prepare(
      "INSERT INTO Tasks (id, project_id, reporter_id, title) VALUES ('human-task', 'confine-project', ?, 'Fixture human task')"
    )
    .run(TIM);
  raw
    .prepare(
      "INSERT INTO OrganisationInvites (id, org_id, email, role, token, invited_by, expires_at) VALUES ('fixture-invite', 'org-md', 'future@example.test', 'member', 'fixture-invite-token', ?, '2099-01-01T00:00:00.000Z')"
    )
    .run(TIM);
  return { db, raw, botId: 'bot|confine-001' };
}

describe('bot service confinement', () => {
  it('does not create a personal workspace or fall back to a new project for an unknown category', async () => {
    const { db, raw, botId } = setupBot();

    await expect(
      projectService.createProject(db, botId, {
        id: 'bot-unknown-category',
        project: 'Fixture task',
        category: 'Fixture Missing Project',
        status: 'do',
        priority: 5,
        size: '***',
      })
    ).rejects.toThrow('Bots can only add tasks to projects in "Northstar Workshop"');

    expect(
      raw
        .prepare(
          'SELECT count(*) as count FROM Organisations WHERE is_personal = 1 AND created_by = ?'
        )
        .get(botId).count
    ).toBe(0);
    expect(
      raw
        .prepare("SELECT count(*) as count FROM Projects WHERE name = 'Fixture Missing Project'")
        .get().count
    ).toBe(0);
  });

  it('blocks workspace and project creation from both service entry points', async () => {
    const { db, botId } = setupBot();

    await expect(
      organisationService.createOrganisation(db, botId, 'Fixture Bot Workspace')
    ).rejects.toThrow();
    await expect(
      organisationService.addProject(db, botId, 'org-md', 'Fixture Bot Project')
    ).rejects.toThrow();
  });

  it('blocks unscoped epics, private goals and every task goal overlay operation', async () => {
    const { db, botId } = setupBot();

    await expect(
      epicService.createEpic(db, botId, { title: 'Fixture unscoped epic' })
    ).rejects.toThrow();
    await expect(
      epicService.createEpic(db, botId, {
        title: 'Fixture goal epic',
        projectId: 'confine-project',
        goalId: 'human-goal',
      })
    ).rejects.toThrow();
    await expect(goalService.getGoalsForUser(db, botId)).rejects.toThrow();
    await expect(
      goalService.createGoal(db, botId, { type: 'aim', title: 'Fixture bot goal' })
    ).rejects.toThrow();
    await expect(
      goalService.updateGoal(db, botId, 'human-goal', { title: 'Changed' })
    ).rejects.toThrow();
    await expect(goalService.deleteGoal(db, botId, 'human-goal')).rejects.toThrow();
    await expect(taskService.getTaskPersonalGoals(db, botId, 'human-task')).rejects.toThrow();
    await expect(
      taskService.linkPersonalGoal(db, botId, 'human-task', 'human-goal')
    ).rejects.toThrow();
    await expect(
      taskService.unlinkPersonalGoal(db, botId, 'human-task', 'human-goal')
    ).rejects.toThrow();
  });

  it('rejects attempts to un-scope a member bot epic before the database backstop', async () => {
    const { db, raw, botId } = setupBot();
    const app = new Hono<any>();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('userId', botId);
      await next();
    });
    app.route('/epics', epicsApp);

    for (const category of [null, '']) {
      const epic = await epicService.createEpic(db, botId, {
        title: 'Fixture scoped bot epic',
        projectId: 'confine-project',
      });
      const response = await app.request(`/epics/${epic!.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(
        raw.prepare('SELECT project_id FROM Epics WHERE id = ?').get(epic!.id).project_id
      ).toBe('confine-project');
      expect(() =>
        raw.prepare('UPDATE Epics SET project_id = NULL WHERE id = ?').run(epic!.id)
      ).toThrow();
      expect(
        raw.prepare('SELECT project_id FROM Epics WHERE id = ?').get(epic!.id).project_id
      ).toBe('confine-project');
    }
  });

  it('allows member bots to work in scoped projects but keeps viewer bots read-only', async () => {
    const { db, raw, botId } = setupBot();
    const createdTask = await projectService.createProject(db, botId, {
      id: 'bot-assigned-human-task',
      project: 'Fixture bot task',
      projectId: 'confine-project',
      assigneeId: ROBIN,
      status: 'do',
      priority: 5,
      size: '***',
    });
    expect(createdTask.assigneeId).toBe(ROBIN);

    const epic = await epicService.createEpic(db, botId, {
      title: 'Fixture scoped bot epic',
      projectId: 'confine-project',
    });
    expect(epic?.projectId).toBe('confine-project');

    raw
      .prepare(
        "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES ('bot|confine-viewer', 'bot+confine-viewer@bots.timdo.invalid', 'Fixture Viewer Bot', 'bot', 'org-md', ?)"
      )
      .run(TIM);
    raw
      .prepare(
        "UPDATE OrganisationMembers SET role = 'viewer' WHERE user_id = 'bot|confine-viewer'"
      )
      .run();
    await expect(
      projectService.createProject(db, 'bot|confine-viewer', {
        id: 'viewer-bot-task',
        project: 'Fixture forbidden task',
        projectId: 'confine-project',
        status: 'do',
        priority: 5,
        size: '***',
      })
    ).rejects.toThrow('view-only access');
  });

  it('rejects bots as task assignees from create, update, assign and claim services', async () => {
    const { db, botId } = setupBot();

    await expect(
      projectService.createProject(db, TIM, {
        id: 'human-task-assigned-to-bot',
        project: 'Fixture assigned task',
        projectId: 'confine-project',
        assigneeId: botId,
        status: 'do',
        priority: 5,
        size: '***',
      })
    ).rejects.toThrow("Bots can't be assigned tasks");
    await expect(taskService.claimTask(db, botId, 'human-task')).rejects.toThrow(
      "Bots can't be assigned tasks"
    );
    await expect(taskService.assignTask(db, TIM, 'human-task', botId)).rejects.toThrow(
      "Bots can't be assigned tasks"
    );
  });

  it('rejects a bot identity from normal account provisioning, invite acceptance and invite claiming', async () => {
    const { db, botId } = setupBot();

    await expect(
      ensureUser(db, {
        id: botId,
        email: 'bot+confine-001@bots.timdo.invalid',
        name: 'Fixture Confined Bot',
      })
    ).rejects.toThrow();
    await expect(
      organisationService.acceptInvite(db, botId, 'fixture-invite-token')
    ).rejects.toThrow();
    await expect(
      organisationService.claimPendingInvites(db, botId, 'future@example.test')
    ).rejects.toThrow();
    await expect(
      organisationService.inviteMember(db, TIM, 'org-md', 'bot+another@bots.timdo.invalid')
    ).rejects.toThrow();
  });

  it('requires dedicated bot management for role changes and removal', async () => {
    const { db, botId } = setupBot();

    await expect(
      organisationService.updateMemberRole(db, TIM, 'org-md', botId, 'viewer')
    ).rejects.toThrow();
    await expect(organisationService.removeMember(db, TIM, 'org-md', botId)).rejects.toThrow();
  });

  it('hides tasks, search, activity and creation counts from another workspace', async () => {
    const { db, raw, botId } = setupBot();
    raw
      .prepare(
        "INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES ('org-outside', 'Fixture Outside Workspace', 'fixture-outside-workspace', ?, 0)"
      )
      .run(STRANGER);
    raw
      .prepare(
        "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('outside-owner', 'org-outside', ?, 'owner')"
      )
      .run(STRANGER);
    raw
      .prepare(
        "INSERT INTO Projects (id, org_id, key, name) VALUES ('outside-project', 'org-outside', 'OUT', 'Fixture Outside Project')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO Tasks (id, project_id, reporter_id, title) VALUES ('outside-task', 'outside-project', ?, 'Fixture outside workspace task')"
      )
      .run(STRANGER);
    raw
      .prepare(
        "INSERT INTO ActivityLog (id, actor_id, org_id, project_id, entity_type, entity_id, task_id, action, summary) VALUES ('outside-bot-event', ?, 'org-outside', 'outside-project', 'task', 'outside-task', 'outside-task', 'created', 'Fixture outside event')"
      )
      .run(botId);

    expect(await taskService.getTaskById(db, botId, 'outside-task')).toBeNull();
    expect(
      await searchService.searchTasksForUser(db, botId, 'Fixture outside workspace task')
    ).toEqual([]);
    const activity = await activityService.getActivity(db, botId);
    expect(activity.some((event) => event.id === 'outside-bot-event')).toBe(false);
    const counts = await botService.getBotTaskCreationCounts(db, TIM, {
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
    });
    expect(counts.items).toContainEqual({
      botId,
      botName: 'Fixture Confined Bot',
      orgId: 'org-md',
      orgName: 'Northstar Workshop',
      tasksCreated: 0,
    });
  });
});
