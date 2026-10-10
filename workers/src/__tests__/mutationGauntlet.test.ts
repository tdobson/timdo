import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import organisationsApp from '../routes/organisations';
import tasksApp from '../routes/tasks';
import * as organisationService from '../services/organisationService';
import * as projectService from '../services/projectService';
import * as taskService from '../services/taskService';

vi.mock('../services/taskService');
vi.mock('../services/organisationService');
vi.mock('../services/projectService');

describe('Mutation Gauntlet: Multi-User Collaboration State Mutations', () => {
  let app: Hono<any>;
  let activeUserId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    activeUserId = 'user-alice';
    app = new Hono();
    // Simulate auth & db middleware with dynamic activeUserId
    app.use('*', async (c, next) => {
      c.set('userId', activeUserId);
      c.set('db', {} as any);
      await next();
    });
    app.route('/api/v2/tasks', tasksApp);
    app.route('/api/v2/organisations', organisationsApp);
  });

  // Mutation 1: Task creation with valid project -> Success 201
  it('Mutation 1: creates task with valid projectId returning 201', async () => {
    const createdTask = {
      id: 'task-101',
      projectId: 'proj-valid-1',
      reporterId: 'user-alice',
      assigneeId: null,
      title: 'Valid Project Task',
      status: 'do',
      priority: 8,
      size: '***',
      isDeleted: false,
    };
    vi.mocked(taskService.createTask).mockResolvedValueOnce(createdTask as any);

    const res = await app.request('/api/v2/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-valid-1',
        title: 'Valid Project Task',
        status: 'do',
        priority: 8,
        size: '***',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual(createdTask);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.anything(),
      'user-alice',
      expect.objectContaining({
        projectId: 'proj-valid-1',
        title: 'Valid Project Task',
      })
    );
  });

  // Mutation 2: Task creation without project -> Rejects with 400 Bad Request
  it('Mutation 2: rejects task creation when projectId is missing with 400', async () => {
    const res = await app.request('/api/v2/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Task Without Project',
        status: 'do',
        priority: 5,
        size: '***',
      }),
    });

    expect(res.status).toBe(400);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  // Mutation 3: 1-click claim task -> Assignee set to authenticated user; timeline event recorded
  it('Mutation 3: claims task by setting assignee to authenticated user and logs timeline note', async () => {
    const claimedTask = {
      id: 'task-202',
      projectId: 'proj-valid-1',
      reporterId: 'user-bob',
      assigneeId: 'user-alice',
      title: 'Claimable Task',
      status: 'do',
    };
    vi.mocked(taskService.claimTask).mockResolvedValueOnce(claimedTask as any);

    const res = await app.request('/api/v2/tasks/task-202/claim', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.assigneeId).toBe('user-alice');
    expect(taskService.claimTask).toHaveBeenCalledWith(expect.anything(), 'user-alice', 'task-202');

    // Add timeline update recording the claim event
    const claimNote = {
      id: 'note-1',
      taskId: 'task-202',
      authorId: 'user-alice',
      note: 'Claimed task',
    };
    vi.mocked(taskService.addTaskUpdate).mockResolvedValueOnce(claimNote as any);

    const noteRes = await app.request('/api/v2/tasks/task-202/updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: 'Claimed task',
      }),
    });

    expect(noteRes.status).toBe(201);
    const noteBody: any = await noteRes.json();
    expect(noteBody.authorId).toBe('user-alice');
    expect(taskService.addTaskUpdate).toHaveBeenCalledWith(
      expect.anything(),
      'user-alice',
      'task-202',
      'Claimed task',
      undefined
    );
  });

  // Mutation 4: Reassign task to teammate -> Assignee updated; visible in teammate's --mine view
  it('Mutation 4: reassigns task to teammate and shows up in teammate mine view', async () => {
    const reassignedTask = {
      id: 'task-303',
      projectId: 'proj-valid-1',
      reporterId: 'user-alice',
      assigneeId: 'user-taylor',
      title: 'Delegated Task',
      status: 'do',
    };
    vi.mocked(taskService.assignTask).mockResolvedValueOnce(reassignedTask as any);

    const assignRes = await app.request('/api/v2/tasks/task-303/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assigneeId: 'user-taylor',
      }),
    });

    expect(assignRes.status).toBe(200);
    const assignBody: any = await assignRes.json();
    expect(assignBody.assigneeId).toBe('user-taylor');
    expect(taskService.assignTask).toHaveBeenCalledWith(
      expect.anything(),
      'user-alice',
      'task-303',
      'user-taylor'
    );

    // Switch context to teammate (user-taylor)
    activeUserId = 'user-taylor';
    vi.mocked(taskService.getTasksForUser).mockResolvedValueOnce([reassignedTask] as any);

    const mineRes = await app.request('/api/v2/tasks?mine=true');
    expect(mineRes.status).toBe(200);
    const mineBody: any = await mineRes.json();
    expect(mineBody).toHaveLength(1);
    expect(mineBody[0].assigneeId).toBe('user-taylor');
    expect(taskService.getTasksForUser).toHaveBeenCalledWith(
      expect.anything(),
      'user-taylor',
      expect.objectContaining({
        mineOnly: true,
      })
    );
  });

  // Mutation 5: Awaiting status and awaitUntil auto-return
  it('Mutation 5: transitions task to awaiting status with awaitUntil and auto-returns when past due', async () => {
    const awaitingTask = {
      id: 'task-404',
      projectId: 'proj-valid-1',
      title: 'Vendor Response Awaiting',
      status: 'awaiting',
      awaitUntil: '2026-09-15',
    };
    vi.mocked(taskService.updateTask).mockResolvedValueOnce(awaitingTask as any);

    const res = await app.request('/api/v2/tasks/task-404', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'awaiting',
        awaitUntil: '2026-09-15',
      }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.status).toBe('awaiting');
    expect(body.awaitUntil).toBe('2026-09-15');

    // Verify rejection if status is awaiting but awaitUntil is missing
    const invalidRes = await app.request('/api/v2/tasks/task-404', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'awaiting',
      }),
    });
    expect(invalidRes.status).toBe(400);

    // Simulate auto-return cron trigger (processAwaitingReturns)
    vi.mocked(projectService.processAwaitingReturns).mockResolvedValueOnce({
      flipped: 1,
      total: 1,
    });

    const cronResult = await projectService.processAwaitingReturns({} as any);
    expect(cronResult.flipped).toBe(1);
    expect(cronResult.total).toBe(1);
  });

  // Mutation 6: Personal life goal isolation between users
  it('Mutation 6: links personal life goal for User A while User B sees no personal goal', async () => {
    // User A links goal
    const goalLinkA = {
      taskId: 'task-505',
      userId: 'user-alice',
      goalId: 'goal-health-a',
    };
    vi.mocked(taskService.linkPersonalGoal).mockResolvedValueOnce(goalLinkA as any);

    const linkRes = await app.request('/api/v2/tasks/task-505/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goalId: 'goal-health-a',
      }),
    });

    expect(linkRes.status).toBe(201);
    expect(taskService.linkPersonalGoal).toHaveBeenCalledWith(
      expect.anything(),
      'user-alice',
      'task-505',
      'goal-health-a'
    );

    // User A queries personal goals for task
    vi.mocked(taskService.getTaskPersonalGoals).mockResolvedValueOnce([
      {
        goalId: 'goal-health-a',
        title: 'Run Half Marathon',
        type: 'aim',
      },
    ] as any);

    const userAGoalsRes = await app.request('/api/v2/tasks/task-505/goals');
    expect(userAGoalsRes.status).toBe(200);
    const userAGoals: any = await userAGoalsRes.json();
    expect(userAGoals).toHaveLength(1);
    expect(userAGoals[0].goalId).toBe('goal-health-a');

    // Switch context to User B querying the exact same task
    activeUserId = 'user-bob';
    vi.mocked(taskService.getTaskPersonalGoals).mockResolvedValueOnce([] as any);

    const userBGoalsRes = await app.request('/api/v2/tasks/task-505/goals');
    expect(userBGoalsRes.status).toBe(200);
    const userBGoals: any = await userBGoalsRes.json();
    expect(userBGoals).toHaveLength(0); // isolated from User A's goal
    expect(taskService.getTaskPersonalGoals).toHaveBeenCalledWith(
      expect.anything(),
      'user-bob',
      'task-505'
    );
  });

  // Mutation 7: Invite link token redemption
  it('Mutation 7: redeems invite link token and adds user as org member', async () => {
    activeUserId = 'user-carol';
    vi.mocked(organisationService.acceptInvite).mockResolvedValueOnce({
      success: true,
      orgId: 'org-northstar',
      role: 'member',
    } as any);

    const acceptRes = await app.request('/api/v2/organisations/invites/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'invite-token-secure-123',
      }),
    });

    expect(acceptRes.status).toBe(200);
    const acceptBody: any = await acceptRes.json();
    expect(acceptBody.success).toBe(true);
    expect(acceptBody.orgId).toBe('org-northstar');
    expect(acceptBody.role).toBe('member');
    expect(organisationService.acceptInvite).toHaveBeenCalledWith(
      expect.anything(),
      'user-carol',
      'invite-token-secure-123'
    );
  });
});
