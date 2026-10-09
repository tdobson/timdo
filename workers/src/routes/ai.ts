import { Hono, type Context } from 'hono';
import type { Env } from '../index';
import {
  AiNotConfiguredError,
  describeMissing,
  providersFromEnv,
  resolveAiConfig,
  type AiProviders,
} from '../services/ai';
import { parseOnboardingProjects, processVoiceCommand } from '../services/aiService';
import { loadVoiceContext } from '../services/voiceContextService';

const aiApp = new Hono<{ Bindings: Env }>();

// The auth middleware is applied in src/index.ts.

/** Which AI services this instance uses, and whether they are ready. Names only, never keys. */
aiApp.get('/status', (c) => {
  try {
    const config = resolveAiConfig(c.env);
    return c.json({
      configured: config.configured,
      transcription: {
        provider: config.transcription.provider,
        model: config.transcription.model,
        ready: !config.transcription.missing,
      },
      llm: {
        provider: config.llm.provider,
        model: config.llm.model,
        ready: !config.llm.missing,
      },
      missing: config.configured ? null : describeMissing(config),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ configured: false, transcription: null, llm: null, missing: message });
  }
});

type ProviderResult = { ok: true; ai: AiProviders } | { ok: false; response: Response };

function providersOrError(c: Context<{ Bindings: Env }>): ProviderResult {
  try {
    return { ok: true, ai: providersFromEnv(c.env) };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return {
        ok: false,
        response: c.json(
          { error: 'Voice features are not configured on this instance', details: error.message },
          500
        ),
      };
    }
    throw error;
  }
}

aiApp.post('/voice-command', async (c) => {
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');
    const projectsJson = formData.get('projects');

    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'Audio file is required' }, 400);
    }

    // The client's cached task list is optional now: it saves a database read when it is
    // current, but permissions, workspaces and people always come from the database.
    let clientTasks: unknown;
    if (typeof projectsJson === 'string' && projectsJson.trim()) {
      try {
        clientTasks = JSON.parse(projectsJson);
      } catch {
        return c.json({ error: 'Projects JSON is not valid' }, 400);
      }
    }

    const providers = providersOrError(c);
    if (!providers.ok) {
      return providers.response;
    }

    const context = await loadVoiceContext(c.get('db'), c.get('userId'), clientTasks);

    const result = await processVoiceCommand({
      audioFile,
      ai: providers.ai,
      context,
    });

    return c.json(result);
  } catch (error) {
    console.error('Error processing voice command:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to process voice command', details: message }, 500);
  }
});

aiApp.post('/parse-onboarding', async (c) => {
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');

    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'Audio file is required' }, 400);
    }

    const providers = providersOrError(c);
    if (!providers.ok) {
      return providers.response;
    }

    const result = await parseOnboardingProjects({
      audioFile,
      ai: providers.ai,
    });

    return c.json(result);
  } catch (error) {
    console.error('Error parsing onboarding projects:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to parse onboarding projects', details: message }, 500);
  }
});

export default aiApp;
