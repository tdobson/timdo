/**
 * taskService (the `/tasks` API, raw Tasks rows) against real SQL (node:sqlite + the live D1 schema).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError } from '../services/accessService';
import { getActivity } from '../services/activityService';
import * as orgService from '../services/organisationService';
import {
  addTaskUpdate,
  assignTask,
  claimTask,
  createTask,
  getTaskById,
  getTaskPersonalGoals,
  getTasksForUser,
  getTaskUpdates,
  linkPersonalGoal,
  resolveTaskIdForUser,
  unlinkPersonalGoal,
  updateTask,
} from '../services/taskService';
import { createTestDb, ROBIN, seedCollaboration, STRANGER, TIM } from './helpers/testDb';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('taskService', () => {
  let db: any;
  let raw: any;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function newTask(userId: string, n: number, projectId: string, extra: any = {}) {
    return createTask(db, userId, {
      id: uuid(n),
      projectId,
      title: `Task ${n}`,
      status: 'do',
      priority: 5,
      size: '***',
      ...extra,
    });
  }

  const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();

  describe('createTask', () => {
    it('creates a task in the given project with the creator as reporter and assignee', async () => {
      const task = await createTask(db, TIM, {
        projectId: 'proj-acme-solar',
        title: 'Build task collaboration API',
        status: 'do',
        priority: 8,
        size: '***',
      });

      expect(task).toBeDefined();
      expect(task).toMatchObject({
        projectId: 'proj-acme-solar',
        title: 'Build task collaboration API',
        reporterId: TIM,
        assigneeId: TIM,
        updatedBy: TIM,
        priority: 8,
        status: 'do',
        size: '***',
        isDeleted: false,
        epicId: null,
        reason: null,
      });
      expect(task!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(task!.statusLastChangedOn).toBeTruthy();

      const [entry] = await getActivity(db, ROBIN, { taskId: task!.id });
      expect(entry).toMatchObject({ action: 'created', actorName: 'Casey Example' });
    });

    it('honours an explicit null or other assignee', async () => {
      expect((await newTask(TIM, 1, 'proj-acme-solar', { assigneeId: null }))?.assigneeId).toBeNull();
      expect((await newTask(TIM, 2, 'proj-acme-solar', { assigneeId: ROBIN }))?.assigneeId).toBe(
        ROBIN
      );
      await expect(newTask(TIM, 3, 'proj-personal', { assigneeId: ROBIN })).rejects.toThrow(
        /isn't in/
      );
    });

    it('refuses projects the user cannot see (404) or only view (403)', async () => {
      await expect(newTask(TIM, 1, 'proj-stranger')).rejects.toMatchObject({ status: 404 });
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      const err = await newTask(ROBIN, 2, 'proj-acme-solar').catch((e) => e);
      expect(err).toBeInstanceOf(AccessError);
      expect(err).toMatchObject({ status: 403 });
    });
  });

  describe('reading', () => {
    beforeEach(async () => {
      await newTask(TIM, 1, 'proj-acme-solar', { customer: 'Acme Solar', tags: 'roof,urgent' });
      await newTask(TIM, 2, 'proj-acme-solar', { assigneeId: null, status: 'delay' });
      await newTask(ROBIN, 3, 'proj-md', { tags: 'URGENT' });
      await newTask(TIM, 4, 'proj-personal', { status: 'done' });
      await newTask(STRANGER, 5, 'proj-stranger');
      await newTask(TIM, 6, 'proj-acme-solar');
      await updateTask(db, TIM, uuid(6), { isDeleted: true });
    });

    it('lists only visible, non-deleted tasks', async () => {
      expect(titles(await getTasksForUser(db, TIM))).toEqual([
        'Task 1',
        'Task 2',
        'Task 3',
        'Task 4',
      ]);
      expect(titles(await getTasksForUser(db, ROBIN))).toEqual(['Task 1', 'Task 2', 'Task 3']);
      expect(titles(await getTasksForUser(db, STRANGER))).toEqual(['Task 5']);
    });

    it('filters by workspace, project, status, customer and tag', async () => {
      expect(titles(await getTasksForUser(db, TIM, { orgId: 'org-tim' }))).toEqual(['Task 4']);
      expect(await getTasksForUser(db, TIM, { orgId: 'org-stranger' })).toEqual([]);
      expect(titles(await getTasksForUser(db, TIM, { projectId: 'proj-md' }))).toEqual(['Task 3']);
      expect(await getTasksForUser(db, TIM, { projectId: 'proj-stranger' })).toEqual([]);
      expect(titles(await getTasksForUser(db, TIM, { status: 'delay' }))).toEqual(['Task 2']);
      expect(titles(await getTasksForUser(db, TIM, { customer: 'acme solar' }))).toEqual(['Task 1']);
      expect(titles(await getTasksForUser(db, TIM, { tag: 'urgent' }))).toEqual([
        'Task 1',
        'Task 3',
      ]);
    });

    it('filters by assignee', async () => {
      expect(titles(await getTasksForUser(db, TIM, { mineOnly: true }))).toEqual([
        'Task 1',
        'Task 4',
      ]);
      expect(titles(await getTasksForUser(db, TIM, { unassignedOnly: true }))).toEqual(['Task 2']);
      expect(titles(await getTasksForUser(db, TIM, { assigneeId: ROBIN }))).toEqual(['Task 3']);
      expect(titles(await getTasksForUser(db, TIM, { assigneeId: '' }))).toEqual(['Task 2']);
    });

    it('filters by related task', async () => {
      raw.exec(`
        INSERT INTO TaskRelations (id, source_task_id, target_task_id, relation_type) VALUES
          ('r1', '${uuid(1)}', '${uuid(2)}', 'blocks'),
          ('r2', '${uuid(3)}', '${uuid(1)}', 'relates_to'),
          ('r3', '${uuid(5)}', '${uuid(1)}', 'relates_to');
      `);
      // Task 5 is in a workspace Casey can't see, so it stays hidden
      expect(titles(await getTasksForUser(db, TIM, { relatedTo: uuid(1) }))).toEqual([
        'Task 2',
        'Task 3',
      ]);
      expect(await getTasksForUser(db, TIM, { relatedTo: uuid(4) })).toEqual([]);
      expect(await getTasksForUser(db, TIM, { relatedTo: uuid(5) })).toEqual([]);
    });

    it('gets a single task only if visible and not deleted', async () => {
      expect((await getTaskById(db, ROBIN, uuid(1)))?.title).toBe('Task 1');
      expect(await getTaskById(db, ROBIN, uuid(4))).toBeNull();
      expect(await getTaskById(db, TIM, uuid(6))).toBeNull();
      expect(await getTaskById(db, TIM, 'missing')).toBeNull();
    });

    it('resolves full ids and unique prefixes to visible tasks', async () => {
      raw.exec(`UPDATE Tasks SET id = 'abc12345-unique' WHERE id = '${uuid(4)}'`);
      expect(await resolveTaskIdForUser(db, TIM, uuid(1))).toBe(uuid(1));
      expect(await resolveTaskIdForUser(db, TIM, 'ABC123')).toBe('abc12345-unique');
      expect(await resolveTaskIdForUser(db, ROBIN, 'abc123')).toBeNull();
      expect(await resolveTaskIdForUser(db, TIM, uuid(5))).toBeNull();
      expect(await resolveTaskIdForUser(db, TIM, uuid(6))).toBeNull();
      expect(await resolveTaskIdForUser(db, TIM, '')).toBeNull();
    });
  });

  describe('claim and assign', () => {
    it('claims a task by setting the assignee to the current user', async () => {
      await newTask(TIM, 1, 'proj-acme-solar', { assigneeId: null });
      const claimed = await claimTask(db, ROBIN, uuid(1));
      expect(claimed).toMatchObject({ assigneeId: ROBIN, updatedBy: ROBIN, reporterId: TIM });

      const entry = (await getActivity(db, TIM, { taskId: uuid(1) })).find(
        (a) => a.action === 'assigned'
      );
      expect(entry).toMatchObject({
        actorName: 'Jordan Example',
        summary: 'Assigned "Task 1" to Jordan Example',
      });
    });

    it('returns null when claiming a task the user cannot see', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      expect(await claimTask(db, STRANGER, uuid(1))).toBeNull();
      expect(await claimTask(db, TIM, 'missing')).toBeNull();
    });

    it('stops viewers claiming', async () => {
      await newTask(TIM, 1, 'proj-acme-solar', { assigneeId: null });
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(claimTask(db, ROBIN, uuid(1))).rejects.toBeInstanceOf(AccessError);
    });

    it('reassigns to another workspace member, unassigns, and rejects outsiders', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      expect((await assignTask(db, TIM, uuid(1), ROBIN))?.assigneeId).toBe(ROBIN);
      expect((await assignTask(db, TIM, uuid(1), null))?.assigneeId).toBeNull();
      await expect(assignTask(db, TIM, uuid(1), STRANGER)).rejects.toThrow(/isn't in/);

      const summaries = (await getActivity(db, TIM, { taskId: uuid(1) })).map((a) => a.summary);
      expect(summaries).toEqual(
        expect.arrayContaining(['Assigned "Task 1" to Jordan Example', 'Unassigned "Task 1"'])
      );
    });
  });

  describe('updateTask', () => {
    it('maps title and other fields onto the shared update path', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      const updated = await updateTask(db, ROBIN, uuid(1), {
        title: 'Renamed',
        status: 'done',
        priority: 9,
        reason: 'Because',
      });
      expect(updated).toMatchObject({
        title: 'Renamed',
        status: 'done',
        priority: 9,
        reason: 'Because',
        updatedBy: ROBIN,
      });
      expect(await updateTask(db, STRANGER, uuid(1), { title: 'x' })).toBeNull();
    });

    it('moves a task to another visible project', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      expect((await updateTask(db, TIM, uuid(1), { projectId: 'proj-personal' }))?.projectId).toBe(
        'proj-personal'
      );
      await expect(
        updateTask(db, TIM, uuid(1), { projectId: 'proj-stranger' })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('clears reason and notes when null is passed', async () => {
      await newTask(TIM, 1, 'proj-acme-solar', { reason: 'Old reason', notes: 'Old notes' });
      const updated = await updateTask(db, TIM, uuid(1), { reason: null, notes: null });
      expect(updated).toMatchObject({ reason: null, notes: null });
    });
  });

  describe('timeline notes', () => {
    it('adds a note with author and thread, and lists notes newest first', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'));
      await newTask(TIM, 1, 'proj-acme-solar');

      const note = await addTaskUpdate(
        db,
        TIM,
        uuid(1),
        'Updated PR with fixes',
        'gmail-thread-99'
      );
      expect(note).toMatchObject({
        taskId: uuid(1),
        authorId: TIM,
        authorName: 'Casey Example',
        note: 'Updated PR with fixes',
        gmailThreadId: 'gmail-thread-99',
      });

      vi.setSystemTime(new Date('2026-10-02T09:00:00.000Z'));
      await addTaskUpdate(db, ROBIN, uuid(1), 'Reviewed');

      const notes = await getTaskUpdates(db, TIM, uuid(1));
      expect(notes?.map((n) => [n.authorName, n.note])).toEqual([
        ['Jordan Example', 'Reviewed'],
        ['Casey Example', 'Updated PR with fixes'],
      ]);
      expect(await getTaskUpdates(db, STRANGER, uuid(1))).toBeNull();
    });

    it('returns null for tasks the user cannot see, and throws for viewers', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      expect(await addTaskUpdate(db, STRANGER, uuid(1), 'x')).toBeNull();
      await orgService.updateMemberRole(db, TIM, 'org-md', ROBIN, 'viewer');
      await expect(addTaskUpdate(db, ROBIN, uuid(1), 'x')).rejects.toBeInstanceOf(AccessError);
    });
  });

  describe('personal goals', () => {
    beforeEach(() => {
      raw.exec(`
        INSERT INTO Goals (id, user_id, type, title) VALUES
          ('goal-1', '${TIM}', 'aim', 'Health & Fitness'),
          ('goal-robin', '${ROBIN}', 'aim', 'Jordan aim');
      `);
    });

    it('links and unlinks a personal life goal, idempotently', async () => {
      await newTask(TIM, 1, 'proj-acme-solar');

      const linked = await linkPersonalGoal(db, TIM, uuid(1), 'goal-1');
      expect(linked).toMatchObject({ taskId: uuid(1), userId: TIM, goalId: 'goal-1' });
      const again = await linkPersonalGoal(db, TIM, uuid(1), 'goal-1');
      expect(again).toMatchObject({ taskId: uuid(1), goalId: 'goal-1' });

      expect(await getTaskPersonalGoals(db, TIM, uuid(1))).toEqual([
        expect.objectContaining({ goalId: 'goal-1', title: 'Health & Fitness', type: 'aim' }),
      ]);
      // Goals are private: Jordan sees none on the same shared task
      expect(await getTaskPersonalGoals(db, ROBIN, uuid(1))).toEqual([]);

      expect(await unlinkPersonalGoal(db, TIM, uuid(1), 'goal-1')).toBe(true);
      expect(await unlinkPersonalGoal(db, TIM, uuid(1), 'goal-1')).toBe(false);
      expect(await getTaskPersonalGoals(db, TIM, uuid(1))).toEqual([]);
    });

    it("rejects other people's goals and invisible tasks", async () => {
      await newTask(TIM, 1, 'proj-acme-solar');
      await expect(linkPersonalGoal(db, TIM, uuid(1), 'goal-robin')).rejects.toThrow(
        /Goal not found/
      );
      expect(await linkPersonalGoal(db, STRANGER, uuid(1), 'goal-1')).toBeNull();
      expect(await unlinkPersonalGoal(db, STRANGER, uuid(1), 'goal-1')).toBe(false);
      expect(await getTaskPersonalGoals(db, STRANGER, uuid(1))).toBeNull();
    });
  });
});
