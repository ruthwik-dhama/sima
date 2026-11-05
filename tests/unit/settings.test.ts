import { describe, expect, it } from 'vitest';
import {
  chooseDefaultOllamaModel,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
} from '@sima/model-providers';
import { DEFAULT_SETTINGS, migrateSettings, SettingsSchema } from '@sima/shared-types';

describe('settings', () => {
  it('start with no model, so onboarding runs, and the usual Ollama address', () => {
    expect(DEFAULT_SETTINGS.model).toBe('');
    expect(DEFAULT_SETTINGS.ollamaBaseUrl).toBe('http://localhost:11434');
  });

  it('keep the local model and preferences from builds that had online providers', () => {
    const old = {
      activeProvider: 'gemini',
      models: { openai: '', anthropic: '', gemini: 'gemini-3.8-flash', ollama: 'qwen2.5:14b' },
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      disabledPlatforms: ['webassign'],
      acknowledgedProviders: ['gemini'],
      floatingEnabled: false,
      ageCheck: 'adult',
    };
    expect(SettingsSchema.parse(migrateSettings(old))).toEqual({
      model: 'qwen2.5:14b',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      disabledPlatforms: ['webassign'],
      floatingEnabled: false,
    });
  });

  it('send someone who only used an online provider through local setup', () => {
    const old = {
      ollamaBaseUrl: 'http://localhost:11434',
      disabledPlatforms: [],
      floatingEnabled: true,
      models: { gemini: 'gemini-3.8-flash', ollama: '' },
    };
    expect(SettingsSchema.parse(migrateSettings(old)).model).toBe('');
  });

  it('accept only a local Ollama address', () => {
    const parse = (ollamaBaseUrl: string) =>
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ollamaBaseUrl }).success;
    expect(parse('http://localhost:11434')).toBe(true);
    expect(parse('http://127.0.0.1:8080')).toBe(true);
    expect(parse('https://api.openai.com')).toBe(false);
    expect(parse('http://example.com:11434')).toBe(false);
  });
});

describe('chooseDefaultOllamaModel', () => {
  it('prefers the recommended model, then any model that can answer', () => {
    expect(chooseDefaultOllamaModel(['other:1b', RECOMMENDED_OLLAMA_MODEL])).toBe(
      RECOMMENDED_OLLAMA_MODEL,
    );
    expect(chooseDefaultOllamaModel(['nomic-embed-text', 'other:1b'])).toBe('other:1b');
    expect(chooseDefaultOllamaModel(['nomic-embed-text'])).toBeNull();
    expect(chooseDefaultOllamaModel([])).toBeNull();
  });
});

describe('pullOllamaModel', () => {
  const stream = (chunks: string[]) =>
    (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
      )) as unknown as typeof fetch;

  it('adds up every layer, including a line split across chunks', async () => {
    const seen: number[] = [];
    await pullOllamaModel(
      'http://localhost:11434/',
      'm',
      (fraction) => seen.push(fraction),
      stream([
        '{"status":"pulling manifest"}\n{"status":"a","digest":"a","total":100,"completed":50}\n{"sta',
        'tus":"b","digest":"b","total":100,"completed":50}\n',
        '{"status":"success"}\n',
      ]),
    );
    expect(seen).toEqual([0.5, 0.5]);
  });

  it('fails when the stream ends without success', async () => {
    await expect(
      pullOllamaModel('http://x', 'm', () => {}, stream(['{"status":"pulling manifest"}\n'])),
    ).rejects.toThrow('ended early');
  });

  it('reports an error line from Ollama', async () => {
    await expect(
      pullOllamaModel('http://x', 'm', () => {}, stream(['{"error":"no space left"}\n'])),
    ).rejects.toThrow('no space left');
  });

  it('fails on a refused request', async () => {
    const refused = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(pullOllamaModel('http://x', 'm', () => {}, refused)).rejects.toThrow(
      'blocking Sima',
    );
  });
});
