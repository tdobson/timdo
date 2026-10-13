import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../index';
import { onApiError } from '../middleware/apiErrors';
import eventsApp from '../routes/events';
import * as epicService from '../services/epicService';
import * as eventService from '../services/eventsFeedService';
import * as organisationService from '../services/organisationService';
import * as projectService from '../services/projectService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TASK = 'task-feed-1';
const EPIC = 'epic-feed-1';
const iso = (second: number) => `2026-10-11T12:00:${String(second).padStart(2, '0')}.000Z`;

function d1Binding(raw: any) {
  return {
    prepare(query: string) {
      return {
        bind(...params: any[]) {
          return {
            raw: async () => {
              const statement = raw.prepare(query);
              statement.setReturnArrays(true);
              return statement.all(...params);
            },
          };
        },
      };
    },
  } as any;
}

type ActivityInput = Partial<{
  id: string | null;
  actorId: string | null;
  orgId: string | null;
  projectId: string | null;
  entityType: string;
  entityId: string;
  taskId: string | null;
  epicId: string | null;
  action: string;
  summary: string;
  changes: string | null;
  via: string | null;
  viaDetail: string | null;
  createdAt: string | null;
}>;

function insertTask(raw: any, id = TASK, projectId = 'proj-acme-solar', title = 'Fixture task') {
  raw
    .prepare(
      `
    INSERT INTO Tasks (id, project_id, reporter_id, title, status, priority, size, is_deleted)
    VALUES (?, ?, ?, ?, 'do', 5, '***', 0)
  `
    )
    .run(id, projectId, TIM, title);
}

