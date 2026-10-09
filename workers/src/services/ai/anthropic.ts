/**
 * Claude, through the Anthropic API with an API key. The request asks for structured output
 * (output_config.format with a JSON Schema), so the answer matches the schema; it is validated
 * again here before use.
 *
 * Anthropic has no speech-to-text, so pair this with another transcription provider.
 */
import Anthropic from '@anthropic-ai/sdk';
import { toJsonSchema } from './schema';
import type { CompletionRequest, StructuredLlm } from './types';

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export function anthropicLlm(options: {
  apiKey: string;
  model: string;
  effort?: string;
  client?: Anthropic;
}): StructuredLlm {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  const effort = (ANTHROPIC_EFFORTS as readonly string[]).includes(options.effort || '')
    ? (options.effort as AnthropicEffort)
    : undefined;

  return {
    async complete<T>({ name, prompt, schema }: CompletionRequest<T>): Promise<T> {
      const response = await client.messages.create({
        model: options.model,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
        output_config: {
          format: { type: 'json_schema', schema: toJsonSchema(schema, name) },
          ...(effort ? { effort } : {}),
        },
      });
      if (response.stop_reason === 'refusal') {
        throw new Error('The model declined this request');
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (!text.trim()) {
        throw new Error('The model returned no structured output');
      }
      return schema.parse(JSON.parse(text));
    },
  };
}
