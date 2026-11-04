# AI providers

Choose a provider in Settings, then press **Save and test connection**. Chrome asks for permission to reach that provider, and Sima lists the models available to you. Type or pick one.

| Provider       | Key from              | Structured output method                    |
| -------------- | --------------------- | ------------------------------------------- |
| Ollama (local) | None needed           | `format` with a JSON schema                 |
| OpenAI         | platform.openai.com   | `response_format` with a strict JSON schema |
| Anthropic      | console.anthropic.com | Forced tool call                            |
| Google Gemini  | aistudio.google.com   | `responseSchema`                            |

Whichever provider you use, Sima validates the result with Zod, then checks it against the fields and options on the page.

**Testing status:** the Ollama path has run end to end against a fake local server. The other three have request-shape and response-parsing tests with mocked HTTP, and haven't been run against the live APIs. Sima sets no default model for any provider, because model availability changes and depends on your account.

## Ollama

Ollama must accept requests from the extension's origin:

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Only `localhost` and `127.0.0.1` server URLs are accepted, so that choosing Ollama always means data stays on your computer. Choose a model with reliable JSON output.

## Adding a provider

Implement `ModelProvider` in `packages/model-providers`, add it to `ProviderIdSchema`, `PROVIDER_ENDPOINTS` and `createProvider`, add its origin to `optional_host_permissions`, and extend `tests/unit/providers.test.ts`. Put the key in a header, never the URL.
