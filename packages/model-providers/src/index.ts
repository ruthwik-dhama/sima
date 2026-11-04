import type { ProviderId } from '@sima/shared-types';

export interface StructuredRequest {
  system: string;
  user: string;
  schema: Readonly<Record<string, unknown>>;
  schemaName: string;
  model: string;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface ModelProvider {
  id: ProviderId;
  /** Returns the JSON text the model produced. The caller validates it with Zod. */
  completeStructured(request: StructuredRequest): Promise<unknown>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

interface HttpOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  secret: string;
  fetchImpl: typeof fetch;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function http(options: HttpOptions): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      // A stalled provider must not leave a task stuck in its working state.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(redact(`Could not reach provider: ${String(error)}`, options.secret));
  }
  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check the API key and permissions.'
        : '';
    throw new ProviderError(
      redact(`Provider returned ${response.status}.${hint} ${text.slice(0, 300)}`, options.secret),
      response.status,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError('Provider returned a response that was not JSON.');
  }
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== 'string') throw new ProviderError('Provider response had no text content.');
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ProviderError('Model output was not valid JSON.');
  }
}

type Json = Record<string, unknown>;
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

export function createOpenAIProvider(config: ProviderConfig): ModelProvider {
  const fetchImpl = config.fetch ?? fetch.bind(globalThis);
  const base = config.baseUrl ?? 'https://api.openai.com';
  const headers = { authorization: `Bearer ${config.apiKey}` };
  return {
    id: 'openai',
    async completeStructured(req) {
      const data = await http({
        url: `${base}/v1/chat/completions`,
        headers,
        secret: config.apiKey,
        fetchImpl,
        body: {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schemaName, strict: true, schema: req.schema },
          },
        },
      });
      const message = asArray(data.choices)[0]?.message as Json | undefined;
      if (message?.refusal) throw new ProviderError(`Model declined: ${String(message.refusal)}`);
      return parseJsonText(message?.content);
    },
    async listModels() {
      const data = await http({
        url: `${base}/v1/models`,
        method: 'GET',
        headers,
        secret: config.apiKey,
        fetchImpl,
      });
      return asArray(data.data)
        .map((m) => String(m.id))
        .sort();
    },
  };
}

export function createAnthropicProvider(config: ProviderConfig): ModelProvider {
  const fetchImpl = config.fetch ?? fetch.bind(globalThis);
  const base = config.baseUrl ?? 'https://api.anthropic.com';
  const headers = {
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  return {
    id: 'anthropic',
    async completeStructured(req) {
      // A forced tool call is how the Messages API returns schema-shaped output.
      const data = await http({
        url: `${base}/v1/messages`,
        headers,
        secret: config.apiKey,
        fetchImpl,
        body: {
          model: req.model,
          max_tokens: 4096,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          tools: [
            { name: req.schemaName, description: 'Return the result.', input_schema: req.schema },
          ],
          tool_choice: { type: 'tool', name: req.schemaName },
        },
      });
      const block = asArray(data.content).find((b) => b.type === 'tool_use');
      if (!block) throw new ProviderError('Model did not return structured output.');
      return block.input;
    },
    async listModels() {
      const data = await http({
        url: `${base}/v1/models?limit=100`,
        method: 'GET',
        headers,
        secret: config.apiKey,
        fetchImpl,
      });
      return asArray(data.data).map((m) => String(m.id));
    },
  };
}

/** Gemini's responseSchema accepts an OpenAPI subset without additionalProperties. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema as Json)
      .filter(([key]) => key !== 'additionalProperties')
      .map(([key, value]) => [key, toGeminiSchema(value)]),
  );
}

export function createGeminiProvider(config: ProviderConfig): ModelProvider {
  const fetchImpl = config.fetch ?? fetch.bind(globalThis);
  const base = config.baseUrl ?? 'https://generativelanguage.googleapis.com';
  // The key goes in a header, not the URL, so it cannot appear in logs of request URLs.
  const headers = { 'x-goog-api-key': config.apiKey };
  return {
    id: 'gemini',
    async completeStructured(req) {
      const data = await http({
        url: `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
        headers,
        secret: config.apiKey,
        fetchImpl,
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(req.schema),
          },
        },
      });
      const content = asArray(data.candidates)[0]?.content as Json | undefined;
      return parseJsonText(asArray(content?.parts)[0]?.text);
    },
    async listModels() {
      const data = await http({
        url: `${base}/v1beta/models?pageSize=200`,
        method: 'GET',
        headers,
        secret: config.apiKey,
        fetchImpl,
      });
      return asArray(data.models)
        .filter((m) =>
          (m.supportedGenerationMethods as string[] | undefined)?.includes('generateContent'),
        )
        .map((m) => String(m.name).replace(/^models\//, ''));
    },
  };
}

export function createOllamaProvider(config: ProviderConfig): ModelProvider {
  const fetchImpl = config.fetch ?? fetch.bind(globalThis);
  const base = (config.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  return {
    id: 'ollama',
    async completeStructured(req) {
      const data = await http({
        url: `${base}/api/chat`,
        headers: {},
        secret: '',
        fetchImpl,
        body: {
          model: req.model,
          stream: false,
          format: req.schema,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
      });
      return parseJsonText((data.message as Json | undefined)?.content);
    },
    async listModels() {
      const data = await http({
        url: `${base}/api/tags`,
        method: 'GET',
        headers: {},
        secret: '',
        fetchImpl,
      });
      return asArray(data.models).map((m) => String(m.name));
    },
  };
}

export function createProvider(id: ProviderId, config: ProviderConfig): ModelProvider {
  switch (id) {
    case 'openai':
      return createOpenAIProvider(config);
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'gemini':
      return createGeminiProvider(config);
    case 'ollama':
      return createOllamaProvider(config);
  }
}
