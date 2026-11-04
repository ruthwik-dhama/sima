import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { startPlayground } from '../../playground/server.mjs';

export const MOCK = 'http://127.0.0.1:5199';
const OLLAMA_PORT = 11499;
const EXTENSION = resolve('apps/extension/.output-e2e/chrome-mv3');

/** A real HTTP server speaking Ollama's protocol, so the whole provider path runs. No model behind it. */
export interface FakeModel {
  requests: string[];
  overrides: Array<(prompt: string) => unknown | undefined>;
}

function keysIn(prompt: string): string[] {
  return [...prompt.matchAll(/fieldKey: (\S+)/g)].map((m) => m[1] as string);
}

function answer(prompt: string): unknown {
  const base = {
    explanation: 'Worked from the question text.',
    steps: ['Read the question', 'Apply the concept'],
    confidence: 0.9,
    calculations: [] as unknown[],
    cannotAnswer: false,
  };
  const keys = keysIn(prompt);
  const table: Record<string, string[]> = {
    q1: ['b'],
    q2: ['two', 'eleven'],
    q3: ['93'],
    q4: ['Gravity exerts a net force on the ball. That force accelerates it downward.'],
    q5: ['2.2'],
    p1i1: ['soy'],
    p1i2: ['vivió'],
    m1: ['apple'],
    m2: ['book'],
    art: ['la'],
    esc: ['Mi familia es pequeña. Tengo una hermana.'],
    speed: ['12.5'],
    speed_unit: ['m/s'],
    accel: ['0'],
    ke: ['9'],
    blank_a: ['2'],
    blank_b: ['3'],
  };
  const calculations = keys.includes('q3')
    ? [{ fieldKey: 'q3', expression: '3^4 + 12' }]
    : keys.includes('speed')
      ? [{ fieldKey: 'speed', expression: '150 / 12.0' }]
      : [];
  return {
    ...base,
    calculations,
    answers: keys.map((fieldKey) => ({ fieldKey, values: table[fieldKey] ?? ['unknown'] })),
  };
}

function startFakeModel(model: FakeModel): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags')
        return res.end(JSON.stringify({ models: [{ name: 'fake-model' }] }));
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const prompt = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      model.requests.push(prompt);
      const followUp = prompt.includes("Student's follow-up");
      const override = model.overrides.map((fn) => fn(prompt)).find((v) => v !== undefined);
      const content =
        override ?? (followUp ? { answer: 'Think of it as a rate of change.' } : answer(prompt));
      setTimeout(
        () => res.end(JSON.stringify({ message: { content: JSON.stringify(content) } })),
        30,
      );
    });
  });
  return new Promise((r) => server.listen(OLLAMA_PORT, '127.0.0.1', () => r(server)));
}

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  model: FakeModel;
  openActivity: (path: string) => Promise<{ page: Page; panel: Page; tabId: number }>;
}

export const test = base.extend<Fixtures>({
  model: async ({}, use) => {
    const model: FakeModel = { requests: [], overrides: [] };
    const server = await startFakeModel(model);
    await use(model);
    await new Promise((r) => server.close(r));
  },
  context: async ({}, use) => {
    const mock = await startPlayground(5199);
    const context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), 'sima-e2e-')),
      {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      },
    );
    await use(context);
    await context.close();
    await new Promise((r) => mock.close(r));
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  openActivity: async ({ context, extensionId, worker, model }, use) => {
    void model;
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    await settings.getByTestId('ollama-url').fill(`http://127.0.0.1:${OLLAMA_PORT}`);
    await settings.getByTestId('model').fill('fake-model');
    await settings.close();

    await use(async (path) => {
      const page = await context.newPage();
      await page.goto(MOCK + path);
      const tabId = await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return tab?.id as number;
      }, page.url());
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
      await page.bringToFront();
      return { page, panel, tabId };
    });
  },
});

export const expect = test.expect;

export async function status(panel: Page, value: string) {
  await expect(panel.getByTestId('task-status')).toHaveAttribute('data-status', value, {
    timeout: 15000,
  });
}

/** The first Fill answers click on an activity asks permission. */
export async function fillFirstTime(panel: Page) {
  await panel.getByTestId('auto-fill').click();
  await panel.getByTestId('permission-yes').click();
}

export async function onPage(panel: Page, index: number) {
  await expect(panel.getByTestId('task-status')).toHaveAttribute('data-page', String(index), {
    timeout: 15000,
  });
}
