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
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  activeProvider: 'ollama',
  models: { openai: '', anthropic: '', gemini: '', ollama: '' },
  ollamaBaseUrl: 'http://localhost:11434',
  disabledPlatforms: [],
  acknowledgedProviders: [],
  floatingEnabled: true,
};

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
