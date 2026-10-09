/**
 * Cloudflare Workers AI: runs inside the same Cloudflare account as the API, so no extra
 * provider account is needed. Add to wrangler.toml:
 *
 *   [ai]
 *   binding = "AI"
 */
import { toJsonSchema } from './schema';
import type { AiBinding, AiProviders, CompletionRequest } from './types';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function workersAiProviders(
  ai: AiBinding,
  models: { transcription: string; llm: string }
): AiProviders {
  return {
    transcriber: {
      async transcribe(audio) {
        const bytes = new Uint8Array(await audio.arrayBuffer());
        // The turbo model takes base64; the original Whisper model takes a byte array.
        const input = models.transcription.includes('turbo')
          ? { audio: toBase64(bytes) }
          : { audio: Array.from(bytes) };
        const result = (await ai.run(models.transcription, input)) as { text?: string };
        return result.text ?? '';
      },
    },
    llm: {
      async complete<T>({ name, prompt, schema }: CompletionRequest<T>): Promise<T> {
        const result = (await ai.run(models.llm, {
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: toJsonSchema(schema, name) },
        })) as { response?: unknown };
        const raw =
          typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
        if (raw == null) {
          throw new Error('The model returned no content');
        }
        return schema.parse(raw);
      },
    },
  };
}
