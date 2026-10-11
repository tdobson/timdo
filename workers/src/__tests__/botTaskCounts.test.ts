import { describe, expect, it } from 'vitest';
import * as botService from '../services/botService';
import * as taskService from '../services/taskService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

function addBot(raw: any, id: string, name: string) {
  const suffix = id.slice(4);
  raw
    .prepare(
      "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by) VALUES (?, ?, ?, 'bot', 'org-md', ?)"
    )
    .run(id, `bot+${suffix}@bots.timdo.invalid`, name, TIM);
}

describe('visible bot task creation counts', () => {
  it('counts task-created activity produced by the actual task service and includes zero-count bots', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    addBot(raw, 'bot|count-001', 'Fixture Recorder');
    addBot(raw, 'bot|count-002', 'Fixture Observer');

    await taskService.createTask(db, 'bot|count-001', {
      id: 'bot-created-task',
      projectId: 'proj-acme-solar',
      title: 'Fixture task from bot',
      status: 'do',
      priority: 5,
      size: '***',
      onDuplicate: 'error',
    });
    expect(
      raw.prepare('SELECT assignee_id FROM Tasks WHERE id = ?').get('bot-created-task').assignee_id
    ).toBeNull();

    const result = await botService.getBotTaskCreationCounts(db, TIM, {
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 50,
    });

    expect(result).toEqual({
      items: [
        {
          botId: 'bot|count-001',
          botName: 'Fixture Recorder',
          orgId: 'org-md',
          orgName: 'Northstar Workshop',
          tasksCreated: 1,
        },
        {
          botId: 'bot|count-002',
          botName: 'Fixture Observer',
          orgId: 'org-md',
          orgName: 'Northstar Workshop',
          tasksCreated: 0,
        },
      ],
      total: 2,
    });
  });

  it('includes a disabled bot only when it has visible task history and truncates to 50', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    for (let index = 1; index <= 51; index++) {
      addBot(
        raw,
        `bot|count-${String(index).padStart(3, '0')}`,
        `Fixture Bot ${String(index).padStart(3, '0')}`
      );
    }
    raw
      .prepare(
        "INSERT INTO Projects (id, org_id, key, name) VALUES ('count-project', 'org-md', 'CNT', 'Fixture Counts')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO Tasks (id, project_id, reporter_id, title) VALUES ('count-task', 'count-project', 'bot|count-001', 'Fixture task')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO ActivityLog (id, actor_id, org_id, project_id, entity_type, entity_id, task_id, action, summary) VALUES ('count-event', 'bot|count-001', 'org-md', 'count-project', 'task', 'count-task', 'count-task', 'created', 'not returned')"
      )
      .run();
    raw
      .prepare(
        "UPDATE Users SET disabled_at = '2026-10-11T00:00:00.000Z' WHERE id = 'bot|count-001'"
      )
      .run();
    raw.prepare("DELETE FROM OrganisationMembers WHERE user_id = 'bot|count-001'").run();
    raw
      .prepare(
        "UPDATE Users SET disabled_at = '2026-10-11T00:00:00.000Z' WHERE id = 'bot|count-002'"
      )
      .run();
    raw.prepare("DELETE FROM OrganisationMembers WHERE user_id = 'bot|count-002'").run();

    const result = await botService.getBotTaskCreationCounts(db, TIM, {
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 99,
    });

    expect(result.total).toBe(50);
    expect(result.items).toHaveLength(50);
    expect(
      result.items.some((item) => item.botId === 'bot|count-001' && item.tasksCreated === 1)
    ).toBe(true);
    expect(result.items.some((item) => item.botId === 'bot|count-002')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('not returned');
    expect(JSON.stringify(result).includes('bots.timdo.invalid')).toBe(false);
  });
});
