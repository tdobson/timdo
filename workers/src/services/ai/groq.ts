/** Groq: Whisper for transcription and an open-weights chat model via LangChain, as TimDo always used. */
import { ChatGroq } from '@langchain/groq';
import Groq from 'groq-sdk';
import type { AiProviders, CompletionRequest } from './types';

export function groqProviders(
  apiKey: string,
  models: { transcription: string; llm: string }
): AiProviders {
  const groq = new Groq({ apiKey });
  return {
    transcriber: {
      async transcribe(audio) {
        const result = await groq.audio.transcriptions.create({
          file: audio,
          model: models.transcription,
        });
        return result.text;
      },
    },
    llm: {
      async complete<T>({ prompt, schema }: CompletionRequest<T>): Promise<T> {
        const model = new ChatGroq({ apiKey, model: models.llm });
        const structured = model.withStructuredOutput(schema as never);
        return (await structured.invoke(prompt)) as T;
      },
    },
  };
}
