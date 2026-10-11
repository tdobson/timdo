import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAccessibleProjects } from '../services/accessService';
import activityApp from '../routes/activity';
import * as epicService from '../services/epicService';
import { createTestDb } from './helpers/testDb';
import { boardScaleTaskId, CASEY_ID, JORDAN_ID, seedBoardScale } from './fixtures/boardScaleFixture';

function createApi(db: any, userId = JORDAN_ID) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('db', db);
    await next();
  });
  app.route('/api/v2/activity', activityApp);
  return app;
}

function insertActivity(
  raw: any,
  {
    id,
    orgId,
    projectId,
    taskId,
    epicId = null,
    actorId = CASEY_ID,
    createdAt,
    summary,
  }: {
    id: string;
    orgId: string | null;
    projectId: string | null;
    taskId: string | null;
    epicId?: string | null;
    actorId?: string | null;
    createdAt: string;
    summary: string;
  }
) {
  raw.prepare(`
    INSERT INTO ActivityLog (
      id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id,
      action, summary, created_at
    ) VALUES (?, ?, ?, ?, 'task', ?, ?, ?, 'updated', ?, ?)
  `).run(id, actorId, orgId, projectId, taskId ?? id, taskId, epicId, summary, createdAt);
}

describe('activity API at board scale', () => {
  let db: any;
  let raw: any;
  let stats: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedBoardScale(raw);
    app = createApi(db);
  });

  it('filters membership before limit and supports a viewer across more than 100 projects', async () => {
    const targetTaskId = boardScaleTaskId(998);
    const projects = await getAccessibleProjects(db, JORDAN_ID);
    expect(projects.length).toBeGreaterThan(100);
    expect(projects.find((project: any) => project.id === 'project-viewer')?.role).toBe('viewer');

    insertActivity(raw, {
      id: 'activity-visible-viewer',
      orgId: 'org-viewer',
      projectId: 'project-viewer',
      taskId: targetTaskId,
      epicId: 'scale-epic',
      createdAt: '2026-10-10T12:00:00.000Z',
      summary: 'Visible viewer activity',
    });
    insertActivity(raw, {
      id: 'activity-visible-member',
      orgId: 'org-md',
      projectId: 'scale-project-000',
      taskId: boardScaleTaskId(0),
      createdAt: '2026-10-09T12:00:00.000Z',
      summary: 'Visible member activity',
    });
    for (let index = 0; index < 12; index++) {
      insertActivity(raw, {
        id: `activity-private-${String(index).padStart(2, '0')}`,
        orgId: 'org-casey',
        projectId: 'proj-personal',
        taskId: boardScaleTaskId(999),
        createdAt: `2026-10-11T12:00:${String(index).padStart(2, '0')}.000Z`,
        summary: `Private activity ${index}`,
      });
    }

    stats.reset();
    const taskResponse = await app.request(
      `/api/v2/activity?taskId=${encodeURIComponent(targetTaskId)}&limit=10`
    );
    expect(taskResponse.status).toBe(200);
    expect(await taskResponse.json()).toMatchObject([
      { id: 'activity-visible-viewer', summary: 'Visible viewer activity' },
    ]);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);

    for (const filter of ['epicId=scale-epic', 'projectId=project-viewer', 'orgId=org-viewer']) {
      const response = await app.request(`/api/v2/activity?${filter}&limit=10`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        { id: 'activity-visible-viewer', summary: 'Visible viewer activity' },
      ]);
    }

    const limitedResponse = await app.request('/api/v2/activity?limit=1');
    expect(limitedResponse.status).toBe(200);
    expect(await limitedResponse.json()).toMatchObject([
      { id: 'activity-visible-viewer', summary: 'Visible viewer activity' },
    ]);
    const feedResponse = await app.request('/api/v2/activity?limit=10');
    expect(feedResponse.status).toBe(200);
    const feed = (await feedResponse.json()) as any[];
    expect(feed.map((entry) => entry.id)).toEqual([
      'activity-visible-viewer',
      'activity-visible-member',
    ]);
    expect(feed.some((entry) => entry.summary.startsWith('Private activity'))).toBe(false);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('does not expose a private epic goal in shared activity', async () => {
    await epicService.updateEpic(db, CASEY_ID, 'scale-epic', {
      goalId: 'scale-goal-casey',
      title: 'Renamed scale fixture epic',
    });

    const response = await app.request('/api/v2/activity?epicId=scale-epic&limit=10');
    expect(response.status).toBe(200);
    const entries = (await response.json()) as any[];
    expect(entries).toMatchObject([
      {
        action: 'updated',
        summary: 'Updated title on epic "Renamed scale fixture epic"',
        changes: { title: { from: 'Scale fixture epic', to: 'Renamed scale fixture epic' } },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('scale-goal-casey');
    expect(JSON.stringify(entries)).not.toContain('Private fixture goal');
  });
});
