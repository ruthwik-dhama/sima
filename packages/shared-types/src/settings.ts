import { z } from 'zod';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'gemini', 'ollama']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const localUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Must be an http://localhost or http://127.0.0.1 URL');

/** Non-secret preferences. API keys are held separately and never leave the background context. */
export const SettingsSchema = z.object({
  activeProvider: ProviderIdSchema,
  models: z.record(ProviderIdSchema, z.string()),
  ollamaBaseUrl: localUrl,
  disabledPlatforms: z.array(z.string()),
  /** Providers for which the user acknowledged that page content is sent to them. */
  acknowledgedProviders: z.array(ProviderIdSchema),
  floatingEnabled: z.boolean(),
  /** The result of the one-time birth date step. The date itself is never stored. */
  ageCheck: z.enum(['unset', 'adult', 'minor']).default('unset'),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  activeProvider: 'gemini',
  models: { openai: '', anthropic: '', gemini: '', ollama: '' },
  ollamaBaseUrl: 'http://localhost:11434',
  disabledPlatforms: [],
  acknowledgedProviders: [],
  floatingEnabled: true,
  ageCheck: 'unset',
};

const BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether someone born on a YYYY-MM-DD date is 18 by `today`, or null if it isn't a real, past date.
 * Compares calendar dates, so people turn 18 at the start of their birthday in local time.
 */
export function isAdultOn(birthDate: string, today: Date): boolean | null {
  const match = birthDate.match(BIRTH_DATE);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(year, month - 1, day);
  const real =
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  const stamp = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
  const now = stamp(today.getFullYear(), today.getMonth() + 1, today.getDate());
  if (!real || year < 1900 || stamp(year, month, day) > now) return null;
  return stamp(year + 18, month, day) <= now;
}

export const PROVIDER_ENDPOINTS: Record<
  ProviderId,
  { name: string; origin: string; external: boolean }
> = {
  openai: { name: 'OpenAI', origin: 'https://api.openai.com', external: true },
  anthropic: { name: 'Anthropic', origin: 'https://api.anthropic.com', external: true },
  gemini: {
    name: 'Google Gemini',
    origin: 'https://generativelanguage.googleapis.com',
    external: true,
  },
  ollama: { name: 'Ollama (local)', origin: 'http://localhost', external: false },
};
