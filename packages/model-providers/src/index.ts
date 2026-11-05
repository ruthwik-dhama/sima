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
  /** How to wait between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Told how each Gemini model attempt went. Never receives the key or the question text. */
  onAttempt?: (attempt: ModelAttempt) => void | Promise<void>;
}

export interface ModelAttempt {
  model: string;
  /** HTTP status, or undefined if there was no usable reply. */
  status: number | undefined;
  ms: number;
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
/** A local model answering a whole page on a laptop can take minutes. */
const LOCAL_REQUEST_TIMEOUT_MS = 300_000;
/** Overloaded or rate limited: these usually clear within seconds, so they're worth another try. */
const BUSY_STATUSES = [429, 503];
const RETRY_DELAYS_MS = [1500, 4000];
const MAX_RETRY_AFTER_MS = 15_000;
/** The one pause on Gemini, once every model has said it's overloaded. */
const GEMINI_RETRY_PAUSE_MS = 3000;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isBusy(error: unknown): boolean {
  return error instanceof ProviderError && BUSY_STATUSES.includes(error.status ?? 0);
}

function busyMessage(status: number): string {
  return status === 429
    ? "You've reached this AI provider's limit for now. Try again in a minute, or tomorrow if it's the daily limit."
    : 'This AI provider is very busy right now. Wait a minute, then try again.';
}

interface HttpOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  secret: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Fail on the first busy reply, for callers with somewhere else to go. */
  once?: boolean;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function http(options: HttpOptions): Promise<Record<string, unknown>> {
  if (options.once) return httpOnce(options);
  const sleep = options.sleep ?? realSleep;
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await httpOnce(options);
    } catch (error) {
      if (!isBusy(error)) throw error;
      const asked = (error as ProviderError & { retryAfterMs?: number }).retryAfterMs ?? 0;
      await sleep(Math.min(Math.max(asked, delay), MAX_RETRY_AFTER_MS));
    }
  }
  return httpOnce(options);
}

