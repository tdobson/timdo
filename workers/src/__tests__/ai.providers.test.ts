/**
 * The per-instance AI provider layer: which services are chosen from the environment, and
 * that each provider speaks its API correctly and validates what comes back.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import aiApp from '../routes/ai';
import { anthropicLlm } from '../services/ai/anthropic';
import { describeMissing, resolveAiConfig } from '../services/ai/config';
import { httpProviders } from '../services/ai/http';
import { openAiCompatibleProviders } from '../services/ai/openaiCompatible';
import { renderPrompt, toJsonSchema } from '../services/ai/schema';
import { workersAiProviders } from '../services/ai/workersAi';

const shape = z.object({ summary: z.string(), count: z.number().optional() });
const audio = () => new File(['x'], 'r.webm', { type: 'audio/webm' });

/** A fetch that records calls and answers from a queue. */
function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    const next = answers.shift() || { status: 500, body: { error: 'no answer queued' } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      statusText: next.status && next.status >= 400 ? 'Error' : 'OK',
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('resolveAiConfig', () => {
  it('defaults to Groq with its usual models', () => {
    const config = resolveAiConfig({ GROQ_API_KEY: 'k' });
    expect(config.llm).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b', missing: null });
    expect(config.transcription).toEqual({
      provider: 'groq',
      model: 'whisper-large-v3',
      missing: null,
    });
    expect(config.configured).toBe(true);
  });

  it('says what is missing instead of failing later', () => {
    const config = resolveAiConfig({});
    expect(config.configured).toBe(false);
    expect(describeMissing(config)).toBe('GROQ_API_KEY is not set');
  });

  it('pairs an Anthropic LLM with Groq transcription unless told otherwise', () => {
    const config = resolveAiConfig({ AI_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.model).toBe('claude-opus-5-5');
    expect(config.transcription.provider).toBe('groq');
    expect(config.configured).toBe(false);
    expect(describeMissing(config)).toBe('GROQ_API_KEY is not set');

    const both = resolveAiConfig({
      AI_LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'a',
      AI_TRANSCRIPTION_PROVIDER: 'workers-ai',
      AI: { run: async () => ({}) },
    });
    expect(both.configured).toBe(true);
    expect(both.transcription.model).toBe('@cf/openai/whisper-large-v3-turbo');
  });

  it('follows the LLM provider for transcription when it can transcribe', () => {
    const config = resolveAiConfig({
      AI_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'o',
      AI_LLM_MODEL: ' gpt-4.1-mini ',
    });
    expect(config.transcription.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4.1-mini');
    expect(config.configured).toBe(true);
  });

  it('rejects a provider it does not know', () => {
    expect(() => resolveAiConfig({ AI_LLM_PROVIDER: 'gemini' })).toThrow(
      /AI_LLM_PROVIDER must be one of/
    );
    expect(() =>
      resolveAiConfig({ GROQ_API_KEY: 'k', AI_TRANSCRIPTION_PROVIDER: 'anthropic' })
    ).toThrow(/AI_TRANSCRIPTION_PROVIDER must be one of/);
  });
});

describe('prompt and schema helpers', () => {
  it('renders {placeholders} and leaves unknown braces alone', () => {
    expect(renderPrompt('Hi {name}, {unknown} and {name}', { name: 'Robin' })).toBe(
      'Hi Robin, {unknown} and Robin'
    );
  });

  it('inlines the JSON Schema with no $ref', () => {
    const json = toJsonSchema(shape, 'thing');
    expect(json.type).toBe('object');
    expect(JSON.stringify(json)).not.toContain('$ref');
    expect((json.properties as any).summary.type).toBe('string');
  });
});

describe('OpenAI-compatible provider', () => {
  it('transcribes and completes against the configured base URL, validating the answer', async () => {
    const { impl, calls } = fakeFetch([
      { body: { text: 'add a task' } },
      {
        body: {
          choices: [{ message: { content: JSON.stringify({ summary: 'Done', count: 1 }) } }],
        },
      },
    ]);
    const ai = openAiCompatibleProviders({
      apiKey: 'key',
      baseUrl: 'https://llm.example.org/v1/',
      models: { transcription: 'whisper-1', llm: 'gpt-4o-mini' },
      fetchImpl: impl,
    });

    expect(await ai.transcriber.transcribe(audio())).toBe('add a task');
    expect(calls[0].url).toBe('https://llm.example.org/v1/audio/transcriptions');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer key');

    const result = await ai.llm.complete({ name: 'thing', prompt: 'Do it', schema: shape });
    expect(result).toEqual({ summary: 'Done', count: 1 });
    const sent = JSON.parse(calls[1].init.body as string);
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.messages[0].content).toBe('Do it');
    expect(sent.response_format.json_schema.name).toBe('thing');
  });

  it('turns an API error into a readable message', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { error: 'bad key' } }]);
    const ai = openAiCompatibleProviders({
      apiKey: 'key',
      models: { transcription: 'whisper-1', llm: 'gpt-4o-mini' },
      fetchImpl: impl,
    });
    await expect(ai.transcriber.transcribe(audio())).rejects.toThrow(/Transcription failed: 401/);
  });

  it('refuses an answer that does not match the schema', async () => {
    const { impl } = fakeFetch([
      { body: { choices: [{ message: { content: JSON.stringify({ count: 'many' }) } }] } },
    ]);
    const ai = openAiCompatibleProviders({
      apiKey: 'key',
      models: { transcription: 'whisper-1', llm: 'gpt-4o-mini' },
      fetchImpl: impl,
    });
    await expect(ai.llm.complete({ name: 'thing', prompt: 'x', schema: shape })).rejects.toThrow();
  });
});