function insertActivity(raw: any, input: ActivityInput = {}) {
  raw
    .prepare(
      `
    INSERT INTO ActivityLog (
      id, actor_id, org_id, project_id, entity_type, entity_id, task_id, epic_id,
      action, summary, changes, via, via_detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      input.id === undefined ? `event-${Math.random().toString(36).slice(2)}` : input.id,
      input.actorId === undefined ? TIM : input.actorId,
      input.orgId === undefined ? 'org-md' : input.orgId,
      input.projectId === undefined ? 'proj-acme-solar' : input.projectId,
      input.entityType ?? 'task',
      input.entityId ?? TASK,
      input.taskId === undefined ? TASK : input.taskId,
      input.epicId ?? null,
      input.action ?? 'created',
      input.summary ?? 'Created fixture task',
      input.changes ?? null,
      input.via === undefined ? 'web' : input.via,
      input.viaDetail === undefined ? null : input.viaDetail,
      input.createdAt === undefined ? iso(1) : input.createdAt
    );
}

function createApi(db: any, userId = TIM, userKind: 'human' | 'bot' = 'human') {
  const app = new Hono<any>();
  app.onError(onApiError);
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('userId', userId);
    c.set('userKind', userKind);
    c.set('authMethod', 'internal');
    await next();
  });
  app.route('/api/v2/events', eventsApp);
  return app;
}

async function getEvents(app: Hono<any>, query = '', key: string | undefined = KEY) {
  return app.request(`/api/v2/events${query ? `?${query}` : ''}`, { method: 'GET' }, {
    EVENT_CURSOR_KEY: key,
  } as any);
}

function addWorkspace(raw: any, id: string, slug: string, memberId: string, userId = TIM) {
  raw
    .prepare(
      'INSERT INTO Organisations (id, name, slug, created_by, is_personal) VALUES (?, ?, ?, ?, 0)'
    )
    .run(id, `Workspace ${id}`, slug, TIM);
  raw
    .prepare(
      "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES (?, ?, ?, 'member')"
    )
    .run(memberId, id, userId);
}

describe('recorded events API', () => {
  let db: any;
  let raw: any;
  let stats: any;
  let app: Hono<any>;

  beforeEach(() => {
    ({ db, raw, stats } = createTestDb());
    seedCollaboration(raw);
    insertTask(raw);
    raw
      .prepare(
        `
      INSERT INTO Epics (id, user_id, title, status, project_id)
      VALUES (?, ?, ?, 'active', ?)
    `
      )
      .run(EPIC, TIM, 'Private fixture epic title', 'proj-acme-solar');
    app = createApi(db);
  });

  it('registers authenticated cursor routes and marks pre-route auth errors no-store', async () => {
    const env = {
      DB: {},
      AUTH0_DOMAIN: 'fictional.example.test',
      AUTH0_AUDIENCE: 'fixture-audience',
      GROQ_API_KEY: 'unused-fixture',
      INTERNAL_API_SECRET: 'unused-fixture',
      EVENT_CURSOR_KEY: KEY,
    } as any;
    const events = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/events?after=0'),
      env,
      {} as any
    );
    expect(events.status).toBe(401);
    expect(events.headers.get('Cache-Control')).toBe('no-store');

    const activity = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/activity?paged=1'),
      env,
      {} as any
    );
    expect(activity.status).toBe(401);
    expect(activity.headers.get('Cache-Control')).toBe('no-store');

    const headers = {
      Origin: 'https://timdo.tdobson.net',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization',
    };
    const eventsPreflight = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/events?after=0', {
        method: 'OPTIONS',
        headers,
      }),
      env,
      {} as any
    );
    expect(eventsPreflight.status).toBe(204);
    expect(eventsPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://timdo.tdobson.net'
    );
    expect(eventsPreflight.headers.get('Cache-Control')).toBe('no-store');

    const pagedActivityPreflight = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/activity?paged=1', {
        method: 'OPTIONS',
        headers,
      }),
      env,
      {} as any
    );
    expect(pagedActivityPreflight.status).toBe(204);
    expect(pagedActivityPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://timdo.tdobson.net'
    );
    expect(pagedActivityPreflight.headers.get('Cache-Control')).toBe('no-store');

    const legacyActivityPreflight = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/activity', { method: 'OPTIONS', headers }),
      env,
      {} as any
    );
    expect(legacyActivityPreflight.status).toBe(204);
    expect(legacyActivityPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://timdo.tdobson.net'
    );
    expect(legacyActivityPreflight.headers.get('Cache-Control')).toBeNull();
  });

  it('keeps no-store and CORS headers on a successful full-worker cursor response', async () => {
    const env = {
      DB: d1Binding(raw),
      AUTH0_DOMAIN: 'fictional.example.test',
      AUTH0_AUDIENCE: 'fixture-audience',
      GROQ_API_KEY: 'unused-fixture',
      INTERNAL_API_SECRET: 'fixture-internal-secret',
      EVENT_CURSOR_KEY: KEY,
    } as any;
    const response = await (worker as any).fetch(
      new Request('https://timdo.example.test/api/v2/events?after=0', {
        headers: {
          Origin: 'https://timdo.tdobson.net',
          'X-Internal-Secret': 'fixture-internal-secret',
          'X-Timdo-User': 'casey@example.test',
        },
      }),
      env,
      {} as any
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://timdo.tdobson.net');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a strict default projection and only adds canonical refs and text by opt-in', async () => {
    raw
      .prepare("UPDATE Tasks SET title = 'Confidential task title', status = 'done' WHERE id = ?")
      .run(TASK);
    raw.prepare("UPDATE Users SET name = 'Casey Example' WHERE id = ?").run(TIM);
    raw
      .prepare(
        `
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, label, created_by)
      VALUES ('ref-feed-1', ?, 'org-md', 'source', 'forum.post', 'post-17', 'https://private.example.test/post-17', 'Private display label', ?)
    `
      )
      .run(TASK, TIM);
    insertActivity(raw, {
      id: 'event-default',
      action: 'completed',
      summary: 'Completed confidential task',
      changes: JSON.stringify({
        status: { from: 'do', to: 'done' },
        title: { from: 'Old', to: 'Confidential task title' },
        goalId: { from: null, to: 'private-goal-id' },
      }),
      via: 'token',
      viaDetail: 'Private personal token name',
      createdAt: iso(1),
    });

    const response = await getEvents(app);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json<any>();
    expect(body.version).toBe(1);
    expect(body.events).toEqual([
      {
        id: 'event-default',
        type: 'task.completed',
        occurredAt: iso(1),
        workspaceId: 'org-md',
        projectId: 'proj-acme-solar',
        taskId: TASK,
        epicId: null,
        actor: { id: TIM, kind: 'human' },
        via: 'token',
        changes: { status: { from: 'do', to: 'done' } },
        task: { id: TASK, status: 'done', deleted: false },
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /Confidential|Private|goalId|viaDetail|forum\.post|post-17|https:/
    );

    const optedIn = await getEvents(app, 'include=refs,text');
    const optedBody = await optedIn.json<any>();
    expect(optedBody.events[0]).toMatchObject({
      summary: 'Completed confidential task',
      actor: { id: TIM, kind: 'human', name: 'Casey Example' },
      task: {
        id: TASK,
        status: 'done',
        deleted: false,
        title: 'Confidential task title',
        refs: [{ role: 'source', ref: 'forum.post:post-17' }],
      },
    });
    const serialised = JSON.stringify(optedBody);
    expect(serialised).not.toContain('Private display label');
    expect(serialised).not.toContain('https://private.example.test');
    expect(serialised).not.toContain('Private personal token name');
    expect(serialised).not.toContain('private-goal-id');
    expect(optedBody.events[0]).not.toHaveProperty('seq');
  });

  it('suppresses deleted note text, actor names, task titles, and refs without tombstoning a live task', async () => {
    const noteText = 'Current note text contains private detail';
    const taskTitle = 'Current task title stays private here';
    raw.prepare('UPDATE Tasks SET title = ? WHERE id = ?').run(taskTitle, TASK);
    raw.prepare("UPDATE Users SET name = 'Note Author Name' WHERE id = ?").run(TIM);
    raw
      .prepare(
        `
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, label, created_by)
      VALUES ('note-ref-row', ?, 'org-md', 'link', 'forum.post', 'note-ref-private', 'https://private.example.test/note', 'Private ref label', ?)
    `
      )
      .run(TASK, TIM);

    const note = await projectService.addProjectUpdate(db, {
      projectId: TASK,
      userId: TIM,
      note: noteText,
    });
    expect(note).toBeTruthy();

    const livePage = await eventService.getEventsPage(
      db,
      KEY,
      { userId: TIM, userKind: 'human' },
      eventService.parseEventsQuery({ include: 'refs,text' })
    );
    const liveEvent = livePage.events.find((event) => event.type === 'note.added');
    expect(liveEvent).toMatchObject({
      summary: `Added a note to "${taskTitle}": ${noteText}`,
      actor: { name: 'Note Author Name' },
      task: {
        id: TASK,
        deleted: false,
        title: taskTitle,
        refs: [{ role: 'link', ref: 'forum.post:note-ref-private' }],
      },
    });

    const liveRecent = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      }
    );
    expect(liveRecent.events.find((event) => event.type === 'note.added')?.summary).toContain(
      noteText
    );

    expect(
      await projectService.deleteProjectUpdate(db, {
        updateId: note!.id,
        projectId: TASK,
        userId: TIM,
      })
    ).toBe(true);
    const deletedPage = await eventService.getEventsPage(
      db,
      KEY,
      { userId: TIM, userKind: 'human' },
      eventService.parseEventsQuery({ include: 'refs,text' })
    );
    const deletedNoteEvents = deletedPage.events.filter(
      (event) => event.type === 'note.added' || event.type === 'note.deleted'
    );
    expect(deletedNoteEvents.map((event) => event.type)).toEqual(['note.added', 'note.deleted']);
    for (const event of deletedNoteEvents) {
      expect(event).not.toHaveProperty('summary');
      expect(event.actor).not.toHaveProperty('name');
      expect(event.task).toMatchObject({ id: TASK, deleted: false });
      expect(event.task).not.toHaveProperty('title');
      expect(event.task).not.toHaveProperty('refs');
    }
    const deletedRecent = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      }
    );
    const recentNoteEvents = deletedRecent.events.filter(
      (event) => event.type === 'note.added' || event.type === 'note.deleted'
    );
    expect(recentNoteEvents.map((event) => event.summary)).toEqual([null, null]);
    const serialised = JSON.stringify({ deletedNoteEvents, recentNoteEvents });
    expect(serialised).not.toContain(noteText);
    expect(serialised).not.toContain(taskTitle);
    expect(serialised).not.toContain('Note Author Name');
    expect(serialised).not.toContain('note-ref-private');
    expect(serialised).not.toContain('Private ref label');
    expect(serialised).not.toContain('https://private.example.test/note');
  });

  it('suppresses text for deleted and missing epic or project entities', async () => {
    raw.prepare("UPDATE Users SET name = 'Entity Actor Name' WHERE id = ?").run(TIM);
    insertActivity(raw, {
      id: 'live-epic-text',
      entityType: 'epic',
      entityId: EPIC,
      taskId: null,
      epicId: EPIC,
      action: 'updated',
      summary: 'Live epic text is available',
      createdAt: new Date().toISOString(),
    });
    insertActivity(raw, {
      id: 'live-project-text',
      entityType: 'project',
      entityId: 'proj-acme-solar',
      taskId: null,
      action: 'archived',
      summary: 'Live project text is available',
      createdAt: new Date().toISOString(),
    });
    const livePage = await getEvents(app, 'include=text');
    const liveEvents = (await livePage.json<any>()).events;
    expect(liveEvents.find((event: any) => event.id === 'live-epic-text')).toMatchObject({
      summary: 'Live epic text is available',
      actor: { name: 'Entity Actor Name' },
    });
    expect(liveEvents.find((event: any) => event.id === 'live-project-text')).toMatchObject({
      summary: 'Live project text is available',
      actor: { name: 'Entity Actor Name' },
    });

    expect(await epicService.deleteEpic(db, TIM, EPIC)).toBe(true);
    insertActivity(raw, {
      id: 'missing-epic-text',
      entityType: 'epic',
      entityId: 'epic-missing-feed',
      taskId: null,
      epicId: 'epic-missing-feed',
      action: 'updated',
      summary: 'Missing epic private title',
      createdAt: new Date().toISOString(),
    });
    insertActivity(raw, {
      id: 'deleted-project-text',
      entityType: 'project',
      entityId: 'proj-acme-solar',
      taskId: null,
      projectId: 'proj-acme-solar',
      action: 'archived',
      summary: 'Deleted project private title',
      createdAt: new Date().toISOString(),
    });
    raw.prepare('DELETE FROM Projects WHERE id = ?').run('proj-acme-solar');
    insertActivity(raw, {
      id: 'missing-project-text',
      entityType: 'project',
      entityId: 'project-missing-feed',
      taskId: null,
      projectId: null,
      action: 'renamed',
      summary: 'Missing project private title',
      createdAt: new Date().toISOString(),
    });

    const response = await getEvents(app, 'include=text');
    expect(response.status).toBe(200);
    const events = (await response.json<any>()).events;
    const knownTombstones = events.filter((event: any) =>
      [
        'live-epic-text',
        'missing-epic-text',
        'live-project-text',
        'deleted-project-text',
        'missing-project-text',
      ].includes(event.id)
    );
    const deletedEpic = events.find((event: any) => event.type === 'epic.deleted');
    const tombstones = [...knownTombstones, ...(deletedEpic ? [deletedEpic] : [])];
    expect(knownTombstones.map((event: any) => event.id).sort()).toEqual([
      'deleted-project-text',
      'live-epic-text',
      'live-project-text',
      'missing-epic-text',
      'missing-project-text',
    ]);
    expect(deletedEpic).toBeDefined();
    for (const event of tombstones) {
      expect(event).not.toHaveProperty('summary');
      expect(event.actor).not.toHaveProperty('name');
    }
    expect(deletedEpic.epicId).toBe(EPIC);
    expect(events.find((event: any) => event.id === 'deleted-project-text')?.projectId).toBeNull();
    const recent = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      }
    );
    const recentTombstones = recent.events.filter((event) =>
      ['epic.deleted', 'epic.updated', 'project.archived', 'project.renamed'].includes(event.type)
    );
    expect(recentTombstones.length).toBeGreaterThanOrEqual(6);
    expect(recentTombstones.every((event) => event.summary === null)).toBe(true);
    const serialised = JSON.stringify({ tombstones, recentTombstones });
    expect(serialised).not.toContain('Entity Actor Name');
    expect(serialised).not.toContain('Live epic text is available');
    expect(serialised).not.toContain('Missing epic private title');
    expect(serialised).not.toContain('Live project text is available');
    expect(serialised).not.toContain('Deleted project private title');
    expect(serialised).not.toContain('Missing project private title');
  });

  it('hydrates current note records in batches of no more than 90 IDs', async () => {
    const insertNote = raw.prepare(
      'INSERT INTO TaskUpdates (id, task_id, author_id, note) VALUES (?, ?, ?, ?)'
    );
    for (let index = 0; index < 185; index++) {
      const id = `scale-note-${index}`;
      insertNote.run(id, TASK, TIM, `Current note ${index}`);
      insertActivity(raw, {
        id: `scale-note-event-${index}`,
        entityType: 'note',
        entityId: id,
        taskId: TASK,
        action: 'note_added',
        summary: `Added current note ${index}`,
      });
    }
    stats.reset();

    const response = await getEvents(app, 'include=text&limit=500');
    expect(response.status).toBe(200);
    expect((await response.json<any>()).events).toHaveLength(185);
    const noteQueries = stats.statements.filter((statement: any) =>
      /TaskUpdates/i.test(statement.sql)
    );
    expect(noteQueries.length).toBeGreaterThanOrEqual(4);
    expect(noteQueries.every((statement: any) => statement.parameterCount <= 91)).toBe(true);
  });

  it('maps every registered stored entity/action pair and skips unknown or unusable IDs', async () => {
    const cases: Array<[string, string, string]> = [
      ['task', 'created', 'task.created'],
      ['task', 'updated', 'task.updated'],
      ['task', 'status_changed', 'task.status_changed'],
      ['task', 'completed', 'task.completed'],
      ['task', 'assigned', 'task.assigned'],
      ['task', 'moved', 'task.moved'],
      ['task', 'deleted', 'task.deleted'],
      ['task', 'restored', 'task.restored'],
      ['task', 'merged', 'task.merged'],
      ['task', 'linked', 'task.linked'],
      ['task', 'ref_added', 'ref.added'],
      ['task', 'ref_removed', 'ref.removed'],
      ['note', 'note_added', 'note.added'],
      ['note', 'note_deleted', 'note.deleted'],
      ['epic', 'created', 'epic.created'],
      ['epic', 'updated', 'epic.updated'],
      ['epic', 'status_changed', 'epic.status_changed'],
      ['epic', 'completed', 'epic.completed'],
      ['epic', 'moved', 'epic.moved'],
      ['epic', 'deleted', 'epic.deleted'],
      ['project', 'created', 'project.created'],
      ['project', 'renamed', 'project.renamed'],
      ['project', 'archived', 'project.archived'],
      ['project', 'unarchived', 'project.unarchived'],
      ['organisation', 'created', 'organisation.created'],
      ['organisation', 'renamed', 'organisation.renamed'],
      ['member', 'member_added', 'member.added'],
      ['member', 'invited', 'member.invited'],
      ['member', 'member_joined', 'member.joined'],
      ['member', 'role_changed', 'member.role_changed'],
      ['member', 'member_left', 'member.left'],
      ['member', 'member_removed', 'member.removed'],
      ['member', 'bot_created', 'bot.created'],
      ['member', 'bot_renamed', 'bot.renamed'],
      ['member', 'bot_role_changed', 'bot.role_changed'],
      ['member', 'bot_disabled', 'bot.disabled'],
      ['member', 'bot_token_created', 'bot.token_created'],
      ['member', 'bot_token_revoked', 'bot.token_revoked'],
    ];
    cases.forEach(([entityType, action], index) => {
      insertActivity(raw, {
        id: `registry-${index}`,
        entityType,
        entityId:
          entityType === 'project'
            ? 'proj-acme-solar'
            : entityType === 'epic'
              ? EPIC
              : `entity-${index}`,
        taskId: entityType === 'task' || entityType === 'note' ? TASK : null,
        epicId: entityType === 'epic' ? EPIC : null,
        action,
        projectId:
          entityType === 'project' ||
          entityType === 'task' ||
          entityType === 'note' ||
          entityType === 'epic'
            ? 'proj-acme-solar'
            : null,
        summary: `${entityType}/${action}`,
        createdAt: iso(index % 60),
      });
    });
    insertActivity(raw, {
      id: 'registry-unknown',
      entityType: 'task',
      action: 'internal_secret_action',
    });
    insertActivity(raw, { id: null, entityType: 'task', action: 'created' });
    insertActivity(raw, { id: '', entityType: 'task', action: 'created' });
    insertActivity(raw, {
      id: 'registry-null-time',
      entityType: 'task',
      action: 'created',
      createdAt: null,
    });

    const response = await getEvents(app, 'limit=500');
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const expectedTypes = cases.map(([, , type]) => type).sort();
    expect(body.events.map((event: any) => event.type).sort()).toEqual(
      expectedTypes.concat('task.created').sort()
    );
    expect(body.events.some((event: any) => event.id === 'registry-unknown')).toBe(false);
    expect(body.events.some((event: any) => event.id === null || event.id === '')).toBe(false);
    expect(
      body.events.find((event: any) => event.id === 'registry-null-time')?.occurredAt
    ).toBeNull();
    expect(body.events.map((event: any) => event.seq)).toEqual(body.events.map(() => undefined));
  });

  it('keeps token summaries static and never falls back to a human email for a name', async () => {
    raw.prepare('UPDATE Users SET name = NULL WHERE id = ?').run(TIM);
    insertActivity(raw, {
      id: 'event-token-label',
      entityType: 'member',
      entityId: 'bot-id',
      taskId: null,
      projectId: null,
      action: 'bot_token_created',
      summary: 'Created token "Very Secret Bot Token" with id token-secret-id',
    });
    insertActivity(raw, {
      id: 'event-token-revoked-label',
      entityType: 'member',
      entityId: 'bot-id',
      taskId: null,
      projectId: null,
      action: 'bot_token_revoked',
      summary: 'Revoked token "Another Secret Bot Token" with id another-token-secret-id',
    });
    const response = await getEvents(app, 'include=text');
    expect(response.status).toBe(200);
    const events = (await response.json<any>()).events;
    expect(events).toHaveLength(2);
    const event = events[0];
    const revoked = events[1];
    expect(event.type).toBe('bot.token_created');
    expect(event.summary).toBe('A bot token was created');
    expect(revoked.type).toBe('bot.token_revoked');
    expect(revoked.summary).toBe('A bot token was revoked');
    expect(event.summary).not.toContain('Very Secret');
    expect(event.summary).not.toContain('token-secret-id');
    expect(event.actor).not.toHaveProperty('name');
    expect(JSON.stringify(events)).not.toContain('Another Secret');
    expect(JSON.stringify(events)).not.toContain('another-token-secret-id');
    expect(JSON.stringify(events)).not.toContain('casey@example.test');
    expect(JSON.stringify(events)).not.toContain('viaDetail');
  });

  it('only copies validated status transitions and labels system actors from provenance', async () => {
    insertActivity(raw, {
      id: 'invalid-status-transition',
      actorId: null,
      action: 'status_changed',
      via: 'web',
      changes: JSON.stringify({
        status: { from: 'do', to: 'untrusted-status' },
        reason: { from: 'x', to: 'secret' },
      }),
    });
    insertActivity(raw, {
      id: 'misclassified-completion',
      action: 'status_changed',
      changes: JSON.stringify({ status: { from: 'do', to: 'done' } }),
    });
    insertActivity(raw, {
      id: 'system-status-transition',
      actorId: null,
      action: 'status_changed',
      via: 'system',
      changes: JSON.stringify({
        status: { from: 'awaiting', to: 'do' },
        goalId: { from: null, to: 'private-goal' },
      }),
    });
    const response = await getEvents(app, 'include=text');
    const events = (await response.json<any>()).events;
    const invalid = events.find((event: any) => event.id === 'invalid-status-transition');
    const misclassified = events.find((event: any) => event.id === 'misclassified-completion');
    const system = events.find((event: any) => event.id === 'system-status-transition');
    expect(invalid).not.toHaveProperty('changes');
    expect(misclassified).not.toHaveProperty('changes');
    expect(invalid.actor.kind).toBeNull();
    expect(system).toMatchObject({
      actor: { id: null, kind: 'system' },
      changes: { status: { from: 'awaiting', to: 'do' } },
    });
    expect(JSON.stringify(events)).not.toContain('private-goal');
    expect(JSON.stringify(events)).not.toContain('untrusted-status');
  });

  it('returns only redacted tombstones for deleted, merged and missing tasks', async () => {
    raw
      .prepare(
        "UPDATE Tasks SET is_deleted = 1, status = 'done', title = 'Deleted secret title' WHERE id = ?"
      )
      .run(TASK);
    raw
      .prepare(
        `
      INSERT INTO TaskRefs (id, task_id, org_id, role, kind, ref, url, label, created_by)
      VALUES ('deleted-ref', ?, 'org-md', 'link', 'url', 'https://private.example.test/deleted', 'https://private.example.test/deleted', 'Deleted ref label', ?)
    `
      )
      .run(TASK, TIM);
    insertActivity(raw, {
      id: 'deleted-completed-event',
      action: 'completed',
      summary: 'Deleted task summary secret',
      changes: JSON.stringify({
        status: { from: 'do', to: 'done' },
        goalId: { from: null, to: 'goal-secret' },
      }),
    });
    insertActivity(raw, {
      id: 'merged-task-event',
      action: 'merged',
      summary: 'Merged source task summary secret',
    });
    insertActivity(raw, {
      id: 'missing-task-event',
      entityId: 'missing-task',
      taskId: 'missing-task',
      action: 'updated',
      summary: 'Missing task summary secret',
    });

    const response = await getEvents(app, 'include=text,refs');
    expect(response.status).toBe(200);
    const events = (await response.json<any>()).events;
    for (const event of events) {
      expect(event.task).toEqual({ id: event.taskId, deleted: true });
      expect(event).not.toHaveProperty('summary');
      expect(event).not.toHaveProperty('changes');
      expect(event.actor).not.toHaveProperty('name');
      expect(event.task).not.toHaveProperty('refs');
      expect(event.task).not.toHaveProperty('status');
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('Deleted secret');
    expect(serialized).not.toContain('Merged source task');
    expect(serialized).not.toContain('Missing task summary');
    expect(serialized).not.toContain('goal-secret');
    expect(serialized).not.toContain('Deleted ref label');
    expect(serialized).not.toContain('private.example.test');
  });

  it('redacts task and project move-out markers even when the caller belongs to both workspaces', async () => {
    raw
      .prepare(
        "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('member-tim-destination', 'org-stranger', ?, 'member')"
      )
      .run(TIM);
    raw
      .prepare('UPDATE Tasks SET project_id = ?, title = ?, status = ? WHERE id = ?')
      .run('proj-stranger', 'Destination-only title', 'done', TASK);
    insertActivity(raw, {
      id: 'task-old-source-history',
      action: 'updated',
      summary: 'Old source task text',
      createdAt: iso(1),
    });
    insertActivity(raw, {
      id: 'task-source-moved-out',
      projectId: null,
      epicId: null,
      action: 'moved_out',
      summary: 'Generic source marker',
      createdAt: iso(2),
    });
    insertActivity(raw, {
      id: 'task-destination-moved',
      orgId: 'org-stranger',
      projectId: 'proj-stranger',
      action: 'moved',
      summary: 'Moved task into private destination',
      createdAt: iso(3),
    });

    const source = await getEvents(app, 'workspace=org-md&include=refs,text');
    expect(source.status).toBe(200);
    const sourceBody = await source.json<any>();
    expect(sourceBody.events).toEqual([
      expect.objectContaining({
        id: 'task-source-moved-out',
        type: 'task.moved_out',
        workspaceId: 'org-md',
        projectId: null,
        taskId: TASK,
        epicId: null,
        task: null,
      }),
    ]);
    expect(JSON.stringify(sourceBody)).not.toContain('Destination-only');
    expect(JSON.stringify(sourceBody)).not.toContain('private destination');
    expect(JSON.stringify(sourceBody)).not.toContain('Old source task text');

    const destination = await getEvents(app, 'workspace=org-stranger&include=text');
    expect(destination.status).toBe(200);
    const destinationEvent = (await destination.json<any>()).events.find(
      (event: any) => event.id === 'task-destination-moved'
    );
    expect(destinationEvent).toMatchObject({
      type: 'task.moved',
      workspaceId: 'org-stranger',
      task: { id: TASK, title: 'Destination-only title', status: 'done', deleted: false },
    });
  });

  it('suppresses data when an entity moves between candidate selection and hydration', async () => {
    insertActivity(raw, {
      id: 'stale-hydration-event',
      action: 'updated',
      summary: 'Must not hydrate after moving',
    });
    const originalSelect = db.select.bind(db);
    let moved = false;
    const wrap = (builder: any): any =>
      new Proxy(builder, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'then' && typeof value === 'function') {
            const statement = typeof target.toSQL === 'function' ? target.toSQL().sql : '';
            const then = value.bind(target);
            return (fulfilled: (result: any) => unknown, rejected?: (error: unknown) => unknown) =>
              then((result: any) => {
                if (!moved && statement.includes('ActivityLog')) {
                  moved = true;
                  raw
                    .prepare('UPDATE Tasks SET project_id = ?, title = ? WHERE id = ?')
                    .run('proj-stranger', 'Race-only destination title', TASK);
                }
                return fulfilled(result);
              }, rejected);
          }
          if (typeof value === 'function') {
            return (...args: any[]) => {
              const result = value.apply(target, args);
              return result && typeof result === 'object' && typeof result.then === 'function'
                ? wrap(result)
                : result;
            };
          }
          return value;
        },
      });
    db.select = (...args: any[]) => wrap(originalSelect(...args));

    const response = await getEvents(app, 'include=text');
    db.select = originalSelect;
    expect(moved).toBe(true);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.events).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Race-only destination title');
    expect(JSON.stringify(body)).not.toContain('Must not hydrate after moving');
  });

  it('maps a real project source move to a redacted marker and retains the destination event', async () => {
    raw
      .prepare(
        "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('member-project-dest', 'org-stranger', ?, 'member')"
      )
      .run(TIM);
    await organisationService.updateProjectContainer(db, TIM, 'org-md', 'proj-acme-solar', {
      orgId: 'org-stranger',
    });

    const source = await getEvents(app, 'workspace=org-md&include=text,refs');
    expect(source.status).toBe(200);
    const sourceEvent = (await source.json<any>()).events[0];
    expect(sourceEvent).toMatchObject({
      type: 'project.moved_out',
      workspaceId: 'org-md',
      projectId: 'proj-acme-solar',
      taskId: null,
      epicId: null,
    });
    expect(sourceEvent).not.toHaveProperty('summary');
    expect(JSON.stringify(sourceEvent)).not.toContain('Stranger');

    const destination = await getEvents(app, 'workspace=org-stranger&types=project.moved');
    expect(destination.status).toBe(200);
    expect((await destination.json<any>()).events.map((event: any) => event.type)).toEqual([
      'project.moved',
    ]);
  });

  it('uses fixed high-water pages, advances empty filtered pages, and opens a fresh drained walk', async () => {
    insertActivity(raw, { id: 'catchup-1', action: 'created', createdAt: iso(1) });
    insertActivity(raw, { id: 'catchup-2', action: 'updated', createdAt: iso(2) });

    const first = await getEvents(app, 'after=0&limit=1');
    expect(first.status).toBe(200);
    const firstBody = await first.json<any>();
    expect(firstBody.events.map((event: any) => event.id)).toEqual(['catchup-1']);
    expect(firstBody.hasMore).toBe(true);
    const oldCursor = firstBody.next as string;
    insertActivity(raw, { id: 'catchup-new', action: 'created', createdAt: iso(3) });

    const second = await getEvents(app, `after=${encodeURIComponent(oldCursor)}&limit=500`);
    const secondBody = await second.json<any>();
    expect(secondBody.events.map((event: any) => event.id)).toEqual(['catchup-2']);
    expect(secondBody.hasMore).toBe(false);
    const drainedCursor = secondBody.next as string;

    const third = await getEvents(app, `after=${encodeURIComponent(drainedCursor)}&limit=1`);
    expect((await third.json<any>()).events.map((event: any) => event.id)).toEqual(['catchup-new']);

    insertActivity(raw, {
      id: 'filtered-unknown',
      action: 'private_future_action',
      createdAt: iso(4),
    });
    const empty = await getEvents(app, 'after=0&types=project.created');
    const emptyBody = await empty.json<any>();
    expect(emptyBody.events).toEqual([]);
    expect(emptyBody.hasMore).toBe(false);
    insertActivity(raw, {
      id: 'filtered-next',
      entityType: 'project',
      entityId: 'proj-acme-solar',
      taskId: null,
      action: 'created',
      createdAt: iso(5),
    });
    const nextCycle = await getEvents(
      app,
      `after=${encodeURIComponent(emptyBody.next)}&types=project.created`
    );
    expect((await nextCycle.json<any>()).events.map((event: any) => event.id)).toEqual([
      'filtered-next',
    ]);
  });

  it('starts latest at the captured high-water and emits a fixed-width opaque counter', async () => {
    insertActivity(raw, { id: 'already-recorded', action: 'created' });
    const latest = await getEvents(app, 'after=latest');
    const latestBody = await latest.json<any>();
    expect(latestBody.events).toEqual([]);
    expect(latestBody.hasMore).toBe(false);
    expect(latestBody.next).toMatch(/^c1\./);

    insertActivity(raw, { id: 'recorded-after-latest', action: 'updated' });
    const resumed = await getEvents(app, `after=${encodeURIComponent(latestBody.next)}`);
    const resumedBody = await resumed.json<any>();
    expect(resumedBody.events.map((event: any) => event.id)).toEqual(['recorded-after-latest']);
    expect(resumedBody.next.length).toBe(latestBody.next.length);
  });

  it('binds cursors to principal, filter, workspace membership and the current counter', async () => {
    insertActivity(raw, { id: 'scope-1', action: 'created' });
    insertActivity(raw, { id: 'scope-2', action: 'updated' });
    const firstBody = await (await getEvents(app, 'limit=1')).json<any>();
    const cursor = firstBody.next as string;
    expect(
      (await getEvents(app, `after=${encodeURIComponent(cursor)}&types=task.updated`)).status
    ).toBe(409);
    const robinApp = createApi(db, ROBIN);
    expect((await getEvents(robinApp, `after=${encodeURIComponent(cursor)}`)).status).toBe(409);

    addWorkspace(raw, 'org-new-member', 'new-member', 'member-new-1');
    expect((await getEvents(app, `after=${encodeURIComponent(cursor)}`)).status).toBe(409);
    expect((await getEvents(app, 'workspace=does-not-exist')).status).toBe(404);
    expect((await getEvents(app, 'workspace=org-stranger')).status).toBe(404);

    const allScopeCursor = (await (await getEvents(app, 'limit=1')).json<any>()).next as string;
    const unrelatedMembershipCursor = (
      await (await getEvents(app, 'workspace=org-md&limit=1')).json<any>()
    ).next as string;
    raw.prepare('DELETE FROM OrganisationMembers WHERE id = ?').run('member-new-1');
    expect((await getEvents(app, `after=${encodeURIComponent(allScopeCursor)}`)).status).toBe(409);
    expect(
      (
        await getEvents(
          app,
          `workspace=org-md&after=${encodeURIComponent(unrelatedMembershipCursor)}`
        )
      ).status
    ).toBe(200);
    raw
      .prepare(
        "INSERT INTO OrganisationMembers (id, org_id, user_id, role) VALUES ('member-new-2', 'org-new-member', ?, 'member')"
      )
      .run(TIM);
    expect((await getEvents(app, `after=${encodeURIComponent(allScopeCursor)}`)).status).toBe(409);
    const roleCursor = (await (await getEvents(app, 'workspace=org-new-member')).json<any>())
      .next as string;
    raw.prepare("UPDATE OrganisationMembers SET role = 'viewer' WHERE id = 'member-new-2'").run();
    expect(
      (await getEvents(app, `workspace=org-new-member&after=${encodeURIComponent(roleCursor)}`))
        .status
    ).toBe(409);

    const fresh = await getEvents(app, 'workspace=org-md&limit=1');
    const freshCursor = (await fresh.json<any>()).next as string;
    const wrongWorkspace = await getEvents(
      app,
      `workspace=org-new-member&after=${encodeURIComponent(freshCursor)}`
    );
    expect(wrongWorkspace.status).toBe(409);

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    expect((await getEvents(app, `after=${encodeURIComponent(tampered)}`)).status).toBe(400);
    expect(
      (
        await getEvents(
          app,
          `after=${encodeURIComponent(cursor)}`,
          'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'
        )
      ).status
    ).toBe(400);
    expect((await getEvents(app, 'after=0', '')).status).toBe(503);
    expect((await getEvents(app, 'after=0', 'invalid-key')).status).toBe(503);

    raw.prepare('UPDATE ActivitySequence SET last_seq = 0 WHERE id = 1').run();
    const restored = await getEvents(app, `after=${encodeURIComponent(freshCursor)}`);
    expect(restored.status).toBe(409);
  });

  it('returns 404 for inaccessible workspaces and validates request filters strictly', async () => {
    const unknown = await getEvents(app, 'workspace=not-a-workspace');
    const inaccessible = await getEvents(app, 'workspace=org-stranger');
    expect(unknown.status).toBe(404);
    expect(inaccessible.status).toBe(404);
    expect(await unknown.json()).toEqual(await inaccessible.json());
    for (const query of [
      'types=unknown.type',
      'types=',
      'include=viaDetail',
      'include=',
      'limit=0',
      'limit=501',
      'limit=1.5',
      'after=not-a-cursor',
    ]) {
      const response = await getEvents(app, query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await getEvents(app, '', '')).headers.get('Cache-Control')).toBe('no-store');
  });

  it('pins bot event reads to botOrgId and excludes null-workspace personal activity', async () => {
    raw
      .prepare(
        `
      INSERT INTO Users (id, email, name, kind, bot_org_id, created_by)
      VALUES ('bot|feed-001', 'bot+feed-001@bots.timdo.invalid', 'Fixture Bot', 'bot', 'org-md', ?)
    `
      )
      .run(TIM);
    raw.exec('DROP TRIGGER trg_bot_membership_insert');
    raw
      .prepare(
        `
      INSERT INTO OrganisationMembers (id, org_id, user_id, role)
      VALUES ('bot-feed-membership', 'org-stranger', 'bot|feed-001', 'member')
    `
      )
      .run();
    insertActivity(raw, {
      id: 'personal-null-org',
      orgId: null,
      projectId: null,
      taskId: null,
      entityType: 'organisation',
      entityId: 'personal',
      action: 'created',
    });
    insertActivity(raw, {
      id: 'bot-home-event',
      orgId: 'org-md',
      projectId: null,
      taskId: null,
      entityType: 'organisation',
      entityId: 'org-md',
      action: 'created',
    });
    insertActivity(raw, {
      id: 'bot-other-event',
      orgId: 'org-stranger',
      projectId: null,
      taskId: null,
      entityType: 'organisation',
      entityId: 'org-stranger',
      action: 'created',
    });

    const botApp = createApi(db, 'bot|feed-001', 'bot');
    const all = await getEvents(botApp, '');
    expect((await all.json<any>()).events.map((event: any) => event.id)).toEqual([
      'bot-home-event',
    ]);
    expect((await getEvents(botApp, 'workspace=org-stranger')).status).toBe(404);
  });

  it('keeps membership and task hydration queries below 100 bindings for 500 events', async () => {
    for (let index = 0; index < 105; index++) {
      addWorkspace(raw, `org-scale-${index}`, `scale-${index}`, `member-scale-${index}`);
    }
    const insert = raw.prepare(`
      INSERT INTO Tasks (id, project_id, reporter_id, title, status, priority, size, is_deleted)
      VALUES (?, 'proj-acme-solar', ?, ?, 'do', 5, '***', 0)
    `);
    for (let index = 0; index < 500; index++) {
      const id = `scale-task-${index}`;
      insert.run(id, TIM, `Scale task ${index}`);
      insertActivity(raw, {
        id: `scale-event-${index}`,
        entityId: id,
        taskId: id,
        action: 'created',
        createdAt: iso(index % 60),
      });
    }
    stats.reset();
    const response = await getEvents(app, 'limit=500');
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.events).toHaveLength(500);
    expect(body.events.some((event: any) => Object.hasOwn(event, 'seq'))).toBe(false);
    expect(stats.maxBindings).toBeLessThanOrEqual(100);
  });

  it('exports a bounded safe recent summary without a cursor key', async () => {
    for (let index = 0; index < 31; index++) {
      insertActivity(raw, {
        id: `recent-${index}`,
        action: index === 30 ? 'bot_token_created' : 'created',
        entityType: index === 30 ? 'member' : 'task',
        entityId: index === 30 ? 'bot-feed' : TASK,
        taskId: index === 30 ? null : TASK,
        projectId: index === 30 ? null : 'proj-acme-solar',
        summary: index === 30 ? 'Created token "Private label" token-id-secret' : 'x'.repeat(450),
        createdAt: `2026-10-11T${String(12 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
      });
    }
    const result = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      {
        from: '2026-10-11T12:00:00.000Z',
        to: '2026-10-12T12:00:00.000Z',
      }
    );
    expect(result).toMatchObject({
      from: '2026-10-11T12:00:00.000Z',
      to: '2026-10-12T12:00:00.000Z',
      timezone: 'UTC',
      truncated: true,
      unavailable: false,
    });
    expect(result.events).toHaveLength(30);
    expect(result.events[0].summary).toBe('A bot token was created');
    expect(result.events[0].summaryTruncated).toBe(false);
    expect(result.events.some((event) => event.summaryTruncated)).toBe(true);
    expect(result.events.some((event) => event.actor && Object.hasOwn(event.actor, 'name'))).toBe(
      false
    );
    expect(result.events[0].summary?.length).toBeLessThanOrEqual(400);
    expect(result.events.some((event) => event.summary?.includes('Private label'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('token-id-secret');
  });

  it('redacts recent summaries for deleted and missing linked tasks', async () => {
    raw
      .prepare("UPDATE Tasks SET is_deleted = 1, title = 'Deleted task title secret' WHERE id = ?")
      .run(TASK);
    insertActivity(raw, {
      id: 'recent-deleted-task',
      action: 'deleted',
      summary: 'Deleted task title secret',
      createdAt: iso(1),
    });
    insertActivity(raw, {
      id: 'recent-missing-task',
      entityId: 'missing-recent-task',
      taskId: 'missing-recent-task',
      action: 'updated',
      summary: 'Missing task title secret',
      createdAt: iso(2),
    });

    const result = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      { from: '2026-10-11T12:00:00.000Z', to: '2026-10-12T12:00:00.000Z' }
    );
    expect(result.events.map((event) => event.id)).toEqual([
      'recent-missing-task',
      'recent-deleted-task',
    ]);
    expect(result.events.map((event) => event.summary)).toEqual([null, null]);
    expect(JSON.stringify(result)).not.toContain('task title secret');
  });

  it('uses a half-open exact UTC window and reports unavailable data without a cursor key', async () => {
    const from = '2026-10-11T12:00:00.000Z';
    const to = '2026-10-12T12:00:00.000Z';
    insertActivity(raw, { id: 'recent-at-start', createdAt: from });
    insertActivity(raw, { id: 'recent-at-end', createdAt: to });
    const result = await eventService.getRecentRecordedActivity(
      db,
      { userId: TIM, userKind: 'human' },
      { from, to }
    );
    expect(result.events.map((event) => event.id)).toEqual(['recent-at-start']);
    expect(result.events[0].occurredAt).toBe(from);

    const unavailable = await eventService.getRecentRecordedActivity(
      {
        select: () => {
          throw new Error('fixture database unavailable');
        },
      } as any,
      { userId: TIM, userKind: 'human' },
      { from, to }
    );
    expect(unavailable).toMatchObject({
      unavailable: true,
      truncated: false,
      events: [],
      from,
      to,
    });
  });
});
