import {
  DEFAULT_SETTINGS,
  PROVIDER_ENDPOINTS,
  SettingsSchema,
  type ProviderId,
  type Settings,
} from '@sima/shared-types';

const SETTINGS_KEY = 'settings';
const keyName = (provider: ProviderId) => `apiKey:${provider}`;
const ALL_PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'ollama'];

/** Runs at every worker start, and stops content scripts reading storage.local (including keys). */
export function lockStorageToExtensionPages(): Promise<void> {
  return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const parsed = SettingsSchema.safeParse(stored[SETTINGS_KEY]);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: SettingsSchema.parse(settings) });
}

export async function loadApiKey(provider: ProviderId): Promise<string> {
  const stored = await chrome.storage.local.get(keyName(provider));
  const value = stored[keyName(provider)];
  return typeof value === 'string' ? value : '';
}

export async function saveApiKey(provider: ProviderId, apiKey: string): Promise<void> {
  if (apiKey) await chrome.storage.local.set({ [keyName(provider)]: apiKey });
  else await chrome.storage.local.remove(keyName(provider));
}

export async function deleteApiKeys(): Promise<void> {
  await chrome.storage.local.remove(ALL_PROVIDERS.map(keyName));
}

export async function configuredProviders(): Promise<ProviderId[]> {
  const stored = await chrome.storage.local.get(ALL_PROVIDERS.map(keyName));
  return ALL_PROVIDERS.filter((p) => typeof stored[keyName(p)] === 'string');
}

/** Refuses a provider this user's age check doesn't allow. Enforced here, not just in the UI. */
export function assertProviderAllowed(settings: Settings, provider: ProviderId): void {
  if (settings.ageCheck === 'unset') {
    throw new Error('Enter your birth date in Sima first.');
  }
  if (settings.ageCheck === 'minor' && PROVIDER_ENDPOINTS[provider].external) {
    throw new Error('Online AI providers are for people 18 and older. Sima uses Ollama for you.');
  }
}
