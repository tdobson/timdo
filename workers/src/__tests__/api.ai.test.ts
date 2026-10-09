/**
 * POST /api/v2/ai/voice-command: the route loads the signed-in user's context from the
 * database (not just the client's list) and returns resolved proposals and warnings.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import aiApp from '../routes/ai';
import * as projectService from '../services/projectService';
import { createTestDb, ROBIN, seedCollaboration, TIM } from './helpers/testDb';

let mockInvokeResult: any = { summary: 'Nothing', changes: [] };
let lastPrompt = '';

vi.mock('../services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai')>();
  const fake = () => ({
    transcriber: { transcribe: vi.fn(async () => 'add a task') },
    llm: {
      complete: vi.fn(async ({ prompt }: { prompt: string }) => {
        lastPrompt = prompt;
        return mockInvokeResult;
      }),
    },
  });
  return {
    ...actual,
    providersForGroqKey: vi.fn(() => fake()),
    providersFromEnv: vi.fn((env: { GROQ_API_KEY?: string }) => {
      if (!env.GROQ_API_KEY) {
        throw new actual.AiNotConfiguredError(
          'Voice features are not configured: GROQ_API_KEY is not set'
        );
      }
      return fake();
    }),
  };
});

/** The task list the model was shown, parsed back out of the rendered prompt. */
function tasksInPrompt(prompt: string): any[] {
  const marker = 'Current Tasks JSON:';
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim());
}

const env = { GROQ_API_KEY: 'test-key' };

function form(projects?: unknown) {
  const fd = new FormData();
  fd.append('audio', new File(['x'], 'recording.webm', { type: 'audio/webm' }));
  if (projects !== undefined) {
    fd.append('projects', JSON.stringify(projects));
  }
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
    lastPrompt = '';
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
      projectId: 'proj-solfit',
    });
  });

  it('works without a client task list and loads tasks and people from the database', async () => {
    mockInvokeResult = {
      summary: 'Added a task for Robin',
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
            category: 'Solfit',
            assignee: 'Robin',
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
      projectId: 'proj-solfit',
      orgName: 'Migrating Dragons',
      assigneeId: ROBIN,
      assigneeName: 'Robin Fairweather',
    });
    expect(tasksInPrompt(lastPrompt).map((t: any) => t.project)).toEqual([
      'Check inverter datasheet',
    ]);
    expect(lastPrompt).toContain('Robin Fairweather');
  });

  it('scopes the context to the signed-in user', async () => {
    userId = ROBIN;
    const res = await app.request(
      '/api/v2/ai/voice-command',
      { method: 'POST', body: form() },
      env
    );
    expect(res.status).toBe(200);
    expect(lastPrompt).toContain('\nRobin Fairweather <robin@example.com>\n');
    expect(lastPrompt).not.toContain('Tim Dobson" (personal');
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
    expect(tasksInPrompt(lastPrompt).map((t: any) => t.project)).toEqual([
      'Check inverter datasheet',
    ]);
  });

  it('rejects missing audio and invalid JSON', async () => {
    const noAudio = new FormData();
    noAudio.append('projects', '[]');
    expect(
      (await app.request('/api/v2/ai/voice-command', { method: 'POST', body: noAudio }, env)).status
    ).toBe(400);
    const bad = new FormData();
    bad.append('audio', new File(['x'], 'r.webm'));
    bad.append('projects', '{not json');
    const res = await app.request('/api/v2/ai/voice-command', { method: 'POST', body: bad }, env);
    expect(res.status).toBe(400);
  });

  it('reports an unconfigured instance', async () => {
    const res = await app.request('/api/v2/ai/voice-command', { method: 'POST', body: form() }, {});
    expect(res.status).toBe(500);
  });
});
