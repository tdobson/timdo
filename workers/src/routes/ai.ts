import { Hono } from 'hono';
import type { Env } from '../index';
import { parseOnboardingProjects, processVoiceCommand } from '../services/aiService';
import { loadVoiceContext } from '../services/voiceContextService';

const aiApp = new Hono<{ Bindings: Env }>();

// The auth middleware is now applied in src/index.ts, so we remove it from here.

aiApp.post('/voice-command', async (c) => {
  if (c.get('userKind') === 'bot') {
    return c.json({ error: 'Bots cannot access AI endpoints' }, 403);
  }
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');
    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'Audio file is required' }, 400);
    }

    // Older clients may still send `projects`; it is ignored as task authority.
    const groqApiKey = c.env.GROQ_API_KEY;

    if (!groqApiKey) {
      return c.json({ error: 'Server configuration error: Missing Groq API key' }, 500);
    }

    const result = await processVoiceCommand({
      audioFile,
      groqApiKey,
      loadContext: (transcript) => loadVoiceContext(c.get('db'), c.get('userId'), transcript),
    });

    return c.json(result);
  } catch (error) {
    console.error('Error processing voice command:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to process voice command', details: message }, 500);
  }
});

aiApp.post('/parse-onboarding', async (c) => {
  if (c.get('userKind') === 'bot') {
    return c.json({ error: 'Bots cannot access AI endpoints' }, 403);
  }
  try {
    const formData = await c.req.formData();
    const audioFile = formData.get('audio');

    if (!audioFile || typeof audioFile === 'string') {
      return c.json({ error: 'Audio file is required' }, 400);
    }

    const groqApiKey = c.env.GROQ_API_KEY;

    if (!groqApiKey) {
      return c.json({ error: 'Server configuration error: Missing Groq API key' }, 500);
    }

    const result = await parseOnboardingProjects({
      audioFile,
      groqApiKey,
    });

    return c.json(result);
  } catch (error) {
    console.error('Error parsing onboarding projects:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: 'Failed to parse onboarding projects', details: message }, 500);
  }
});

export default aiApp;