describe('your own HTTP service', () => {
  it('follows the documented contract and sends the secret', async () => {
    const { impl, calls } = fakeFetch([
      { body: { text: 'hello' } },
      { body: { result: { summary: 'ok' } } },
    ]);
    const ai = httpProviders({
      url: 'https://ai.internal/',
      secret: 's3',
      models: { transcription: 'default', llm: 'default' },
      fetchImpl: impl,
    });
    expect(await ai.transcriber.transcribe(audio())).toBe('hello');
    expect(calls[0].url).toBe('https://ai.internal/transcribe');
    expect((calls[0].init.headers as any).Authorization).toBe('Bearer s3');

    expect(await ai.llm.complete({ name: 'thing', prompt: 'p', schema: shape })).toEqual({
      summary: 'ok',
    });
    expect(calls[1].url).toBe('https://ai.internal/complete');
    const sent = JSON.parse(calls[1].init.body as string);
    expect(sent).toMatchObject({ name: 'thing', prompt: 'p' });
    expect(sent.schema.type).toBe('object');
  });

  it('rejects a result of the wrong shape', async () => {
    const { impl } = fakeFetch([{ body: { result: { summary: 42 } } }]);
    const ai = httpProviders({
      url: 'https://ai.internal',
      models: { transcription: 'default', llm: 'default' },
      fetchImpl: impl,
    });
    await expect(ai.llm.complete({ name: 'thing', prompt: 'p', schema: shape })).rejects.toThrow();
  });
});

describe('Workers AI provider', () => {
  it('sends base64 to the turbo Whisper model and bytes to the original', async () => {
    const run = vi.fn(async () => ({ text: 'spoken' }));
    const turbo = workersAiProviders(
      { run },
      { transcription: '@cf/openai/whisper-large-v3-turbo', llm: 'm' }
    );
    expect(await turbo.transcriber.transcribe(audio())).toBe('spoken');
    expect(typeof (run.mock.calls[0] as any)[1].audio).toBe('string');

    const classic = workersAiProviders({ run }, { transcription: '@cf/openai/whisper', llm: 'm' });
    await classic.transcriber.transcribe(audio());
    expect(Array.isArray((run.mock.calls[1] as any)[1].audio)).toBe(true);
  });

  it('accepts the structured answer as an object or as a JSON string', async () => {
    const asObject = vi.fn(async () => ({ response: { summary: 'obj' } }));
    const asString = vi.fn(async () => ({ response: JSON.stringify({ summary: 'str' }) }));
    const models = { transcription: 't', llm: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
    expect(
      await workersAiProviders({ run: asObject }, models).llm.complete({
        name: 'thing',
        prompt: 'p',
        schema: shape,
      })
    ).toEqual({ summary: 'obj' });
    expect(
      await workersAiProviders({ run: asString }, models).llm.complete({
        name: 'thing',
        prompt: 'p',
        schema: shape,
      })
    ).toEqual({ summary: 'str' });
    const sent = (asObject.mock.calls[0] as any)[1];
    expect(sent.response_format.type).toBe('json_schema');
  });
});

describe('Anthropic provider', () => {
  it('asks for structured output and validates the text block it gets back', async () => {
    const create = vi.fn(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ summary: 'yes' }) }],
    }));
    const llm = anthropicLlm({
      apiKey: 'a',
      model: 'claude-opus-5-5',
      effort: 'low',
      client: { messages: { create } } as any,
    });
    expect(await llm.complete({ name: 'thing', prompt: 'p', schema: shape })).toEqual({
      summary: 'yes',
    });
    const request = (create.mock.calls[0] as any)[0];
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.messages).toEqual([{ role: 'user', content: 'p' }]);
    expect(request.output_config.effort).toBe('low');
    expect(request.output_config.format.type).toBe('json_schema');
    expect(request.output_config.format.schema.type).toBe('object');
  });

  it('ignores an effort it does not recognise and surfaces a refusal', async () => {
    const create = vi.fn(async () => ({ stop_reason: 'refusal', content: [] }));
    const llm = anthropicLlm({
      apiKey: 'a',
      model: 'claude-opus-5-5',
      effort: 'turbo',
      client: { messages: { create } } as any,
    });
    await expect(llm.complete({ name: 'thing', prompt: 'p', schema: shape })).rejects.toThrow(
      /declined/
    );
    expect((create.mock.calls[0] as any)[0].output_config.effort).toBeUndefined();
  });
});

describe('GET /api/v2/ai/status', () => {
  function appWith() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('userId', 'u');
      c.set('db', {} as any);
      await next();
    });
    app.route('/api/v2/ai', aiApp);
    return app;
  }

  it('names the providers and models without exposing keys', async () => {
    const res = await appWith().request(
      '/api/v2/ai/status',
      {},
      {
        AI_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-secret',
        GROQ_API_KEY: 'gsk-secret',
        AI_LLM_MODEL: 'claude-haiku-5-5',
      }
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toEqual({
      configured: true,
      transcription: { provider: 'groq', model: 'whisper-large-v3', ready: true },
      llm: { provider: 'anthropic', model: 'claude-haiku-5-5', ready: true },
      missing: null,
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('says what is missing on an unconfigured instance', async () => {
    const body: any = await (await appWith().request('/api/v2/ai/status', {}, {})).json();
    expect(body.configured).toBe(false);
    expect(body.missing).toBe('GROQ_API_KEY is not set');
    expect(body.llm.ready).toBe(false);
  });
});
