import { describe, expect, it, vi } from 'vitest';
import { createProvider, geminiFallbacks, isBusy, ProviderError } from '@sima/model-providers';
import { SOLUTION_JSON_SCHEMA } from '@sima/reasoning-engine';
import type { ProviderId } from '@sima/shared-types';

const KEY = 'sk-secret-123';
const request = {
  system: 'sys',
  user: 'usr',
  schema: SOLUTION_JSON_SCHEMA,
  schemaName: 'submit_solution',
  model: 'm1',
};
const result = { answer: 'ok' };

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const replies: Record<ProviderId, unknown> = {
  openai: { choices: [{ message: { content: JSON.stringify(result) } }] },
  anthropic: { content: [{ type: 'tool_use', name: 'submit_solution', input: result }] },
  gemini: { candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] },
  ollama: { message: { content: JSON.stringify(result) } },
};

function sent(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

describe.each(Object.keys(replies) as ProviderId[])('%s provider', (id) => {
  it('sends a structured request and returns the parsed result', async () => {
    const fetchMock = respond(replies[id]);
    const provider = createProvider(id, { apiKey: KEY, fetch: fetchMock });
    expect(await provider.completeStructured(request)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never puts the key in the URL', async () => {
    const fetchMock = respond(replies[id]);
    await createProvider(id, { apiKey: KEY, fetch: fetchMock }).completeStructured(request);
    expect(sent(fetchMock).url).not.toContain(KEY);
  });

  it('redacts the key from error messages', async () => {
    const fetchMock = vi.fn(
      async () => new Response(`bad key ${KEY}`, { status: 401 }),
    ) as unknown as typeof fetch;
    const provider = createProvider(id, { apiKey: id === 'ollama' ? '' : KEY, fetch: fetchMock });
    const error = await provider.completeStructured(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    if (id !== 'ollama') expect((error as Error).message).not.toContain(KEY);
  });
});

describe('provider request shapes', () => {
  it('OpenAI uses strict json_schema', async () => {
    const f = respond(replies.openai);
    await createProvider('openai', { apiKey: KEY, fetch: f }).completeStructured(request);
    const { body, headers } = sent(f);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('Anthropic forces the tool call', async () => {
    const f = respond(replies.anthropic);
    await createProvider('anthropic', { apiKey: KEY, fetch: f }).completeStructured(request);
    const { body, headers } = sent(f);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_solution' });
    expect(headers['x-api-key']).toBe(KEY);
  });

  it('Gemini sends a schema without additionalProperties and the key in a header', async () => {
    const f = respond(replies.gemini);
    await createProvider('gemini', { apiKey: KEY, fetch: f }).completeStructured(request);
    const { body, headers } = sent(f);
    expect(JSON.stringify(body.generationConfig.responseSchema)).not.toContain(
      'additionalProperties',
    );
    expect(headers['x-goog-api-key']).toBe(KEY);
  });

  it('Ollama disables streaming and passes the schema as format', async () => {
    const f = respond(replies.ollama);
    await createProvider('ollama', {
      apiKey: '',
      baseUrl: 'http://localhost:11434/',
      fetch: f,
    }).completeStructured(request);
    const { body, url } = sent(f);
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(SOLUTION_JSON_SCHEMA);
  });

  it('reports non-JSON model output as an error', async () => {
    const f = respond({ message: { content: 'sure! here you go' } });
    await expect(
      createProvider('ollama', { apiKey: '', fetch: f }).completeStructured(request),
    ).rejects.toThrow('not valid JSON');
  });
});

describe('request time limits', () => {
  it('gives a local model longer than an online provider', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await createProvider('ollama', {
      apiKey: '',
      fetch: respond(replies.ollama),
    }).completeStructured(request);
    expect(spy).toHaveBeenLastCalledWith(300_000);
    await createProvider('gemini', {
      apiKey: KEY,
      fetch: respond(replies.gemini),
    }).completeStructured(request);
    expect(spy).toHaveBeenLastCalledWith(120_000);
    spy.mockRestore();
  });
});

describe('busy providers', () => {
  const noWait = vi.fn(async () => {});
  const busy = (status = 503, headers: Record<string, string> = {}) =>
    new Response('{"error":{"message":"high demand","status":"UNAVAILABLE"}}', { status, headers });
  const ok = (id: ProviderId) => new Response(JSON.stringify(replies[id]));
  const queue = (...responses: Response[]) => {
    const fn = vi.fn();
    for (const response of responses) fn.mockResolvedValueOnce(response);
    return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };

  it('retries after a 503, then succeeds', async () => {
    const f = queue(busy(), ok('ollama'));
    const provider = createProvider('ollama', { apiKey: '', fetch: f, sleep: noWait });
    expect(await provider.completeStructured(request)).toEqual(result);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up with a plain message, not the raw error', async () => {
    const f = queue(busy(), busy(), busy());
    const provider = createProvider('ollama', { apiKey: '', fetch: f, sleep: noWait });
    const error = await provider.completeStructured(request).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(3);
    expect((error as Error).message).toContain('very busy');
    expect((error as Error).message).not.toMatch(/503|UNAVAILABLE/);
    expect(isBusy(error)).toBe(true);
  });

  it('explains a rate limit, and waits as long as the provider asks', async () => {
    const sleep = vi.fn(async () => {});
    const f = queue(busy(429, { 'retry-after': '9' }), busy(429), busy(429));
    const provider = createProvider('ollama', { apiKey: '', fetch: f, sleep });
    const error = await provider.completeStructured(request).catch((e: unknown) => e);
    expect(sleep.mock.calls[0]).toEqual([9000]);
    expect((error as Error).message).toContain('limit');
  });

  it('does not retry a bad key', async () => {
    const f = queue(new Response('nope', { status: 401 }));
    const provider = createProvider('gemini', { apiKey: KEY, fetch: f, sleep: noWait });
    await expect(provider.completeStructured(request)).rejects.toThrow('Check the API key');
    expect(f).toHaveBeenCalledOnce();
  });

  it('moves a busy Gemini request to another free model', async () => {
    const models = {
      models: [
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-4-argon',
      ].map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })),
    };
    const f = queue(busy(), busy(), busy(), new Response(JSON.stringify(models)), ok('gemini'));
    const provider = createProvider('gemini', { apiKey: KEY, fetch: f, sleep: noWait });
    expect(await provider.completeStructured({ ...request, model: 'gemini-3.8-flash' })).toEqual(
      result,
    );
    expect(String(f.mock.calls[4]?.[0])).toContain('gemini-3.6-flash');
  });

  it('ranks fallbacks: full Flash models, then Flash-Lite, never paid-only or special models', () => {
    expect(
      geminiFallbacks(
        [
          'gemini-3.8-flash',
          'gemini-3.6-flash',
          'gemini-3.5-flash-lite',
          'gemini-4-argon',
          'gemini-3.8-flash-tts',
        ],
        'gemini-3.8-flash',
      ),
    ).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  });
});
