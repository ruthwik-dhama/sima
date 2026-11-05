export interface StructuredRequest {
  system: string;
  user: string;
  schema: Readonly<Record<string, unknown>>;
  schemaName: string;
  model: string;
}

export interface ProviderConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** How to wait between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ModelProvider {
  /** Returns the JSON the model produced. The caller validates it with Zod. */
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

/** Ollama refuses an extension that isn't in its OLLAMA_ORIGINS setting. Setup shows the fix. */
export const OLLAMA_BLOCKED_MESSAGE =
  "Ollama is blocking Sima. Open Sima's settings and follow the steps to allow it.";

export function isOllamaBlocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes(OLLAMA_BLOCKED_MESSAGE);
}

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
/** A local model answering a whole page on a laptop can take minutes. */
const REQUEST_TIMEOUT_MS = 300_000;
/** Ollama answers 503 when its queue is full, which usually clears within seconds. */
const BUSY_STATUSES = [429, 503];
const RETRY_DELAYS_MS = [1500, 4000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isBusy(error: unknown): boolean {
  return error instanceof ProviderError && BUSY_STATUSES.includes(error.status ?? 0);
}

const BUSY_MESSAGE = 'Ollama is busy with another request. Wait a moment, then try again.';

interface HttpOptions {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Fail on the first busy reply. */
  once?: boolean;
}

async function http(options: HttpOptions): Promise<Record<string, unknown>> {
  if (options.once) return httpOnce(options);
  const sleep = options.sleep ?? realSleep;
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await httpOnce(options);
    } catch (error) {
      if (!isBusy(error)) throw error;
      await sleep(delay);
    }
  }
  return httpOnce(options);
}

async function httpOnce(options: HttpOptions): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      // A stalled model must not leave a task stuck in its working state.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(`Could not reach Ollama: ${String(error)}`);
  }
  const text = await response.text();
  if (BUSY_STATUSES.includes(response.status)) {
    throw new ProviderError(BUSY_MESSAGE, response.status);
  }
  // A 403 with no body is how Ollama refuses a request's origin.
  if (response.status === 403 && !text.trim()) {
    throw new ProviderError(OLLAMA_BLOCKED_MESSAGE, 403);
  }
  if (!response.ok) {
    throw new ProviderError(
      `Ollama returned ${response.status}. ${text.slice(0, 300)}`.trim(),
      response.status,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderError('Ollama returned a response that was not JSON.');
  }
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== 'string') throw new ProviderError('Ollama response had no text content.');
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

/** Sima's only model provider: Ollama on this computer, so question text never leaves it. */
export function createOllamaProvider(config: ProviderConfig = {}): ModelProvider {
  const fetchImpl = config.fetch ?? fetch.bind(globalThis);
  const base = (config.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  return {
    async completeStructured(req) {
      const data = await http({
        url: `${base}/api/chat`,
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
        fetchImpl,
        sleep: config.sleep,
      });
      // Chrome sends no Origin on this GET, so it can pass while every question would be refused.
      // An empty POST is refused the same way a question is, and otherwise changes nothing.
      await http({ url: `${base}/api/show`, body: { model: '' }, fetchImpl, once: true }).catch(
        (error: unknown) => {
          if (isOllamaBlocked(error)) throw error;
        },
      );
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
  if (response.status === 403) throw new ProviderError(OLLAMA_BLOCKED_MESSAGE, 403);
  if (!response.ok || !response.body) {
    throw new ProviderError(`Ollama returned ${response.status}.`, response.status);
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
