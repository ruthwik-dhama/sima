import { createProvider, type ModelAttempt, type ModelProvider } from '@sima/model-providers';
import { PROVIDER_ENDPOINTS, type ProviderId, type Settings } from '@sima/shared-types';
import type { Reasoner } from '@sima/task-orchestrator';
import { assertProviderAllowed, loadApiKey, loadSettings } from './settings';

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
  sleep?: (ms: number) => Promise<void>,
  onAttempt?: (attempt: ModelAttempt) => void | Promise<void>,
): Promise<ModelProvider> {
  return createProvider(provider, {
    apiKey: await loadApiKey(provider),
    ...(provider === 'ollama' ? { baseUrl: settings.ollamaBaseUrl } : {}),
    ...(sleep ? { sleep } : {}),
    ...(onAttempt ? { onAttempt } : {}),
  });
}

const KEEP_ALIVE_MS = 20_000;

/**
 * Chrome stops an idle background worker after about 30 seconds, and waiting on a model doesn't
 * count as activity. A slow reply with the dropdown closed would otherwise be lost, so this makes
 * a harmless extension call regularly until the reply arrives.
 */
async function keepWorkerAlive<T>(work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Lives only in the background: API keys are never sent to a content script or page. */
export const reasoner: Reasoner = {
  async assertReady() {
    const settings = await loadSettings();
    const id = settings.activeProvider;
    assertProviderAllowed(settings, id);
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
  async complete(prompt, schema, schemaName, hooks) {
    const settings = await loadSettings();
    const id = settings.activeProvider;
    assertProviderAllowed(settings, id);
    const provider = await buildProvider(
      id,
      settings,
      async (ms) => {
        await hooks?.onBusy?.();
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      async ({ model, status, ms }) => {
        // Timing only, to tell a busy provider from a slow answer. Never the key or the question.
        console.info(`[Sima] ${model}: ${status ?? 'no reply'} in ${(ms / 1000).toFixed(1)}s`);
        if (status === 429 || status === 503) await hooks?.onBusy?.();
      },
    );
    return keepWorkerAlive(() =>
      provider.completeStructured({
        ...prompt,
        schema,
        schemaName,
        model: settings.models[id] ?? '',
      }),
    );
  },
};
