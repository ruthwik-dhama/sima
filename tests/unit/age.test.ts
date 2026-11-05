import { describe, expect, it } from 'vitest';
import { chooseDefaultGeminiModel } from '@sima/model-providers';
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
