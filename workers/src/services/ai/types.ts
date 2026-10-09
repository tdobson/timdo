import type { z } from 'zod';

/** Turns a recording into text. */
export interface Transcriber {
  transcribe(audio: File): Promise<string>;
}

export interface CompletionRequest<T> {
  /** A short identifier for the output shape, e.g. "voice_command". Some providers need one. */
  name: string;
  /** The full prompt, already rendered. */
  prompt: string;
  /** The shape the answer must have. The result is validated against it. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}

/** Answers a prompt with structured output that matches a schema. */
export interface StructuredLlm {
  complete<T>(request: CompletionRequest<T>): Promise<T>;
}

export interface AiProviders {
  transcriber: Transcriber;
  llm: StructuredLlm;
}

/** The subset of the Workers AI binding this code uses, so no particular workers-types version is needed. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}
