import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onApiError } from '../middleware/apiErrors';
import { combinedAuthMiddleware } from '../middleware/auth';
import aiApp from '../routes/ai';
import * as aiService from '../services/aiService';
import * as botService from '../services/botService';
import { withActorContext } from '../services/requestActorContext';
import * as voiceContextService from '../services/voiceContextService';
import { createTestDb, seedCollaboration, TIM } from './helpers/testDb';

const providerCalls = vi.hoisted(() => [] as string[]);

vi.mock('groq-sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockImplementation(async () => {
          providerCalls.push('transcription');
          return { text: 'fixture voice request' };
        }),
      },
    },
  })),
}));

vi.mock('@langchain/core/prompts', () => ({
  PromptTemplate: {
    fromTemplate: vi.fn().mockReturnValue({
      pipe: vi.fn().mockReturnValue({
        invoke: vi.fn().mockImplementation(async () => {
          providerCalls.push('model');
          return { summary: 'No change', changes: [] };
        }),
      }),
    }),
  },
}));

vi.mock('@langchain/groq', () => ({
  ChatGroq: vi.fn().mockImplementation(() => ({ withStructuredOutput: vi.fn() })),
}));

const env = {
  INTERNAL_API_SECRET: 'fixture-owner-secret',
  AUTH0_DOMAIN: 'fixture.invalid',
  AUTH0_AUDIENCE: 'fixture-api',
};

describe('bot AI endpoint denial', () => {
  let db: any;
  let stats: ReturnType<typeof createTestDb>['stats'];
  let app: Hono<any>;
  let botToken: string;

  beforeEach(async () => {
    const fixture = createTestDb();
    db = fixture.db;
    stats = fixture.stats;
    providerCalls.length = 0;
    seedCollaboration(fixture.raw);
    const created = await withActorContext(db, { via: 'owner_secret' }, () =>
      botService.createBot(db, TIM, 'org-md', {
        name: 'Fixture Voice Bot',
        role: 'member',
        tokenName: 'initial',
      })
    );
    botToken = created.token;
    app = new Hono();
    app.onError(onApiError);
    app.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    app.use('/ai/*', combinedAuthMiddleware);
    app.route('/ai', aiApp);
  });

  it('denies bots before parsing or transcribing either audio endpoint', async () => {
    const headers = { Authorization: `Bearer ${botToken}`, 'Content-Type': 'text/plain' };
    for (const path of ['/ai/voice-command', '/ai/parse-onboarding']) {
      const response = await app.request(
        path,
        { method: 'POST', headers, body: 'not multipart data' },
        env
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Bots cannot access AI endpoints' });
    }
  });

  it('denies both endpoints before transcription, model or task-context work', async () => {
    const processVoice = vi.spyOn(aiService, 'processVoiceCommand');
    const parseOnboarding = vi.spyOn(aiService, 'parseOnboardingProjects');
    const loadContext = vi.spyOn(voiceContextService, 'loadVoiceContext');

    for (const path of ['/ai/voice-command', '/ai/parse-onboarding']) {
      const form = new FormData();
      form.append('audio', new File(['fictional audio'], 'fixture.webm', { type: 'audio/webm' }));
      const response = await app.request(
        path,
        { method: 'POST', headers: { Authorization: `Bearer ${botToken}` }, body: form },
        { ...env, GROQ_API_KEY: 'fictional-test-key' }
      );
      expect(response.status).toBe(403);
    }

    expect(providerCalls).toEqual([]);
    expect(processVoice).not.toHaveBeenCalled();
    expect(parseOnboarding).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
    expect(stats.statements.some((statement) => statement.sql.includes('Tasks_FTS'))).toBe(false);
    vi.restoreAllMocks();
  });
});
