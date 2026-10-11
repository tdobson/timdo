import { describe, expect, it } from 'vitest';
import * as activityService from '../services/activityService';
import * as epicService from '../services/epicService';
import { getOrganisationMembers } from '../services/organisationService';
import { addProjectUpdate, getProjectUpdates, getTaskView } from '../services/projectService';
import * as refService from '../services/refService';
import { bindActorContext } from '../services/requestActorContext';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

function insertBot(
  raw: any,
  { id = 'bot|projection-001', name = 'Fixture Observer', disabledAt = null } = {}
) {
  raw
    .prepare(
      "INSERT INTO Users (id, email, name, kind, bot_org_id, created_by, disabled_at) VALUES (?, ?, ?, 'bot', 'org-md', ?, ?)"
    )
    .run(id, `bot+${id.slice(4)}@bots.timdo.invalid`, name, TIM, disabledAt);
  return id;
}

describe('request provenance and safe bot projections', () => {
  it('records request-local token provenance without persisting the credential', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    bindActorContext(db, { via: 'token', viaDetail: 'fixture reader' });

    await activityService.logActivity(db, {
      actorId: ROBIN,
      orgId: 'org-md',
      entityType: 'member',
      entityId: ROBIN,
      action: 'fixture_action',
      summary: 'Fixture action',
    });

    expect(
      raw.prepare('SELECT via, via_detail FROM ActivityLog WHERE action = ?').get('fixture_action')
    ).toEqual({
      via: 'token',
      via_detail: 'fixture reader',
    });
    expect(JSON.stringify(raw.prepare('SELECT * FROM ActivityLog').all())).not.toContain('tdo_');
  });

  it('leaves direct service activity provenance null unless a context was bound', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);

    await activityService.logActivity(db, {
      actorId: TIM,
      orgId: 'org-md',
      entityType: 'member',
      entityId: TIM,
      action: 'unbound_action',
      summary: 'Fixture action',
    });

    expect(
      raw.prepare('SELECT via, via_detail FROM ActivityLog WHERE action = ?').get('unbound_action')
    ).toEqual({
      via: null,
      via_detail: null,
    });
  });

  it('projects bot names and kinds without exposing their synthetic email', async () => {
    const { db, raw } = createTestDb();
    seedCollaboration(raw);
    const botId = insertBot(raw);
    raw
      .prepare(
        "INSERT INTO Projects (id, org_id, key, name) VALUES ('projection-project', 'org-md', 'PRJ', 'Fixture Project')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO Tasks (id, project_id, reporter_id, assignee_id, updated_by, title) VALUES ('projection-task', 'projection-project', ?, ?, ?, 'Fixture task')"
      )
      .run(botId, ROBIN, botId);
    raw
      .prepare(
        "INSERT INTO ActivityLog (id, actor_id, org_id, project_id, entity_type, entity_id, task_id, action, summary, via, via_detail) VALUES ('bot-activity', ?, 'org-md', 'projection-project', 'task', 'projection-task', 'projection-task', 'created', 'Fixture task created', 'owner_secret', NULL)"
      )
      .run(botId);

    const members = await getOrganisationMembers(db, 'org-md');
    const botMember = members.find((member: any) => member.userId === botId);
    const task = await getTaskView(db, TIM, 'projection-task');
    const activity = await activityService.getActivity(db, TIM, { taskId: 'projection-task' });

    expect(botMember).toMatchObject({ kind: 'bot', userName: 'Fixture Observer', role: 'member' });
    expect(Object.hasOwn(botMember as object, 'userEmail')).toBe(false);
    expect(task).toMatchObject({
      reporterKind: 'bot',
      reporterName: 'Fixture Observer',
      assigneeKind: 'human',
      updatedByKind: 'bot',
    });
    expect(activity[0]).toMatchObject({
      actorKind: 'bot',
      actorName: 'Fixture Observer',
      via: 'owner_secret',
      viaDetail: null,
    });

    const addedNote = await addProjectUpdate(db, {
      projectId: 'projection-task',
      userId: botId,
      note: 'Fixture bot note',
    });
    const notes = await getProjectUpdates(db, 'projection-task', TIM);
    const addedRef = await refService.addRef(db, botId, 'projection-task', {
      ref: 'https://example.test/fixture',
      role: 'link',
    });
    const epic = await epicService.createEpic(db, botId, {
      title: 'Fixture bot epic',
      projectId: 'projection-project',
    });

    expect(addedNote?.authorKind).toBe('bot');
    expect(notes?.find((note) => note.note === 'Fixture bot note')?.authorKind).toBe('bot');
    expect(addedRef.ref.createdByKind).toBe('bot');
    expect(epic).toMatchObject({ createdByKind: 'bot', updatedByKind: 'bot' });
    expect(
      JSON.stringify({ members, task, activity, addedNote, notes, addedRef, epic }).includes(
        'bots.timdo.invalid'
      )
    ).toBe(false);
  });
});
