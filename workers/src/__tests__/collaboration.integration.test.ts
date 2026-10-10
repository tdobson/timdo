/**
 * Multi-user collaboration, end to end against real SQL (node:sqlite + the live D1 schema).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AccessError } from '../services/accessService';
import { getActivity } from '../services/activityService';
import * as epicService from '../services/epicService';
import * as orgService from '../services/organisationService';
import * as projectService from '../services/projectService';
import * as searchService from '../services/searchService';
import * as relationService from '../services/taskRelationService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('collaboration', () => {
  let db: any;
  let raw: any;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
  });

  async function newTask(userId: string, n: number, category: string, extra: any = {}) {
    return projectService.createProject(db, userId, {
      id: uuid(n),
      project: `Task ${n}`,
      status: 'do',
      priority: 5,
      size: '***',
      category,
      ...extra,
    });
  }

  describe('visibility', () => {
    it('shows shared-workspace tasks to members, and personal ones only to their owner', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Personal');
      await newTask(STRANGER, 3, 'Stranger Things');

      const tims = await projectService.getProjectsForUser(db, TIM);
      const robins = await projectService.getProjectsForUser(db, ROBIN);
      expect(tims.map((t) => t.project).sort()).toEqual(['Task 1', 'Task 2']);
      expect(robins.map((t) => t.project)).toEqual(['Task 1']);

      const shared = robins[0];
      expect(shared).toMatchObject({
        category: 'Acme Solar',
        orgName: 'Northstar Workshop',
        isShared: true,
        myRole: 'member',
        canEdit: true,
        reporterName: 'Casey Example',
        assigneeId: TIM,
        assigneeName: 'Casey Example',
        isMine: false,
      });
      expect(tims.find((t) => t.project === 'Task 2')?.isShared).toBe(false);
    });

    it('hides tasks from people outside the workspace, even by id', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      expect(await projectService.getTaskView(db, STRANGER, uuid(1))).toBeNull();
      expect(await projectService.getProjectUpdates(db, uuid(1), STRANGER)).toBeNull();
      expect(
        await projectService.updateProject(db, STRANGER, uuid(1), { status: 'done' })
      ).toBeNull();
    });

    it('filters by assignee', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(ROBIN, 2, 'Acme Solar');
      await newTask(TIM, 3, 'Acme Solar', { assigneeId: null });
      const mine = await projectService.getProjectsForUser(db, ROBIN, { assignee: 'me' });
      expect(mine.map((t) => t.project)).toEqual(['Task 2']);
      const unassigned = await projectService.getProjectsForUser(db, ROBIN, {
        assignee: 'unassigned',
      });
      expect(unassigned.map((t) => t.project)).toEqual(['Task 3']);
    });

    it('scopes full-text search to visible projects', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Inverter swap' });
      await newTask(TIM, 2, 'Personal', { project: 'Inverter for the shed' });
      const results = await searchService.searchTasksForUser(db, ROBIN, 'inverter', true);
      expect(results.map((r) => r.title)).toEqual(['Inverter swap']);
    });
  });

  describe('attribution and activity', () => {
    it('records who created, changed status, assigned and noted', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Fix inverter' });
      await projectService.updateProject(db, ROBIN, uuid(1), { status: 'done' });
      await projectService.updateProject(db, ROBIN, uuid(1), { assigneeId: ROBIN });
      await projectService.addProjectUpdate(db, {
        projectId: uuid(1),
        userId: ROBIN,
        note: 'Swapped it on site',
      });

      const view = await projectService.getTaskView(db, TIM, uuid(1));
      expect(view).toMatchObject({
        updatedByName: 'Jordan Example',
        assigneeName: 'Jordan Example',
        status: 'done',
      });

      const notes = await projectService.getProjectUpdates(db, uuid(1), TIM);
      expect(notes?.[0]).toMatchObject({ authorName: 'Jordan Example', canDelete: true });

      const activity = await getActivity(db, TIM, { taskId: uuid(1) });
      expect(activity.map((a) => [a.actorName, a.action, a.summary])).toEqual([
        ['Jordan Example', 'note_added', 'Added a note to "Fix inverter": Swapped it on site'],
        ['Jordan Example', 'assigned', 'Assigned "Fix inverter" to Jordan Example'],
        ['Jordan Example', 'completed', 'Moved "Fix inverter" from Do to Done'],
        ['Casey Example', 'created', 'Created "Fix inverter"'],
      ]);
    });

    it('keeps personal activity out of collaborators feeds', async () => {
      await newTask(TIM, 1, 'Personal');
      await newTask(TIM, 2, 'Acme Solar');
      const robins = await getActivity(db, ROBIN);
      expect(robins.map((a) => a.taskId)).toEqual([uuid(2)]);
    });

    it('does not log a no-op update', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await projectService.updateProject(db, TIM, uuid(1), { status: 'do', priority: 5 });
      expect(await getActivity(db, TIM, { taskId: uuid(1) })).toHaveLength(1);
    });
  });

  describe('permissions', () => {
    it('makes viewers read-only', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      const [task] = await projectService.getProjectsForUser(db, ROBIN);
      expect(task.canEdit).toBe(false);
      await expect(
        projectService.updateProject(db, ROBIN, uuid(1), { status: 'done' })
      ).rejects.toBeInstanceOf(AccessError);
      await expect(newTask(ROBIN, 2, 'Acme Solar')).rejects.toThrow(/view-only/);
      await expect(
        projectService.addProjectUpdate(db, { projectId: uuid(1), userId: ROBIN, note: 'x' })
      ).rejects.toBeInstanceOf(AccessError);
    });

    it('stops viewers deleting or linking tasks, with a 403 not a 404', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Acme Solar');
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(projectService.deleteProject(db, ROBIN, uuid(1))).rejects.toMatchObject({
        status: 403,
      });
      await expect(relationService.linkTasks(db, ROBIN, uuid(1), uuid(2))).rejects.toMatchObject({
        status: 403,
      });
      await expect(relationService.unlinkTasks(db, ROBIN, uuid(1), uuid(2))).rejects.toMatchObject(
        { status: 403 }
      );
    });

    it('logs links and hides links to tasks a collaborator cannot see', async () => {
      await newTask(TIM, 1, 'Acme Solar', { project: 'Shared one' });
      await newTask(TIM, 2, 'Personal', { project: 'Private one' });
      await relationService.linkTasks(db, TIM, uuid(1), uuid(2));
      expect(await relationService.getTaskRelations(db, uuid(1), ROBIN)).toEqual([]);
      expect(await relationService.getTaskRelations(db, uuid(1), TIM)).toHaveLength(1);
      const [entry] = await getActivity(db, TIM, { taskId: uuid(1) });
      expect(entry.summary).toBe(`Linked "Shared one" to task ${uuid(2).slice(0, 8)} (relates to)`);
    });

    it('only lets assignees be workspace members', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await expect(
        projectService.updateProject(db, TIM, uuid(1), { assigneeId: STRANGER })
      ).rejects.toThrow(/isn't in/);
    });

    it('lets authors and admins delete notes, not other members', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const note = await projectService.addProjectUpdate(db, {
        projectId: uuid(1),
        userId: TIM,
        note: 'Casey note',
      });
      expect(
        await projectService.deleteProjectUpdate(db, {
          updateId: note!.id,
          projectId: uuid(1),
          userId: ROBIN,
        })
      ).toBe(false);
      expect(
        await projectService.deleteProjectUpdate(db, {
          updateId: note!.id,
          projectId: uuid(1),
          userId: TIM,
        })
      ).toBe(true);
    });

    it('creates unknown categories in your own personal workspace, never a shared one', async () => {
      const task = await newTask(ROBIN, 1, 'Robins Side Project');
      expect(task.orgName).toBe('Jordan Example');
      const tims = await projectService.getProjectsForUser(db, TIM);
      expect(tims).toHaveLength(0);
    });

    it('keeps life goals private per person', async () => {
      raw.exec(
        `INSERT INTO Goals (id, user_id, type, title) VALUES ('g-tim', '${TIM}', 'aim', 'Casey aim')`
      );
      await newTask(TIM, 1, 'Acme Solar', { goalId: 'g-tim' });
      expect((await projectService.getTaskView(db, TIM, uuid(1)))?.goalId).toBe('g-tim');
      expect((await projectService.getTaskView(db, ROBIN, uuid(1)))?.goalId).toBeNull();
      await expect(
        projectService.updateProject(db, ROBIN, uuid(1), { goalId: 'g-tim' })
      ).rejects.toThrow(/goal/i);
    });
  });

  describe('epics', () => {
    it('are shared through their project, with attribution', async () => {
      raw.exec(
        `INSERT INTO Goals (id, user_id, type, title) VALUES ('g-tim', '${TIM}', 'aim', 'Casey aim')`
      );
      const epic = await epicService.createEpic(db, TIM, {
        title: 'Get Acme Solar live',
        category: 'Northstar Workshop',
        goalId: 'g-tim',
      });
      await newTask(TIM, 1, 'Northstar Workshop', { epicId: epic!.id });
      await epicService.updateEpic(db, ROBIN, epic!.id, { status: 'completed' });

      const [seen] = await epicService.getEpicsForUser(db, ROBIN);
      expect(seen).toMatchObject({
        title: 'Get Acme Solar live',
        orgName: 'Northstar Workshop',
        goalId: null,
        createdByName: 'Casey Example',
        updatedByName: 'Jordan Example',
        totalTasks: 1,
        canEdit: true,
      });
      expect(await epicService.getEpicsForUser(db, STRANGER)).toHaveLength(0);
      const timsView = await epicService.getEpicForUser(db, TIM, epic!.id);
      expect(timsView?.goalId).toBe('g-tim');
    });

    it('keeps unscoped epics private to their creator', async () => {
      await epicService.createEpic(db, TIM, { title: 'Private thing' });
      expect(await epicService.getEpicsForUser(db, ROBIN)).toHaveLength(0);
      expect(await epicService.getEpicsForUser(db, TIM)).toHaveLength(1);
    });
  });

  describe('sharing', () => {
    it('adds existing users straight away and invites new ones', async () => {
      const added = await orgService.inviteMember(
        db,
        TIM,
        'org-tim',
        'jordan@example.test',
        'viewer'
      );
      expect(added).toMatchObject({ status: 'added', role: 'viewer' });
      const again = await orgService.inviteMember(db, TIM, 'org-tim', 'JORDAN@example.test');
      expect(again.status).toBe('already_member');

      const invited = await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com');
      expect(invited.status).toBe('invited');
      raw.exec(
        `INSERT INTO Users (id, email, name) VALUES ('user-new', 'new@example.com', 'New Person')`
      );
      await orgService.claimPendingInvites(db, 'user-new', 'new@example.com');
      const orgs = await orgService.getUserOrganisations(db, 'user-new');
      expect(orgs.map((o) => [o.name, o.role])).toEqual([['Northstar Workshop', 'member']]);

      // Opening the invite link after sign-in already claimed it still succeeds
      const token = (invited as { token: string }).token;
      await expect(orgService.acceptInvite(db, 'user-new', token)).resolves.toMatchObject({
        success: true,
        orgId: 'org-md',
      });
      await expect(orgService.acceptInvite(db, STRANGER, token)).rejects.toThrow(/someone else/);
      expect(await orgService.getOrganisationInvites(db, TIM, 'org-md')).toEqual([]);
    });

    it('stops members managing people and protects the last owner', async () => {
      await expect(
        orgService.inviteMember(db, ROBIN, 'org-md', 'x@example.com')
      ).rejects.toBeInstanceOf(AccessError);
      await expect(orgService.updateMemberRole(db, TIM, 'org-md', TIM, 'member')).rejects.toThrow(
        /at least one owner/
      );
      await expect(orgService.removeMember(db, TIM, 'org-tim', TIM)).rejects.toThrow(/personal/);
    });

    it('lets a member leave', async () => {
      expect(await orgService.removeMember(db, ROBIN, 'org-md', ROBIN)).toBe(true);
      expect(await projectService.getProjectsForUser(db, ROBIN)).toEqual([]);
    });

    it('moves a project with its tasks and epics between workspaces', async () => {
      await newTask(TIM, 1, 'Personal');
      await epicService.createEpic(db, TIM, { title: 'Home epic', category: 'Personal' });
      expect(await projectService.getProjectsForUser(db, ROBIN)).toHaveLength(0);

      await orgService.updateProjectContainer(db, TIM, 'org-tim', 'proj-personal', {
        orgId: 'org-md',
      });

      expect((await projectService.getProjectsForUser(db, ROBIN)).map((t) => t.project)).toEqual([
        'Task 1',
      ]);
      expect((await epicService.getEpicsForUser(db, ROBIN)).map((e) => e.title)).toEqual([
        'Home epic',
      ]);
      const feed = await getActivity(db, ROBIN, { orgId: 'org-md' });
      expect(feed[0].summary).toBe(
        'Moved the Personal project from Casey Example to Northstar Workshop'
      );
    });

    it('refuses moves by members and into workspaces you cannot edit', async () => {
      await expect(
        orgService.updateProjectContainer(db, ROBIN, 'org-md', 'proj-acme-solar', { orgId: 'org-tim' })
      ).rejects.toBeInstanceOf(AccessError);
      await expect(
        orgService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
          orgId: 'org-stranger',
        })
      ).rejects.toBeInstanceOf(AccessError);
    });

    it('gives the sharing page everything in one call', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const overview = await orgService.getSharingOverview(db, TIM);
      const md = overview.find((o) => o.id === 'org-md')!;
      expect(md.members.map((m) => [m.userName, m.role, m.isMe])).toEqual([
        ['Casey Example', 'owner', true],
        ['Jordan Example', 'member', false],
      ]);
      expect(md.projects.map((p) => [p.name, p.openTasks])).toEqual([
        ['Acme Solar', 1],
        ['Northstar Workshop', 0],
      ]);
      const robinsOverview = await orgService.getSharingOverview(db, ROBIN);
      expect(robinsOverview.map((o) => o.name)).toEqual(['Northstar Workshop']);
      expect(robinsOverview[0].invites).toEqual([]);
    });
  });

  describe('review hardening', () => {
    it('does not show workspace activity to someone with no memberships', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await orgService.inviteMember(db, TIM, 'org-md', 'new@example.com');
      raw.exec(`INSERT INTO Users (id, email, name) VALUES ('user-lonely', 'l@example.com', 'L')`);
      expect(await getActivity(db, 'user-lonely')).toEqual([]);
    });

    it('stops members moving shared tasks or epics into their own workspace', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await expect(
        projectService.updateProject(db, ROBIN, uuid(1), { category: 'Robins Own' })
      ).rejects.toThrow(/Only owners and admins/);
      const epic = await epicService.createEpic(db, TIM, { title: 'E', category: 'Acme Solar' });
      await expect(
        epicService.updateEpic(db, ROBIN, epic!.id, { category: 'Robins Own' })
      ).rejects.toThrow(/Only owners and admins/);
      // Within the workspace is fine
      const moved = await projectService.updateProject(db, ROBIN, uuid(1), {
        category: 'Northstar Workshop',
      });
      expect(moved?.category).toBe('Northstar Workshop');
    });

    it('clears an assignee who is not in the destination workspace', async () => {
      await newTask(TIM, 1, 'Acme Solar', { assigneeId: ROBIN });
      const moved = await projectService.updateProject(db, TIM, uuid(1), { category: 'Personal' });
      expect(moved).toMatchObject({ orgName: 'Casey Example', assigneeId: null });
    });

    it('refuses merges and epic links across workspaces', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      await newTask(TIM, 2, 'Personal');
      await expect(projectService.mergeProjects(db, TIM, uuid(1), uuid(2))).rejects.toThrow(
        /same workspace/
      );
      const epic = await epicService.createEpic(db, TIM, { title: 'E', category: 'Acme Solar' });
      await expect(
        projectService.updateProject(db, TIM, uuid(2), { epicId: epic!.id })
      ).rejects.toThrow(/That epic is in Northstar Workshop/);
    });

    it('treats empty strings from forms as "none", without logging a change', async () => {
      await newTask(TIM, 1, 'Acme Solar');
      const { projectUpdateSchema } = await import('../validators/projectValidators');
      const payload = projectUpdateSchema.parse({ epicId: '', goalId: '', awaitUntil: '' });
      await projectService.updateProject(db, TIM, uuid(1), payload);
      expect(await getActivity(db, TIM, { taskId: uuid(1) })).toHaveLength(1);
    });

    it('prefers your own project when a shared workspace has one with the same name', async () => {
      raw.exec(`
        INSERT INTO Projects (id, org_id, key, name) VALUES ('proj-fake', 'org-stranger', 'PER', 'Personal');
        INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('m9', 'org-stranger', '${TIM}', 'member');
      `);
      const task = await newTask(TIM, 1, 'Personal');
      expect(task.projectId).toBe('proj-personal');
    });
  });

  describe('awaiting returns', () => {
    it('brings due tasks back to Do and logs it as TimDo', async () => {
      await newTask(TIM, 1, 'Acme Solar', { status: 'awaiting', awaitUntil: '2020-01-01' });
      const result = await projectService.processAwaitingReturns(db);
      expect(result.flipped).toBe(1);
      const [entry] = await getActivity(db, ROBIN, { taskId: uuid(1) });
      expect(entry).toMatchObject({ actorName: 'TimDo', action: 'status_changed' });
    });
  });
});
