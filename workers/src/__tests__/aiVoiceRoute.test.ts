import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import aiApp from '../routes/ai';
import { createTestDb } from './helpers/testDb';

const voiceState = vi.hoisted(() => ({
  transcript: 'Scale',
  events: [] as string[],
  invokeResult: { summary: 'Nothing', changes: [] as unknown[] },
}));

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => {
          voiceState.events.push('transcription');
          return { text: voiceState.transcript };
        }),
      },
    },
  })),
}));

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async () => voiceState.invokeResult),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

const audio = () => new File(['fictional audio'], 'voice.webm', { type: 'audio/webm' });

describe('voice command route', () => {
  let db: any;
  let stats: ReturnType<typeof createTestDb>['stats'];
  let app: Hono<any>;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    stats = testDb.stats;
    voiceState.transcript = 'Scale';
    voiceState.events.length = 0;
    voiceState.invokeResult = { summary: 'Nothing', changes: [] };

    app = new Hono<any>();
    app.use('*', async (c: any, next: () => Promise<void>) => {
      c.set('db', db);
      c.set('userId', 'fictional-speaker');
      await next();
    });
    app.route('/', aiApp);
  });

  it('ignores the legacy projects field even when it is not valid JSON', async () => {
    const form = new FormData();
    form.append('audio', audio());
    form.append('projects', 'not JSON and not task authority');

    const response = await app.request('/voice-command', { method: 'POST', body: form }, {
      GROQ_API_KEY: 'test-key',
    } as any);

    expect(response.status).toBe(200);
    expect(voiceState.events).toEqual(['transcription']);
    expect(stats.statements.some((statement) => statement.sql.includes('Tasks_FTS'))).toBe(true);
  });

  it('does not query task context when transcription is silent', async () => {
    voiceState.transcript = '   ';
    const form = new FormData();
    form.append('audio', audio());

    const response = await app.request('/voice-command', { method: 'POST', body: form }, {
      GROQ_API_KEY: 'test-key',
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      summary: 'No speech detected.',
      proposedChanges: [],
    });
    expect(voiceState.events).toEqual(['transcription']);
    expect(stats.queries).toBe(0);
  });
});
