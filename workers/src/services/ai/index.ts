/**
 * The AI services behind voice commands and onboarding, chosen per instance.
 * See config.ts for the environment variables and docs/ai-providers.md for the guide.
 */
import { anthropicLlm } from './anthropic';
import {
  AiNotConfiguredError,
  DEFAULT_MODELS,
  describeMissing,
  resolveAiConfig,
  type AiConfig,
  type AiEnv,
} from './config';
import { groqProviders } from './groq';
import { httpProviders } from './http';
import { openAiCompatibleProviders } from './openaiCompatible';
import type { AiProviders, StructuredLlm, Transcriber } from './types';
import { workersAiProviders } from './workersAi';

export { AiNotConfiguredError, DEFAULT_MODELS, describeMissing, resolveAiConfig };
export type { AiConfig, AiEnv, AiProviders, StructuredLlm, Transcriber };

function transcriberFor(config: AiConfig, env: AiEnv): Transcriber {
  const { provider, model } = config.transcription;
  const models = { transcription: model, llm: config.llm.model };
  switch (provider) {
    case 'groq':
      return groqProviders(env.GROQ_API_KEY!, models).transcriber;
    case 'openai':
      return openAiCompatibleProviders({
        apiKey: env.OPENAI_API_KEY!,
        baseUrl: env.OPENAI_BASE_URL,
        models,
      }).transcriber;
    case 'workers-ai':
      return workersAiProviders(env.AI!, models).transcriber;
    case 'http':
      return httpProviders({ url: env.AI_HTTP_URL!, secret: env.AI_HTTP_SECRET, models })
        .transcriber;
    default:
      throw new AiNotConfiguredError(`No transcription provider called ${String(provider)}`);
  }
}

function llmFor(config: AiConfig, env: AiEnv): StructuredLlm {
  const { provider, model } = config.llm;
  const models = { transcription: config.transcription.model, llm: model };
  switch (provider) {
    case 'groq':
      return groqProviders(env.GROQ_API_KEY!, models).llm;
    case 'openai':
      return openAiCompatibleProviders({
        apiKey: env.OPENAI_API_KEY!,
        baseUrl: env.OPENAI_BASE_URL,
        models,
      }).llm;
    case 'anthropic':
      return anthropicLlm({ apiKey: env.ANTHROPIC_API_KEY!, model, effort: env.AI_LLM_EFFORT });
    case 'workers-ai':
      return workersAiProviders(env.AI!, models).llm;
    case 'http':
      return httpProviders({ url: env.AI_HTTP_URL!, secret: env.AI_HTTP_SECRET, models }).llm;
    default:
      throw new AiNotConfiguredError(`No LLM provider called ${String(provider)}`);
  }
}

/** The providers this instance is configured for. Throws AiNotConfiguredError when something is missing. */
export function providersFromEnv(env: AiEnv): AiProviders {
  const config = resolveAiConfig(env);
  if (!config.configured) {
    throw new AiNotConfiguredError(`Voice features are not configured: ${describeMissing(config)}`);
  }
  return { transcriber: transcriberFor(config, env), llm: llmFor(config, env) };
}

/** Groq with the default models, for callers that still pass a Groq key directly. */
export function providersForGroqKey(apiKey: string): AiProviders {
  return groqProviders(apiKey, {
    transcription: DEFAULT_MODELS.groq.transcription,
    llm: DEFAULT_MODELS.groq.llm,
  });
}