async function httpOnce(options: HttpOptions): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      // A stalled provider must not leave a task stuck in its working state.
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(redact(`Could not reach provider: ${String(error)}`, options.secret));
  }
  const text = await response.text();
  if (BUSY_STATUSES.includes(response.status)) {
    const error = new ProviderError(busyMessage(response.status), response.status);
    const seconds = Number(response.headers.get('retry-after'));
    return Promise.reject(Object.assign(error, { retryAfterMs: seconds > 0 ? seconds * 1000 : 0 }));
  }
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
        sleep: config.sleep,
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
        sleep: config.sleep,
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
        sleep: config.sleep,
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
        sleep: config.sleep,
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
  const listGeminiModels = async (once: boolean) => {
    const data = await http({
      url: `${base}/v1beta/models?pageSize=200`,
      method: 'GET',
      headers,
      secret: config.apiKey,
      fetchImpl,
      sleep: config.sleep,
      once,
    });
    return asArray(data.models)
      .filter((m) =>
        (m.supportedGenerationMethods as string[] | undefined)?.includes('generateContent'),
      )
      .map((m) => String(m.name).replace(/^models\//, ''));
  };
  return {
    id: 'gemini',
    async completeStructured(req) {
      const generate = async (model: string) => {
        const data = await http({
          url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          headers,
          secret: config.apiKey,
          fetchImpl,
          once: true,
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
      };
      const attempt = async (model: string) => {
        const started = Date.now();
        const report = (status: number | undefined) =>
          config.onAttempt?.({ model, status, ms: Date.now() - started });
        try {
          const result = await generate(model);
          await report(200);
          return result;
        } catch (error) {
          await report(error instanceof ProviderError ? error.status : undefined);
          throw error;
        }
      };

      // Busy replies hit one model at a time, so another free model is quicker than waiting.
      let firstError: unknown;
      const overloaded: string[] = [];
      const tryModel = async (model: string): Promise<{ result: unknown } | null> => {
        try {
          return { result: await attempt(model) };
        } catch (error) {
          if (!isBusy(error)) throw error;
          firstError ??= error;
          if ((error as ProviderError).status === 503) overloaded.push(model);
          return null;
        }
      };

      const first = await tryModel(req.model);
      if (first) return first.result;
      const others = await listGeminiModels(true).catch(() => []);
      for (const model of geminiFallbacks(others, req.model)) {
        const answer = await tryModel(model);
        if (answer) return answer.result;
      }
      // A rate limit won't clear in seconds, but an overload might, so that gets one more try.
      const again = [...overloaded];
      if (again.length > 0) {
        await (config.sleep ?? realSleep)(GEMINI_RETRY_PAUSE_MS);
        for (const model of again) {
          const answer = await tryModel(model);
          if (answer) return answer.result;
        }
      }
      throw firstError;
    },
    listModels: () => listGeminiModels(false),
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
        timeoutMs: LOCAL_REQUEST_TIMEOUT_MS,
        headers: {},
        secret: '',
        fetchImpl,
        sleep: config.sleep,
        body: {
          model: req.model,
          stream: false,
          format: req.schema,
          // Sampling variety only costs accuracy on questions with one right answer.
          // A matching set with its choices and page material needs more than the default window.
          options: { temperature: 0, num_ctx: 8192 },
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
        sleep: config.sleep,
      });
      return asArray(data.models).map((m) => String(m.name));
    },
  };
}

export const RECOMMENDED_OLLAMA_MODEL = 'qwen2.5:7b';

/** The recommended model if it's installed, otherwise the first that can answer questions. */
export function chooseDefaultOllamaModel(models: string[]): string | null {
  if (models.includes(RECOMMENDED_OLLAMA_MODEL)) return RECOMMENDED_OLLAMA_MODEL;
  return models.find((model) => !/embed/i.test(model)) ?? null;
}

/**
 * Downloads a model through Ollama, reporting 0 to 1. Ollama keeps what it already has, so calling
 * this again after a failure resumes. It only finishes on Ollama's own success line.
 */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (fraction: number) => void,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<void> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok || !response.body) {
    throw new ProviderError(`Provider returned ${response.status}.`, response.status);
  }
  const layers = new Map<string, { total: number; completed: number }>();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = '';
  let succeeded = false;
  const readLine = (line: string) => {
    if (!line.trim()) return;
    const update = JSON.parse(line) as Record<string, unknown>;
    if (typeof update.error === 'string') throw new ProviderError(update.error);
    if (update.status === 'success') succeeded = true;
    if (typeof update.digest === 'string' && typeof update.total === 'number') {
      layers.set(update.digest, {
        total: update.total,
        completed: typeof update.completed === 'number' ? update.completed : 0,
      });
      const all = [...layers.values()];
      const total = all.reduce((sum, layer) => sum + layer.total, 0);
      const completed = all.reduce((sum, layer) => sum + layer.completed, 0);
      if (total > 0) onProgress(Math.min(completed / total, 1));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(readLine);
    if (done) break;
  }
  readLine(pending);
  if (!succeeded) throw new ProviderError('The download ended early.');
}

const GEMINI_TEXT_MODEL = (model: string) =>
  /flash/i.test(model) && !/image|tts|audio|live|embedding|robotics|preview|exp/i.test(model);
const geminiVersion = (model: string) => Number(model.match(/(\d+(?:\.\d+)?)/)?.[1] ?? 0);

/**
 * Picks a sensible text model from what a Gemini key can use, since model names change over time.
 * Prefers the newest general Flash model, then the newest Flash-Lite.
 */
export function chooseDefaultGeminiModel(models: string[]): string | null {
  const text = models.filter(GEMINI_TEXT_MODEL);
  const newest = (list: string[]) =>
    [...list].sort((a, b) => geminiVersion(b) - geminiVersion(a))[0];
  return newest(text.filter((m) => !/lite/i.test(m))) ?? newest(text) ?? null;
}

const MAX_GEMINI_FALLBACKS = 2;

/** Other general text models to try when one is overloaded, newest full Flash models first. */
export function geminiFallbacks(models: string[], current: string): string[] {
  const text = models.filter((m) => m !== current && GEMINI_TEXT_MODEL(m));
  const rank = (m: string) => (/lite/i.test(m) ? 0 : 1000) + geminiVersion(m);
  return [...text].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_GEMINI_FALLBACKS);
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
