/**
 * POST /api/v2/ai/voice-command: the route loads the signed-in user's context from the
 * database (not just the client's list) and returns resolved proposals and warnings.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import aiApp from '../routes/ai';
import * as projectService from '../services/projectService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: vi.fn().mockResolvedValue({ text: 'add a task' }) } },
  })),
}));

let mockInvokeResult: any = { summary: 'Nothing', changes: [] };
let lastInvokeArgs: any = null;

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async (args: any) => {
          lastInvokeArgs = args;
          return mockInvokeResult;
        }),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

const env = { GROQ_API_KEY: 'test-key' };

function form(projects?: unknown) {
  const fd = new FormData();
  fd.append('audio', new File(['x'], 'recording.webm', { type: 'audio/webm' }));
  if (projects !== undefined) {fd.append('projects', JSON.stringify(projects));}
  return fd;
}

describe('AI routes', () => {
  let app: Hono<any>;
  let db: any;
  let userId: string;

  beforeEach(async () => {
    const t = createTestDb();
    db = t.db;
    seedCollaboration(t.raw);
    userId = TIM;
    mockInvokeResult = { summary: 'Nothing', changes: [] };
    lastInvokeArgs = null;
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId', userId);
      c.set('db', db);
      await next();
    });
    app.route('/api/v2/ai', aiApp);
    await projectService.createProject(db, ROBIN, {
      id: '00000000-0000-4000-8000-000000000001',
      project: 'Check inverter datasheet',
      status: 'do',
      priority: 6,
      size: '*',
      projectId: 'proj-acme-solar',
    });
  });

  it('works without a client task list and loads tasks and people from the database', async () => {
    mockInvokeResult = {
      summary: 'Added a task for Jordan',
      changes: [
        {
          type: 'create',
          projectId: 'new-project-placeholder-1',
          after: {
            id: 'new-project-placeholder-1',
            project: 'Order panels',
            status: 'do',
            priority: 5,
            size: '***',
            category: 'Acme Solar',
            assignee: 'Jordan',
          },
        },
      ],
    };
    const res = await app.request(
      '/api/v2/ai/voice-command',
      { method: 'POST', body: form() },
      env
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.warnings).toEqual([]);
    expect(body.proposedChanges[0]).toMatchObject({
      projectId: 'proj-acme-solar',
      orgName: 'Northstar Workshop',
      assigneeId: ROBIN,
      assigneeName: 'Jordan Example',
    });
    expect(JSON.parse(lastInvokeArgs.projects).map((t: any) => t.project)).toEqual([
      'Check inverter datasheet',
    ]);
    expect(lastInvokeArgs.workspaces).toContain('Jordan Example');
  });

  it('scopes the context to the signed-in user', async () => {
    userId = ROBIN;
    const res = await app.request(
      '/api/v2/ai/voice-command',
      { method: 'POST', body: form() },
      env
    );
    expect(res.status).toBe(200);
    expect(lastInvokeArgs.me).toBe('Jordan Example <jordan@example.test>');
    expect(lastInvokeArgs.workspaces).not.toContain('Casey Example" (personal');
  });

  it('ignores a client list for projects the user cannot see', async () => {
    const forged = [
      {
        id: 'x',
        project: 'Forged',
        status: 'do',
        priority: 5,
        size: '*',
        projectId: 'proj-stranger',
      },
    ];
    await app.request('/api/v2/ai/voice-command', { method: 'POST', body: form(forged) }, env);
    expect(JSON.parse(lastInvokeArgs.projects).map((t: any) => t.project)).toEqual([
      'Check inverter datasheet',
    ]);
  });

  it('rejects a request with missing audio', async () => {
    const noAudio = new FormData();
    noAudio.append('projects', '[]');
    const res = await app.request(
      '/api/v2/ai/voice-command',
      { method: 'POST', body: noAudio },
      env
    );
    expect(res.status).toBe(400);
  });

  it('ignores malformed legacy projects JSON and uses task context from the database', async () => {
    const bad = new FormData();
    bad.append('audio', new File(['x'], 'r.webm'));
    bad.append('projects', '{not json');
    const res = await app.request('/api/v2/ai/voice-command', { method: 'POST', body: bad }, env);

    expect(res.status).toBe(200);
    expect(JSON.parse(lastInvokeArgs.projects).map((task: any) => task.project)).toEqual([
      'Check inverter datasheet',
    ]);
  });

  it('needs the Groq key', async () => {
    const res = await app.request('/api/v2/ai/voice-command', { method: 'POST', body: form() }, {});
    expect(res.status).toBe(500);
  });
});
