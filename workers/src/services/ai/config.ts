/**
 * Which AI services this instance uses, from environment variables.
 *
 * Two jobs, chosen separately: turning a recording into text (transcription) and turning
 * that text into structured changes (the LLM). Each has a provider and a model.
 *
 *   AI_TRANSCRIPTION_PROVIDER   groq | openai | workers-ai | http
 *   AI_TRANSCRIPTION_MODEL      provider-specific model name (each provider has a default)
 *   AI_LLM_PROVIDER             groq | openai | anthropic | workers-ai | http
 *   AI_LLM_MODEL                provider-specific model name (each provider has a default)
 *   AI_LLM_EFFORT               anthropic only: low | medium | high | xhigh | max (model default when unset)
 *
 * Credentials: GROQ_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL for any OpenAI-compatible
 * service), ANTHROPIC_API_KEY, the AI binding for Workers AI, and AI_HTTP_URL (+ AI_HTTP_SECRET)
 * for your own service. Nothing set means Groq, as before.
 */
import type { AiBinding } from './types';

export const LLM_PROVIDERS = ['groq', 'openai', 'anthropic', 'workers-ai', 'http'] as const;
export const TRANSCRIPTION_PROVIDERS = ['groq', 'openai', 'workers-ai', 'http'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

export interface AiEnv {
  AI_LLM_PROVIDER?: string;
  AI_LLM_MODEL?: string;
  AI_LLM_EFFORT?: string;
  AI_TRANSCRIPTION_PROVIDER?: string;
  AI_TRANSCRIPTION_MODEL?: string;
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  AI_HTTP_URL?: string;
  AI_HTTP_SECRET?: string;
  AI?: AiBinding;
}

export const DEFAULT_MODELS = {
  groq: { llm: 'openai/gpt-oss-120b', transcription: 'whisper-large-v3' },
  openai: { llm: 'gpt-4o-mini', transcription: 'whisper-1' },
  anthropic: { llm: 'claude-opus-5-5' },
  'workers-ai': {
    llm: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    transcription: '@cf/openai/whisper-large-v3-turbo',
  },
  http: { llm: 'default', transcription: 'default' },
} as const;

export interface ResolvedService<P extends string> {
  provider: P;
  model: string;
  /** What is missing for this service to work, or null when it is ready. */
  missing: string | null;
}

export interface AiConfig {
  llm: ResolvedService<LlmProvider>;
  transcription: ResolvedService<TranscriptionProvider>;
  /** True when both services have what they need. */
  configured: boolean;
}

export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

function isTranscriptionProvider(value: string): value is TranscriptionProvider {
  return (TRANSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

function credentialsMissing(
  provider: LlmProvider | TranscriptionProvider,
  env: AiEnv
): string | null {
  switch (provider) {
    case 'groq':
      return env.GROQ_API_KEY ? null : 'GROQ_API_KEY is not set';
    case 'openai':
      return env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY is not set';
    case 'anthropic':
      return env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY is not set';
    case 'workers-ai':
      return env.AI ? null : 'the AI binding is not configured in wrangler.toml';
    case 'http':
      return env.AI_HTTP_URL ? null : 'AI_HTTP_URL is not set';
    default:
      return `unknown provider ${String(provider)}`;
  }
}

export function resolveAiConfig(env: AiEnv): AiConfig {
  const llmName = (env.AI_LLM_PROVIDER || 'groq').trim().toLowerCase();
  if (!isLlmProvider(llmName)) {
    throw new AiNotConfiguredError(
      `AI_LLM_PROVIDER must be one of ${LLM_PROVIDERS.join(', ')}, not "${llmName}"`
    );
  }

  // Transcription follows the LLM provider when that provider can transcribe; Anthropic
  // has no speech-to-text, so its default is Groq, as before.
  const transcriptionDefault: TranscriptionProvider = isTranscriptionProvider(llmName)
    ? llmName
    : 'groq';
  const transcriptionName = (env.AI_TRANSCRIPTION_PROVIDER || transcriptionDefault)
    .trim()
    .toLowerCase();
  if (!isTranscriptionProvider(transcriptionName)) {
    throw new AiNotConfiguredError(
      `AI_TRANSCRIPTION_PROVIDER must be one of ${TRANSCRIPTION_PROVIDERS.join(', ')}, not "${transcriptionName}"`
    );
  }

  const llm: ResolvedService<LlmProvider> = {
    provider: llmName,
    model: env.AI_LLM_MODEL?.trim() || DEFAULT_MODELS[llmName].llm,
    missing: credentialsMissing(llmName, env),
  };
  const transcription: ResolvedService<TranscriptionProvider> = {
    provider: transcriptionName,
    model: env.AI_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODELS[transcriptionName].transcription,
    missing: credentialsMissing(transcriptionName, env),
  };

  return { llm, transcription, configured: !llm.missing && !transcription.missing };
}

/** One sentence saying why voice features are off, for error messages. */
export function describeMissing(config: AiConfig): string {
  const parts = [config.transcription.missing, config.llm.missing].filter(Boolean);
  return Array.from(new Set(parts)).join('; ');
}
