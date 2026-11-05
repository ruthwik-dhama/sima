import { describe, expect, it } from 'vitest';
import {
  chooseDefaultGeminiModel,
  chooseDefaultOllamaModel,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
} from '@sima/model-providers';
import { DEFAULT_SETTINGS, isAdultOn, SettingsSchema } from '@sima/shared-types';

const on = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe('isAdultOn', () => {
  it.each([
    ['2008-11-05', on(2026, 11, 5), true],
    ['2008-11-06', on(2026, 11, 5), false],
    ['2008-11-04', on(2026, 11, 5), true],
    ['1990-01-01', on(2026, 11, 5), true],
    ['2015-06-15', on(2026, 11, 5), false],
    ['2008-02-29', on(2026, 2, 28), false],
    ['2008-02-29', on(2026, 3, 1), true],
  ])('born %s on %s is adult: %s', (birth, today, expected) => {
    expect(isAdultOn(birth, today)).toBe(expected);
  });

  it.each(['', 'not-a-date', '2026-13-01', '2023-02-30', '2999-01-01', '1800-01-01', '01/15/2000'])(
    'rejects %s',
    (birth) => {
      expect(isAdultOn(birth, on(2026, 11, 5))).toBeNull();
    },
  );
});

describe('default settings', () => {
  it('starts on Gemini with no age answer', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ activeProvider: 'gemini', ageCheck: 'unset' });
  });

  it('asks existing users, whose saved settings have no age answer', () => {
    const saved: Partial<typeof DEFAULT_SETTINGS> = { ...DEFAULT_SETTINGS };
    delete saved.ageCheck;
    expect(SettingsSchema.parse(saved).ageCheck).toBe('unset');
  });
});

describe('chooseDefaultGeminiModel', () => {
  it('prefers the newest general Flash model', () => {
    expect(
      chooseDefaultGeminiModel([
        'gemini-2.5-flash',
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-4-argon',
        'gemini-3.8-flash-tts',
        'gemini-3.8-flash-image-preview',
      ]),
    ).toBe('gemini-3.8-flash');
  });

  it('falls back to Flash-Lite, and to nothing', () => {
    expect(chooseDefaultGeminiModel(['gemini-3.5-flash-lite', 'other'])).toBe(
      'gemini-3.5-flash-lite',
    );
    expect(chooseDefaultGeminiModel(['other'])).toBeNull();
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
    await expect(pullOllamaModel('http://x', 'm', () => {}, refused)).rejects.toThrow('403');
  });
});
