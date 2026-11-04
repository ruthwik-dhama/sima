import { describe, expect, it, vi } from 'vitest';
import { createProvider, ProviderError } from '@sima/model-providers';
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
