/**
 * Any service that speaks the OpenAI API: OpenAI itself, Groq's OpenAI-compatible endpoint,
 * OpenRouter, Mistral, a local Ollama or vLLM, and so on. Point OPENAI_BASE_URL at it.
 */
import { toJsonSchema } from './schema';
import type { AiProviders, CompletionRequest } from './types';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

async function failureMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`;
}

export function openAiCompatibleProviders(options: {
  apiKey: string;
  baseUrl?: string;
  models: { transcription: string; llm: string };
  fetchImpl?: typeof fetch;
}): AiProviders {
  const base = (options.baseUrl || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, '');
  const doFetch = options.fetchImpl || fetch;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  return {
    transcriber: {
      async transcribe(audio) {
        const body = new FormData();
        body.append('file', audio, audio.name || 'recording.webm');
        body.append('model', options.models.transcription);
        const response = await doFetch(`${base}/audio/transcriptions`, {
          method: 'POST',
          headers,
          body,
        });
        if (!response.ok) {
          throw new Error(`Transcription failed: ${await failureMessage(response)}`);
        }
        const json = (await response.json()) as { text?: string };
        return json.text ?? '';
      },
    },
    llm: {
      async complete<T>({ name, prompt, schema }: CompletionRequest<T>): Promise<T> {
        const response = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: options.models.llm,
            messages: [{ role: 'user', content: prompt }],
            response_format: {
              type: 'json_schema',
              json_schema: { name, schema: toJsonSchema(schema, name), strict: false },
            },
          }),
        });
        if (!response.ok) {
          throw new Error(`The model request failed: ${await failureMessage(response)}`);
        }
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('The model returned no content');
        }
        return schema.parse(JSON.parse(content));
      },
    },
  };
}
