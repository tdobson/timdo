# AI providers: choosing per instance

Voice commands and voice onboarding need two services: one that turns a recording into text, and one that turns that text into structured changes. Each instance picks a provider for each job with environment variables on the Worker. Nothing set means Groq for both, which is how TimDo has always run.

## The variables

| Variable | Values | Default |
|---|---|---|
| `AI_TRANSCRIPTION_PROVIDER` | `groq`, `openai`, `workers-ai`, `http` | the LLM provider if it can transcribe, else `groq` |
| `AI_TRANSCRIPTION_MODEL` | a model name the provider knows | per provider, below |
| `AI_LLM_PROVIDER` | `groq`, `openai`, `anthropic`, `workers-ai`, `http` | `groq` |
| `AI_LLM_MODEL` | a model name the provider knows | per provider, below |
| `AI_LLM_EFFORT` | `low`, `medium`, `high`, `xhigh`, `max` (Anthropic only) | the model's default |

Set them with `wrangler secret put` for keys and in `[vars]` in `wrangler.toml` for the rest, or in `workers/.dev.vars` locally.

`GET /api/v2/ai/status` reports which providers and models are in use and whether they are ready. It never returns a key. The web app reads it and hides the microphone when voice is not configured.

## Providers

**Groq** (`GROQ_API_KEY`). Whisper `whisper-large-v3` for transcription and `openai/gpt-oss-120b` for the LLM. The free tier is enough for one person; Groq's limits apply per organisation, not per key.

**OpenAI-compatible** (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`). Defaults to OpenAI itself with `whisper-1` and `gpt-4o-mini`. Point `OPENAI_BASE_URL` at anything that speaks the OpenAI API: Groq's compatible endpoint (`https://api.groq.com/openai/v1`), OpenRouter, Mistral, a local Ollama or vLLM, or a company gateway. The LLM is asked for JSON matching a schema (`response_format: json_schema`), and the answer is validated before use.

**Anthropic** (`ANTHROPIC_API_KEY`). Claude through the Anthropic API, default model `claude-opus-5-5`. Structured output comes from the API itself, so the answer always matches the schema. Anthropic has no speech-to-text, so pair it with `AI_TRANSCRIPTION_PROVIDER` set to `groq`, `openai` or `workers-ai`. For a cheaper model set `AI_LLM_MODEL=claude-haiku-5-5`; for less thinking on this simple task set `AI_LLM_EFFORT=low`.

A note on Claude subscriptions. A Claude Pro or Max plan's login, including the token from `claude setup-token`, only works inside Claude Code and the Agent SDK. It is rejected by the Messages API and Anthropic's terms do not allow a product to route requests through it. So the Worker needs an API key. Max and Team plans include monthly API credits that can be claimed into a Console organisation and used with an API key. If you already run something on your own hosts that holds a Claude login, put it behind the `http` provider below instead.

**Workers AI** (the `AI` binding). Runs inside the same Cloudflare account as the API, so no extra account or key. Add to `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

Defaults are `@cf/openai/whisper-large-v3-turbo` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The free allowance is 10,000 neurons a day, which is a few hours of transcription or a few hundred voice commands.

**Your own service** (`AI_HTTP_URL`, optional `AI_HTTP_SECRET`). For anything else: a model behind a gateway, an agent runtime, or inference that must stay on your own machines. The Worker calls two endpoints, sending `Authorization: Bearer <AI_HTTP_SECRET>` when the secret is set:

```
POST {AI_HTTP_URL}/transcribe     multipart form, field "audio" (and "model")
  -> { "text": "what was said" }

POST {AI_HTTP_URL}/complete       JSON { "name", "model", "prompt", "schema" }
  -> { "result": <an object matching schema> }
```

`schema` is JSON Schema. The result is validated against it before anything is changed, so a wrong shape is an error, not a half-applied command.

## Mixing providers

The two jobs are independent. Common pairs:

| Transcription | LLM | When |
|---|---|---|
| groq | groq | the default, one free key |
| workers-ai | workers-ai | no accounts beyond Cloudflare |
| workers-ai or groq | anthropic | Claude for the reasoning, cheap speech-to-text |
| openai (base URL set) | openai (same) | one OpenAI-compatible gateway for everything |
| http | http | everything through your own service |

## Where the code is

`workers/src/services/ai/`: `config.ts` reads the variables, one file per provider, and `index.ts` builds the pair the instance asked for. `aiService.ts` renders the prompts and calls whatever it is given, so the prompts do not change with the provider. Tests are in `workers/src/__tests__/ai.providers.test.ts`.
