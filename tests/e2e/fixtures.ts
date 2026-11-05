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
  delayMs?: number;
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
    question_101_wol_0: ['estudiamos'],
    question_102_wol_0: ['fueron'],
    question_103_wol_0: ['leí'],
    question_103_wol_1: ['vio'],
    question_201_0: ['es'],
    question_202_0: ['son'],
    question_203_0: ['hace'],
    question_203_1: ['hace'],
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

type Answers = Array<{ fieldKey: string; values: string[] }> | Record<string, string[]>;
type Reply = Record<string, unknown> & { answers?: Answers; omit?: string[] };

/**
 * A page arrives as one request, so overrides change only the fields they name. A reply with no
 * answers replaces everything, which is how a test sends unusable output.
 */
function withOverrides(prompt: string, overrides: Reply[]): unknown {
  const base = answer(prompt) as Reply & { answers: Array<{ fieldKey: string; values: string[] }> };
  let merged = base;
  for (const override of overrides) {
    if (!('answers' in override)) return override;
    const named = Array.isArray(override.answers)
      ? override.answers
      : Object.entries(override.answers ?? {}).map(([fieldKey, values]) => ({ fieldKey, values }));
    const replaced = new Set([...named.map((a) => a.fieldKey), ...(override.omit ?? [])]);
    merged = {
      ...merged,
      ...override,
      answers: [...merged.answers.filter((a) => !replaced.has(a.fieldKey)), ...named],
    };
  }
  return merged;
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
      const overrides = model.overrides.map((fn) => fn(prompt)).filter((v) => v !== undefined);
      const content = followUp
        ? { answer: 'Think of it as a rate of change.' }
        : withOverrides(prompt, overrides as Reply[]);
      setTimeout(
        () => res.end(JSON.stringify({ message: { content: JSON.stringify(content) } })),
        model.delayMs ?? 30,
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
    await setBirthDate(settings, MINOR_BIRTH_DATE);
    await settings.reload();
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
      await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
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

/** Rows stay collapsed unless they need attention. */
export async function openRow(panel: Page, questionId: string) {
  const row = panel.getByTestId(`question-${questionId}`);
  if ((await row.getAttribute('open')) === null)
    await panel.getByTestId(`row-${questionId}`).click();
}

/** Dates relative to any test run: a child, and someone well past 18. */
export const MINOR_BIRTH_DATE = `${new Date().getFullYear() - 10}-01-15`;
export const ADULT_BIRTH_DATE = `${new Date().getFullYear() - 30}-01-15`;

export function setBirthDate(page: Page, birthDate: string) {
  return page.evaluate(
    (date) => chrome.runtime.sendMessage({ type: 'SET_BIRTH_DATE', birthDate: date }),
    birthDate,
  );
}
