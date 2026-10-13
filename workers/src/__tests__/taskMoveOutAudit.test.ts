import { beforeEach, describe, expect, it } from 'vitest';
import * as projectService from '../services/projectService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function newTask(db: any, id: string, category: string) {
  return projectService.createProject(db, TIM, {
    id,
    project: `Task ${id}`,
    status: 'do',
    priority: 5,
    size: '***',
    category,
  });
}

describe('task cross-workspace move-out audit', () => {
  let db: any;
  let raw: any;

  beforeEach(() => {
    ({ db, raw } = createTestDb());
    seedCollaboration(raw);
  });

  it('writes one generic source marker only after a successful cross-workspace move', async () => {
    const id = taskId(1);
    await newTask(db, id, 'Acme Solar');
    const moved = await projectService.updateProject(db, TIM, id, { projectId: 'proj-personal' });
    expect(moved?.projectId).toBe('proj-personal');

    const markers = raw
      .prepare("SELECT * FROM ActivityLog WHERE entity_type = 'task' AND action = 'moved_out'")
      .all();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      actor_id: TIM,
      org_id: 'org-md',
      project_id: null,
      entity_id: id,
      task_id: id,
      epic_id: null,
      action: 'moved_out',
      summary: 'Task moved out of this workspace',
      changes: null,
    });
    expect(markers[0].summary).not.toContain('Personal');
    expect(markers[0].summary).not.toContain(id);

    const destination = raw
      .prepare(
        "SELECT org_id, project_id, action FROM ActivityLog WHERE task_id = ? AND action = 'moved'"
      )
      .all(id);
    expect(destination).toEqual([
      { org_id: 'org-tim', project_id: 'proj-personal', action: 'moved' },
    ]);
  });

  it('records destination movement as well as deletion for a move-plus-delete', async () => {
    const id = taskId(4);
    await newTask(db, id, 'Acme Solar');

    const updated = await projectService.updateProject(db, TIM, id, {
      projectId: 'proj-personal',
      isDeleted: true,
    });
    expect(updated).toMatchObject({ projectId: 'proj-personal', isDeleted: true });

    const events = raw
      .prepare('SELECT org_id, project_id, action FROM ActivityLog WHERE task_id = ? ORDER BY seq')
      .all(id);
    expect(events).toEqual([
      { org_id: 'org-md', project_id: 'proj-acme-solar', action: 'created' },
      { org_id: 'org-tim', project_id: 'proj-personal', action: 'deleted' },
      { org_id: 'org-tim', project_id: 'proj-personal', action: 'moved' },
      { org_id: 'org-md', project_id: null, action: 'moved_out' },
    ]);
    expect(events.filter((event: any) => event.action === 'moved_out')).toHaveLength(1);
  });
});
