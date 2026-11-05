import { describe, expect, it, vi } from 'vitest';
import {
  createOllamaProvider,
  isBusy,
  isOllamaBlocked,
  pullOllamaModel,
} from '@sima/model-providers';
import { SOLUTION_JSON_SCHEMA } from '@sima/reasoning-engine';

const request = {
  system: 'sys',
  user: 'usr',
  schema: SOLUTION_JSON_SCHEMA,
  schemaName: 'submit_solution',
  model: 'm1',
};
const result = { answer: 'ok' };
const reply = { message: { content: JSON.stringify(result) } };

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function sent(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}

describe('the Ollama provider', () => {
  it('sends one structured, non-streaming request and returns the parsed result', async () => {
    const f = respond(reply);
    const provider = createOllamaProvider({ baseUrl: 'http://localhost:11434/', fetch: f });
    expect(await provider.completeStructured(request)).toEqual(result);
    const { body, url, headers } = sent(f);
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.stream).toBe(false);
    expect(body.format).toEqual(SOLUTION_JSON_SCHEMA);
    expect(body.options.temperature).toBe(0);
    // No key and no credentials of any kind.
    expect(Object.keys(headers)).toEqual(['content-type']);
  });

  it('uses the usual local address by default', async () => {
    const f = respond(reply);
    await createOllamaProvider({ fetch: f }).completeStructured(request);
    expect(sent(f).url).toBe('http://localhost:11434/api/chat');
  });

  it('reports non-JSON model output as an error', async () => {
    const f = respond({ message: { content: 'sure! here you go' } });
    await expect(createOllamaProvider({ fetch: f }).completeStructured(request)).rejects.toThrow(
      'not valid JSON',
    );
  });

  it('gives a local model five minutes before giving up', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await createOllamaProvider({ fetch: respond(reply) }).completeStructured(request);
    expect(spy).toHaveBeenLastCalledWith(300_000);
    spy.mockRestore();
  });

  it('explains a closed Ollama in plain words', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(createOllamaProvider({ fetch: f }).completeStructured(request)).rejects.toThrow(
      'Could not reach Ollama',
    );
  });
});

describe('an Ollama that refuses Sima', () => {
  const refused = () => new Response('', { status: 403 });
  const models = () => new Response(JSON.stringify({ models: [{ name: 'a' }] }));

  it('explains a refused question without a raw status', async () => {
    const f = vi.fn(async () => refused()) as unknown as typeof fetch;
    const error = await createOllamaProvider({ fetch: f })
      .completeStructured(request)
      .catch((e: unknown) => e);
    expect(isOllamaBlocked(error)).toBe(true);
    expect((error as Error).message).not.toContain('403');
    expect(f).toHaveBeenCalledOnce();
  });

  it('keeps the detail of a 403 that has a body, since that is a different problem', async () => {
    const f = vi.fn(
      async () => new Response('{"error":"subscription required"}', { status: 403 }),
    ) as unknown as typeof fetch;
    const error = await createOllamaProvider({ fetch: f })
      .completeStructured(request)
      .catch((e: unknown) => e);
    expect(isOllamaBlocked(error)).toBe(false);
    expect((error as Error).message).toContain('subscription required');
  });

  it('notices during a connection test, even though listing models succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(models())
      .mockResolvedValueOnce(refused()) as unknown as typeof fetch;
    const error = await createOllamaProvider({ fetch: f })
      .listModels()
      .catch((e: unknown) => e);
    expect(isOllamaBlocked(error)).toBe(true);
  });

  it('lists models when the check gets past the origin rule, whatever it answers', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(models())
      .mockResolvedValueOnce(new Response('{"error":"model is required"}', { status: 400 }));
    const provider = createOllamaProvider({ fetch: f as unknown as typeof fetch });
    expect(await provider.listModels()).toEqual(['a']);
  });

  it('explains a refused model download', async () => {
    const f = vi.fn(async () => refused()) as unknown as typeof fetch;
    const error = await pullOllamaModel('http://localhost:11434', 'a', () => {}, f).catch(
      (e: unknown) => e,
    );
    expect(isOllamaBlocked(error)).toBe(true);
  });
});

describe('a busy Ollama', () => {
  const noWait = vi.fn(async () => {});
  const busy = () => new Response('{"error":"server busy"}', { status: 503 });
  const queue = (...responses: Response[]) => {
    const fn = vi.fn();
    for (const response of responses) fn.mockResolvedValueOnce(response);
    return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };

  it('retries after a 503, then succeeds', async () => {
    const f = queue(busy(), new Response(JSON.stringify(reply)));
    const provider = createOllamaProvider({ fetch: f, sleep: noWait });
    expect(await provider.completeStructured(request)).toEqual(result);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after three tries with a plain message', async () => {
    const f = queue(busy(), busy(), busy());
    const provider = createOllamaProvider({ fetch: f, sleep: noWait });
    const error = await provider.completeStructured(request).catch((e: unknown) => e);
    expect(f).toHaveBeenCalledTimes(3);
    expect((error as Error).message).toContain('busy');
    expect((error as Error).message).not.toContain('503');
    expect(isBusy(error)).toBe(true);
  });

  it('does not retry a missing model', async () => {
    const f = queue(new Response('{"error":"model not found"}', { status: 404 }));
    const provider = createOllamaProvider({ fetch: f, sleep: noWait });
    await expect(provider.completeStructured(request)).rejects.toThrow('model not found');
    expect(f).toHaveBeenCalledOnce();
  });
});
