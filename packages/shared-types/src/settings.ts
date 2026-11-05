import { z } from 'zod';

const localUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Must be an http://localhost or http://127.0.0.1 URL');

/** Sima runs only on a local Ollama model, so there are no keys or online providers to configure. */
export const SettingsSchema = z.object({
  /** The Ollama model Sima uses. Empty until setup picks one. */
  model: z.string(),
  ollamaBaseUrl: localUrl,
  disabledPlatforms: z.array(z.string()),
  floatingEnabled: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  model: '',
  ollamaBaseUrl: 'http://localhost:11434',
  disabledPlatforms: [],
  floatingEnabled: true,
};

/**
 * Reads settings saved by earlier builds, which could use online providers, keeping only what
 * still applies: the local model and address, and the platform and floating preferences.
 */
export function migrateSettings(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const old = raw as { model?: unknown; models?: { ollama?: unknown } };
  if (typeof old.model === 'string') return raw;
  const model = typeof old.models?.ollama === 'string' ? old.models.ollama : '';
  return { ...raw, model };
}

/** Whether Ollama answers Sima. "blocked" means it is running but refuses this extension. */
export const OllamaStatusSchema = z.object({
  status: z.enum(['ready', 'blocked', 'not_running']),
  models: z.array(z.string()),
});
export type OllamaStatus = z.infer<typeof OllamaStatusSchema>;

/** A model download running in the background, kept in storage so the dropdown can close. */
export const ModelDownloadSchema = z.object({
  model: z.string(),
  state: z.enum(['running', 'failed', 'blocked']),
  /** 0 to 1, or null before Ollama reports sizes. */
  fraction: z.number().min(0).max(1).nullable(),
  updatedAt: z.number(),
});
export type ModelDownload = z.infer<typeof ModelDownloadSchema>;
export const MODEL_DOWNLOAD_KEY = 'modelDownload';
