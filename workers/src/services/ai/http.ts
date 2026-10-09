/**
 * Your own service, for anything the built-in providers don't cover: a model behind a
 * company gateway, an agent runtime, or a service that must stay on your own hosts.
 *
 * The contract, both authenticated with `Authorization: Bearer <AI_HTTP_SECRET>` when set:
 *
 *   POST {AI_HTTP_URL}/transcribe    multipart form, field "audio"
 *     -> { "text": "what was said" }
 *
 *   POST {AI_HTTP_URL}/complete      JSON { "name", "prompt", "schema" }
 *     -> { "result": <an object matching schema> }
 *
 * "schema" is JSON Schema. The result is validated here before it is used, so a service that
 * returns the wrong shape gets a clear error rather than a half-applied change.
 */
import { toJsonSchema } from './schema';
import type { AiProviders, CompletionRequest } from './types';

export function httpProviders(options: {
  url: string;
  secret?: string;
  models: { transcription: string; llm: string };
  fetchImpl?: typeof fetch;
}): AiProviders {
  const base = options.url.replace(/\/$/, '');
  const doFetch = options.fetchImpl || fetch;
  const auth: Record<string, string> = options.secret
    ? { Authorization: `Bearer ${options.secret}` }
    : {};

  async function fail(what: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => '');
    throw new Error(
      `${what}: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`
    );
  }

  return {
    transcriber: {
      async transcribe(audio) {
        const body = new FormData();
        body.append('audio', audio, audio.name || 'recording.webm');
        body.append('model', options.models.transcription);
        const response = await doFetch(`${base}/transcribe`, {
          method: 'POST',
          headers: auth,
          body,
        });
        if (!response.ok) {
          await fail('Transcription failed', response);
        }
        const json = (await response.json()) as { text?: string };
        return json.text ?? '';
      },
    },
    llm: {
      async complete<T>({ name, prompt, schema }: CompletionRequest<T>): Promise<T> {
        const response = await doFetch(`${base}/complete`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            model: options.models.llm,
            prompt,
            schema: toJsonSchema(schema, name),
          }),
        });
        if (!response.ok) {
          await fail('The model request failed', response);
        }
        const json = (await response.json()) as { result?: unknown };
        if (json.result == null) {
          throw new Error('The service returned no result');
        }
        return schema.parse(json.result);
      },
    },
  };
}
