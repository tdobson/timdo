/**
 * epicService against real SQL (node:sqlite + the live D1 schema).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AccessError } from '../services/accessService';
import { getActivity } from '../services/activityService';
import * as epicService from '../services/epicService';
import * as orgService from '../services/organisationService';
import * as projectService from '../services/projectService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('epicService', () => {
  let db: any;
  let raw: any;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
  });

  async function newTask(n: number, epicId: string, status = 'do', category = 'Acme Solar') {
    return projectService.createProject(db, TIM, {
      id: uuid(n),
      project: `Task ${n}`,
      status: status as any,
      priority: 5,
      size: '***',
      category,
      epicId,
    });
  }

  describe('createEpic', () => {
    it('scopes the epic to the named project, defaults to active and records the creator', async () => {
      const created = await epicService.createEpic(db, TIM, {
        title: 'Get Acme Solar Live',
        category: 'acme solar',
        description: 'Get project operational',
      });

      expect(created).not.toBeNull();
      expect(created).toMatchObject({
        userId: TIM,
        title: 'Get Acme Solar Live',
        description: 'Get project operational',
        category: 'Acme Solar',
        projectId: 'proj-acme-solar',
        projectKey: 'ACS',
        orgId: 'org-md',
        orgName: 'Northstar Workshop',
        isShared: true,
        myRole: 'owner',
        canEdit: true,
        status: 'active',
        createdById: TIM,
        createdByName: 'Casey Example',
        updatedByName: 'Casey Example',
        totalTasks: 0,
        doneTasks: 0,
        progressPercentage: 0,
      });

      const activity = await getActivity(db, ROBIN, { epicId: created!.id });
      expect(activity.map((a) => [a.actorName, a.action, a.summary])).toEqual([
        ['Casey Example', 'created', 'Created epic "Get Acme Solar Live"'],
      ]);
    });

    it('accepts an explicit projectId and an explicit status', async () => {
      const created = await epicService.createEpic(db, ROBIN, {
        title: 'Dragon migration',
        projectId: 'proj-md',
        status: 'on_hold',
      });
      expect(created).toMatchObject({
        projectId: 'proj-md',
        category: 'Northstar Workshop',
        status: 'on_hold',
        myRole: 'member',
      });
    });

    it("creates an unknown category as a project in the creator's personal workspace", async () => {
      const created = await epicService.createEpic(db, ROBIN, {
        title: 'Shed',
        category: 'Garden',
      });
      expect(created).toMatchObject({ category: 'Garden', orgName: 'Jordan Example' });
      expect(await epicService.getEpicsForUser(db, TIM)).toHaveLength(0);
    });

    it('keeps an epic with no project private to its creator', async () => {
      const created = await epicService.createEpic(db, TIM, { title: 'Unscoped' });
      expect(created).toMatchObject({
        projectId: null,
        category: null,
        orgId: null,
        myRole: 'owner',
        isShared: false,
      });
      expect(await epicService.getEpicForUser(db, ROBIN, created!.id)).toBeNull();
    });

    it('refuses projects the user cannot see (404) or can only view (403)', async () => {
      await expect(
        epicService.createEpic(db, TIM, { title: 'x', projectId: 'proj-stranger' })
      ).rejects.toMatchObject({ status: 404 });

      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(
        epicService.createEpic(db, ROBIN, { title: 'x', projectId: 'proj-md' })
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        epicService.createEpic(db, ROBIN, { title: 'x', category: 'Acme Solar' })
      ).rejects.toThrow(/view-only/);
    });
  });

  describe('progress stats', () => {
    it('counts done tasks against all live tasks and rounds the percentage', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Epic 1', category: 'Acme Solar' });
      await newTask(1, epic!.id, 'done');
      await newTask(2, epic!.id, 'done');
      await newTask(3, epic!.id, 'do');
      await newTask(4, epic!.id, 'delay');
      // Deleted tasks don't count
      await newTask(5, epic!.id, 'done');
      await projectService.deleteProject(db, TIM, uuid(5));

      const epics = await epicService.getEpicsForUser(db, TIM);
      expect(epics).toHaveLength(1);
      expect(epics[0]).toMatchObject({ totalTasks: 4, doneTasks: 2, progressPercentage: 50 });

      await newTask(6, epic!.id, 'do');
      const one = await epicService.getEpicForUser(db, TIM, epic!.id);
      expect(one).toMatchObject({ totalTasks: 5, doneTasks: 2, progressPercentage: 40 });
    });

    it('rounds thirds and reports zero-task epics as 0%', async () => {
      const thirds = await epicService.createEpic(db, TIM, { title: 'Thirds', category: 'Acme Solar' });
      await epicService.createEpic(db, TIM, { title: 'Empty', category: 'Acme Solar' });
      await newTask(1, thirds!.id, 'done');
      await newTask(2, thirds!.id, 'done');
      await newTask(3, thirds!.id, 'do');

      const byTitle = Object.fromEntries(
        (await epicService.getEpicsForUser(db, TIM)).map((e) => [e.title, e])
      );
      expect(byTitle.Thirds).toMatchObject({ totalTasks: 3, doneTasks: 2, progressPercentage: 67 });
      expect(byTitle.Empty).toMatchObject({ totalTasks: 0, doneTasks: 0, progressPercentage: 0 });
    });
  });

  describe('getEpicsForUser', () => {
    it('filters by category, case-insensitively, including unscoped epics', async () => {
      await epicService.createEpic(db, TIM, { title: 'Acme Solar epic', category: 'Acme Solar' });
      await epicService.createEpic(db, TIM, {
        title: 'Dragons epic',
        category: 'Northstar Workshop',
      });
      await epicService.createEpic(db, TIM, { title: 'Home epic', category: 'Personal' });

      const acmeSolar = await epicService.getEpicsForUser(db, TIM, 'ACME SOLAR');
      expect(acmeSolar.map((e) => e.title)).toEqual(['Acme Solar epic']);
      const all = await epicService.getEpicsForUser(db, TIM);
      expect(all.map((e) => e.title).sort()).toEqual(['Acme Solar epic', 'Dragons epic', 'Home epic']);
      // Jordan is not in Casey's personal workspace
      const robins = await epicService.getEpicsForUser(db, ROBIN);
      expect(robins.map((e) => e.title).sort()).toEqual(['Acme Solar epic', 'Dragons epic']);
      expect(await epicService.getEpicsForUser(db, STRANGER)).toEqual([]);
    });

    it('returns null for an unknown epic id', async () => {
      expect(await epicService.getEpicForUser(db, TIM, 'nope')).toBeNull();
    });
  });

  describe('updateEpic', () => {
    it('updates title and status, attributes the change and logs it', async () => {
      const epic = await epicService.createEpic(db, TIM, {
        title: 'Original Title',
        category: 'Acme Solar',
      });

      const updated = await epicService.updateEpic(db, ROBIN, epic!.id, {
        title: 'New Title',
        status: 'completed',
      });

      expect(updated).toMatchObject({
        title: 'New Title',
        status: 'completed',
        createdByName: 'Casey Example',
        updatedById: ROBIN,
        updatedByName: 'Jordan Example',
      });
      const actions = (await getActivity(db, TIM, { epicId: epic!.id })).map((a) => a.summary);
      expect(actions).toEqual(
        expect.arrayContaining([
          'Marked epic "New Title" as Completed',
          'Updated title on epic "New Title"',
          'Created epic "Original Title"',
        ])
      );
    });

    it('does not log a no-op update', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Same', category: 'Acme Solar' });
      await epicService.updateEpic(db, TIM, epic!.id, { title: 'Same', status: 'active' });
      expect(await getActivity(db, TIM, { epicId: epic!.id })).toHaveLength(1);
    });

    it('moves the epic to another project by category', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Mover', category: 'Acme Solar' });
      const moved = await epicService.updateEpic(db, TIM, epic!.id, { category: 'Personal' });
      expect(moved).toMatchObject({ projectId: 'proj-personal', category: 'Personal' });
      expect(await epicService.getEpicForUser(db, ROBIN, epic!.id)).toBeNull();
      const [latest] = await getActivity(db, TIM, { epicId: epic!.id, projectId: 'proj-personal' });
      expect(latest.summary).toBe('Moved epic "Mover" to Personal');
    });

    it('lets only the creator change the life goal, and hides it from others', async () => {
      raw.exec(
        `INSERT INTO Goals (id, user_id, type, title) VALUES ('g-tim', '${TIM}', 'aim', 'A')`
      );
      const epic = await epicService.createEpic(db, TIM, {
        title: 'Goal epic',
        category: 'Acme Solar',
      });
      await epicService.updateEpic(db, TIM, epic!.id, { goalId: 'g-tim' });
      await epicService.updateEpic(db, ROBIN, epic!.id, { goalId: null });

      expect((await epicService.getEpicForUser(db, TIM, epic!.id))?.goalId).toBe('g-tim');
      expect((await epicService.getEpicForUser(db, ROBIN, epic!.id))?.goalId).toBeNull();
    });

    it('returns null for epics the user cannot see and throws for viewers', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Locked', category: 'Acme Solar' });
      expect(await epicService.updateEpic(db, STRANGER, epic!.id, { title: 'x' })).toBeNull();

      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(
        epicService.updateEpic(db, ROBIN, epic!.id, { title: 'x' })
      ).rejects.toBeInstanceOf(AccessError);
      expect((await epicService.getEpicForUser(db, ROBIN, epic!.id))?.canEdit).toBe(false);
    });
  });

  describe('deleteEpic', () => {
    it('deletes the epic, unlinks its tasks and logs it', async () => {
      const epic = await epicService.createEpic(db, TIM, {
        title: 'To Delete',
        category: 'Acme Solar',
      });
      await newTask(1, epic!.id);

      expect(await epicService.deleteEpic(db, ROBIN, epic!.id)).toBe(true);
      expect(await epicService.getEpicForUser(db, TIM, epic!.id)).toBeNull();
      expect(await epicService.getEpicsForUser(db, TIM)).toEqual([]);
      // Tasks survive with the epic link cleared (ON DELETE SET NULL)
      expect((await projectService.getTaskView(db, TIM, uuid(1)))?.epicId).toBeNull();

      const entry = (await getActivity(db, TIM, { epicId: epic!.id })).find(
        (a) => a.action === 'deleted'
      );
      expect(entry).toMatchObject({
        actorName: 'Jordan Example',
        projectId: 'proj-acme-solar',
        summary: 'Deleted epic "To Delete"',
      });
    });

    it('returns false for unknown epics, outsiders and viewers', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Keep', category: 'Acme Solar' });
      expect(await epicService.deleteEpic(db, TIM, 'nope')).toBe(false);
      expect(await epicService.deleteEpic(db, STRANGER, epic!.id)).toBe(false);
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      expect(await epicService.deleteEpic(db, ROBIN, epic!.id)).toBe(false);
      expect(await epicService.getEpicForUser(db, TIM, epic!.id)).not.toBeNull();
    });

    it('lets only the creator delete an unscoped epic', async () => {
      const epic = await epicService.createEpic(db, TIM, { title: 'Mine' });
      expect(await epicService.deleteEpic(db, ROBIN, epic!.id)).toBe(false);
      expect(await epicService.deleteEpic(db, TIM, epic!.id)).toBe(true);
    });
  });
});
