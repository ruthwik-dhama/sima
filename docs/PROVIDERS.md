# AI providers

Sima asks for your birth date once. If you're 18 or older, **Google Gemini's free tier is the default**, using a free key from [Google AI Studio](https://aistudio.google.com/apikey). If you're under 18, Sima uses Ollama, and online providers are refused. Gemini's free tier also isn't available in the EEA, Switzerland or the UK. See the [privacy terms](PRIVACY.md).

**Setting up Gemini:** Settings shows one guided screen. After you agree to the terms, Sima opens Google AI Studio. You copy your free key there and paste it into Sima, which checks it and picks a model. Sima can't create the key for you: Google offers no supported way for an app like this to do that, and Sima doesn't read AI Studio's pages.

For any other provider, choose it in Settings, then press **Save and test connection**. Chrome asks for permission to reach that provider, and Sima lists the models available to you. Type or pick one.

| Provider       | Key from              | Structured output method                    |
| -------------- | --------------------- | ------------------------------------------- |
| Ollama (local) | None needed           | `format` with a JSON schema                 |
| OpenAI         | platform.openai.com   | `response_format` with a strict JSON schema |
| Anthropic      | console.anthropic.com | Forced tool call                            |
| Google Gemini  | aistudio.google.com   | `responseSchema`                            |

Whichever provider you use, Sima validates the result with Zod, then checks it against the fields and options on the page.

**Testing status:** the Ollama path has run end to end against a fake local server. The other three have request-shape and response-parsing tests with mocked HTTP, and haven't been run against the live APIs. Sima picks the newest general Flash model your Gemini key lists when you test the connection, because model availability changes. Other providers have no default model.

## Requests

Sima sends a page's questions together in one request, or several on a very long page, and checks each answer against its own question. Only questions that fail a check are asked again.

## When a provider is busy

If a provider reports it's overloaded or rate limited, Sima waits and retries twice. On Gemini it then tries up to two other free Flash models, so the answer may come from a different model than the one in Settings. If that fails too, Sima stops asking and shows a plain message, and clicking the button again solves whatever is left.

## Ollama

**Setting up Ollama:** Settings shows one guided screen. You install and open Ollama, and Sima checks that it can reach it. If no model is installed, Sima downloads `qwen2.5:7b` through Ollama, about 5 GB. If you already have models, Sima uses `qwen2.5:7b` when it's there, or otherwise the first one that can answer questions, and you can change it in Settings.

Current versions of Ollama accept requests from Chrome extensions. If yours refuses them, update it, or start it with:

```bash
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

Only `localhost` and `127.0.0.1` server URLs are accepted, so that choosing Ollama always means data stays on your computer. Choose a model with reliable JSON output.

## Adding a provider

Implement `ModelProvider` in `packages/model-providers`, add it to `ProviderIdSchema`, `PROVIDER_ENDPOINTS` and `createProvider`, add its origin to `optional_host_permissions`, and extend `tests/unit/providers.test.ts`. Put the key in a header, never the URL.
