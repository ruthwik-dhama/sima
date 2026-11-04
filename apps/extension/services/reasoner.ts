import { createProvider, type ModelProvider } from '@sima/model-providers';
import { PROVIDER_ENDPOINTS, type ProviderId, type Settings } from '@sima/shared-types';
import type { Reasoner } from '@sima/task-orchestrator';
import { loadApiKey, loadSettings } from './settings';

export function providerOrigin(provider: ProviderId, settings: Settings): string {
  return provider === 'ollama'
    ? new URL(settings.ollamaBaseUrl).origin
    : PROVIDER_ENDPOINTS[provider].origin;
}

export function originPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function buildProvider(
  provider: ProviderId,
  settings: Settings,
): Promise<ModelProvider> {
  return createProvider(provider, {
    apiKey: await loadApiKey(provider),
    ...(provider === 'ollama' ? { baseUrl: settings.ollamaBaseUrl } : {}),
  });
}

/** Lives only in the background: API keys are never sent to a content script or page. */
export const reasoner: Reasoner = {
  async assertReady() {
    const settings = await loadSettings();
    const id = settings.activeProvider;
    const endpoint = PROVIDER_ENDPOINTS[id];
    if (!settings.models[id]) throw new Error(`Choose a model for ${endpoint.name} in Settings.`);
    if (id !== 'ollama' && !(await loadApiKey(id)))
      throw new Error(`Add an API key for ${endpoint.name} in Settings.`);
    if (endpoint.external && !settings.acknowledgedProviders.includes(id)) {
      throw new Error(`Confirm that question text may be sent to ${endpoint.name} first.`);
    }
    const granted = await chrome.permissions.contains({
      origins: [originPattern(providerOrigin(id, settings))],
    });
    if (!granted) throw new Error(`Allow Sima to reach ${endpoint.name} in Settings.`);
  },
  async complete(prompt, schema, schemaName) {
    const settings = await loadSettings();
    const id = settings.activeProvider;
    const provider = await buildProvider(id, settings);
    return provider.completeStructured({
      ...prompt,
      schema,
      schemaName,
      model: settings.models[id] ?? '',
    });
  },
};
