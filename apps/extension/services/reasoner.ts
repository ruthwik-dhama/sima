import { createOllamaProvider } from '@sima/model-providers';
import type { Settings } from '@sima/shared-types';
import type { Reasoner } from '@sima/task-orchestrator';
import { loadSettings } from './settings';

export function ollamaProvider(settings: Settings, sleep?: (ms: number) => Promise<void>) {
  return createOllamaProvider({ baseUrl: settings.ollamaBaseUrl, ...(sleep ? { sleep } : {}) });
}

const KEEP_ALIVE_MS = 20_000;

/**
 * Chrome stops an idle background worker after about 30 seconds, and waiting on a model doesn't
 * count as activity. A slow reply with the dropdown closed would otherwise be lost, so this makes
 * a harmless extension call regularly until the work finishes.
 */
export async function keepWorkerAlive<T>(work: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Sends questions only to Ollama on this computer. */
export const reasoner: Reasoner = {
  async assertReady() {
    const settings = await loadSettings();
    if (!settings.model) throw new Error('Finish setting up local AI in Sima first.');
  },
  async complete(prompt, schema, schemaName, hooks) {
    const settings = await loadSettings();
    const provider = ollamaProvider(settings, async (ms) => {
      await hooks?.onBusy?.();
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    return keepWorkerAlive(() =>
      provider.completeStructured({ ...prompt, schema, schemaName, model: settings.model }),
    );
  },
};
