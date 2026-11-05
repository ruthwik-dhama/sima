import {
  DEFAULT_SETTINGS,
  migrateSettings,
  SettingsSchema,
  type Settings,
} from '@sima/shared-types';

const SETTINGS_KEY = 'settings';
/** Where earlier builds kept online provider keys. Sima no longer uses any. */
const OLD_KEY_NAMES = ['apiKey:openai', 'apiKey:anthropic', 'apiKey:gemini', 'apiKey:ollama'];

/** Runs at every worker start, and stops content scripts reading storage.local. */
export function lockStorageToExtensionPages(): Promise<void> {
  return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

/** Deletes any API key an earlier build saved, at every worker start. */
export function removeOldApiKeys(): Promise<void> {
  return chrome.storage.local.remove(OLD_KEY_NAMES);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const parsed = SettingsSchema.safeParse(migrateSettings(stored[SETTINGS_KEY]));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: SettingsSchema.parse(settings) });
}
