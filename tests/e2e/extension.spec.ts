import { readFileSync } from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import {
  ADULT_BIRTH_DATE,
  OLLAMA_PORT,
  expect,
  fillFirstTime,
  MINOR_BIRTH_DATE,
  MOCK,
  onPage,
  openRow,
  setBirthDate,
  status,
  test,
} from './fixtures';

test.describe('foundation', () => {
  test('manifest asks for the minimum', async ({ worker }) => {
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions?.sort()).toEqual(['storage']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  test('the floating pill is isolated, opens the panel, and can be dismissed', async ({
    openActivity,
    worker,
  }) => {
    const { page } = await openActivity('/gradescope/assignment.html');
    // Hostile host CSS must not reach the assistant.
    await page.addStyleTag({
      content:
        'html { font-size: 8px !important; } button, div, p, span { color: red !important; font-size: 40px !important; }',
    });
    const floating = page.getByTestId('sima-floating');
    await expect(floating).toBeVisible();
    await expect(page.getByTestId('sima-floating-status')).toContainText('0 of 5');
    const pillLogo = page.getByTestId('sima-floating-logo');
    await expect(pillLogo).toBeVisible();
    expect(await pillLogo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    expect(await pillLogo.getAttribute('src')).toMatch(/^data:image\/png/);
    const style = await page.getByTestId('sima-floating-status').evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: s.fontSize, color: s.color };
    });
    expect(style.fontSize).toBe('13px');
    expect(style.color).not.toBe('rgb(255, 0, 0)');
    const box = await floating.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        position: s.position,
        height: el.getBoundingClientRect().height,
        boxShadow: s.boxShadow,
      };
    });
    expect(box.position).toBe('fixed');
    expect(box.height).toBeLessThan(44);
    expect(box.boxShadow).not.toBe('none');
    expect(await floating.evaluate((el) => el.getRootNode() instanceof ShadowRoot)).toBe(true);

    // Clicking the pill asks the background to open the panel for this tab.
    await worker.evaluate(() => {
      const target = globalThis as unknown as { popupOpened: boolean };
      target.popupOpened = false;
      chrome.action.openPopup = (async () => {
        target.popupOpened = true;
      }) as unknown as typeof chrome.action.openPopup;
    });
    await page.getByTestId('sima-floating-open').click();
    await expect
      .poll(() =>
        worker.evaluate(() => (globalThis as unknown as { popupOpened: boolean }).popupOpened),
      )
      .toBe(true);

    await page.mouse.move(0, 0);
    await expect(page.getByTestId('sima-floating-dismiss')).toHaveCSS('opacity', '0');
    await floating.hover();
    await expect(page.getByTestId('sima-floating-dismiss')).toHaveCSS('opacity', '1');
    await page.getByTestId('sima-floating-dismiss').click();
    await expect(floating).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(800);
    await expect(floating).toHaveCount(0);
  });

  test('API keys are unreachable from the content script context', async ({
    context,
    extensionId,
    openActivity,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await context
      .serviceWorkers()[0]!
      .evaluate(() => chrome.storage.local.set({ 'apiKey:openai': 'sk-e2e-secret' }));
    const reply = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    );
    expect(JSON.stringify(reply)).not.toContain('sk-e2e-secret');

    const { page } = await openActivity('/gradescope/assignment.html');
    await page.getByTestId('sima-floating').waitFor();
    // Evaluate inside the content script's own isolated world, through the DevTools protocol.
    const cdp = await context.newCDPSession(page);
    const contexts: Array<{
      id: number;
      name: string;
      origin: string;
      auxData?: { type?: string };
    }> = [];
    cdp.on('Runtime.executionContextCreated', (e) =>
      contexts.push(e.context as (typeof contexts)[number]),
    );
    await cdp.send('Runtime.enable');
    const isolated = contexts.find(
      (c) => c.auxData?.type === 'isolated' && c.origin.includes(extensionId),
    );
    expect(isolated).toBeTruthy();
    const evaluate = async (expression: string) =>
      await cdp.send('Runtime.evaluate', {
        expression,
        contextId: isolated!.id,
        awaitPromise: true,
        returnByValue: true,
      });

    const direct = await evaluate(
      `chrome.storage.local.get(null).then(v => JSON.stringify(v), e => 'denied: ' + e.message)`,
    );
    expect(String(direct.result.value)).toContain('denied');
    expect(String(direct.result.value)).not.toContain('sk-e2e-secret');

    // Content scripts also can't use settings commands to change or read provider state.
    const viaMessage = await evaluate(
      `chrome.runtime.sendMessage({ type: 'SET_API_KEY', provider: 'openai', apiKey: 'overwritten' }).then(r => JSON.stringify(r), e => 'denied: ' + e.message)`,
    );
    expect(String(viaMessage.result.value)).toMatch(/"ok":false|denied/);
    const worker = context.serviceWorkers()[0]!;
    const stored = await worker.evaluate(() => chrome.storage.local.get('apiKey:openai'));
    expect(stored['apiKey:openai']).toBe('sk-e2e-secret');
  });

  test('settings reject a non-local Ollama address', async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await setBirthDate(options, MINOR_BIRTH_DATE);
    await options.reload();
    await options.getByTestId('local-manual').click();
    await options.getByTestId('ollama-url').fill('https://attacker.example');
    await expect(options.getByTestId('settings-message')).toBeVisible();
    await options.reload();
    await options.getByTestId('local-manual').click();
    await expect(options.getByTestId('ollama-url')).not.toHaveValue('https://attacker.example');
  });

  test('connection test lists models from the provider', async ({
    context,
    extensionId,
    openActivity,
  }) => {
    void openActivity;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByTestId('test-connection').click();
    await expect(options.getByTestId('settings-message')).toContainText('1 models available');
  });
});

test.describe('restricted assessments', () => {
  for (const path of ['/gradescope/exam.html', '/vhl/test.html', '/webassign/test.html']) {
    test(`${path} stays blocked, with nothing sent or filled`, async ({ openActivity, model }) => {
      const { page, panel } = await openActivity(path);
      await status(panel, 'blocked_restricted');
      await expect(panel.getByTestId('restricted-notice')).toBeVisible();
      await expect(panel.getByTestId('solve-all')).toHaveCount(0);
      await expect(panel.getByTestId('auto-fill')).toHaveCount(0);
      await expect(page.getByTestId('sima-floating-status')).toContainText('Not available');
      expect(model.requests).toEqual([]);
    });
  }
});

test.describe('Gradescope mock', () => {
  test('full flow: explain, fill, edit, fill again, verify, never submit', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await expect(panel.locator('[data-testid^="question-"]')).toHaveCount(5);

    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    await expect(panel.getByTestId('explanation-q3')).toContainText(
      'Worked from the question text',
    );
    await expect(
      panel.getByTestId('checks-q3').locator('[data-check="pass"]').first(),
    ).toContainText('3^4 + 12');
    await expect(page.locator('input[name=q3]')).toHaveValue('');

    // Hidden injection text never reached the model.
    const q4 = model.requests.find((r) => r.includes('dropped ball')) ?? '';
    expect(q4).not.toContain('API key');
    expect(q4).not.toContain('submit button');
    expect(q4).toContain('<page_content>');
    await expect(panel.getByTestId('injection-q4')).toContainText('banana');

    await fillFirstTime(panel);
    await expect(panel.getByTestId('field-state-q3')).toContainText('Entered', { timeout: 15000 });
    await status(panel, 'review');

    await expect(page.locator('input[name=q1][value=b]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=two]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=eleven]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=nine]')).not.toBeChecked();
    await expect(page.locator('input[name=q3]')).toHaveValue('93');
    await expect(page.locator('textarea[name=q4]')).toHaveValue(/Gravity/);
    await expect(page.locator('input[name=q5]')).toHaveValue('2.2');
    await expect(panel.getByTestId('progress-text')).toContainText('5 of 5');

    // An edit is what gets entered next, replacing Sima's own earlier entry.
    await openRow(panel, 'q3');
    await panel.getByTestId('response-q3').fill('94');
    await panel.getByTestId('response-q3').blur();
    await panel.getByTestId('auto-fill').click();
    await expect(page.locator('input[name=q3]')).toHaveValue('94', { timeout: 15000 });
    expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
  });

  test('the panel shows only the two main buttons', async ({ openActivity }) => {
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await expect(panel.getByTestId('controls').getByRole('button')).toHaveText([
      'Fill answers',
      'Explain only',
    ]);
    await fillFirstTime(panel);
    await expect(panel.getByTestId('field-state-q3')).toContainText('Entered', { timeout: 15000 });
    await status(panel, 'review');
    await expect(panel.getByText('Activity log')).toHaveCount(0);
    await expect(panel.getByText('stays on this computer')).toHaveCount(0);
    await expect(panel.getByText('Approve this response')).toHaveCount(0);
  });

  test('follow-up questions get answered in place', async ({ openActivity }) => {
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    await openRow(panel, 'q1');
    await panel.getByTestId('follow-up-q1').fill('Explain it another way');
    await panel.getByTestId('follow-up-q1').press('Enter');
    await expect(panel.getByTestId('follow-up-entry')).toContainText('rate of change');
  });

  test('schema-invalid model output becomes a visible error, not an action', async ({
    openActivity,
    model,
  }) => {
    model.overrides.push((prompt) =>
      prompt.includes('vector') ? { run: 'document.forms[0].submit()' } : undefined,
    );
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await expect(panel.getByTestId('solve-error-q1')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('input[name=q1]:checked')).toHaveCount(0);
  });

  test('wrong arithmetic gets corrected from its calculation, and flagged', async ({
    openActivity,
    model,
  }) => {
    model.overrides.push((prompt) =>
      prompt.includes('fieldKey: q3')
        ? {
            answers: [{ fieldKey: 'q3', values: ['100'] }],
            explanation: 'x',
            steps: [],
            confidence: 0.99,
            calculations: [{ fieldKey: 'q3', expression: '3^4 + 12' }],
            cannotAnswer: false,
          }
        : undefined,
    );
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await expect(panel.getByTestId('confidence-q3')).toContainText('60%', { timeout: 15000 });
    await expect(panel.getByTestId('response-q3')).toHaveValue('93');
    await expect(panel.getByTestId('checks-q3')).toContainText('Corrected');
    await expect(panel.getByTestId('held-q3')).toHaveCount(0);
  });

  test('answer letters select choices by position, including several at once', async ({
    openActivity,
    model,
  }) => {
    const reply = (fieldKey: string, values: string[]) => ({
      answers: { [fieldKey]: values },
      explanation: 'x',
      steps: [],
      confidence: 0.9,
      calculations: [],
      cannotAnswer: false,
    });
    model.overrides.push((prompt) => {
      if (prompt.includes('fieldKey: q1')) return reply('q1', ['b']);
      if (prompt.includes('fieldKey: q2')) return reply('q2', ['a', 'c']);
      return undefined;
    });
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);

    await expect(page.locator('input[name=q1][value=b]')).toBeChecked({ timeout: 15000 });
    await expect(page.locator('input[name=q2][value=two]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=eleven]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=nine]')).not.toBeChecked();
    await expect(page.locator('input[name=q2][value=fifteen]')).not.toBeChecked();
    await expect(panel.getByTestId('response-q2')).toContainText('c. 11');
    expect(model.requests.find((r) => r.includes('fieldKey: q1'))).toContain('b: Displacement');
  });

  test('a model that only states its answer in the reasoning still fills the choice', async ({
    openActivity,
    model,
  }) => {
    model.overrides.push((prompt) =>
      prompt.includes('fieldKey: q1')
        ? {
            answers: [],
            omit: ['q1'],
            perQuestion: [
              { question: '1', explanation: 'Therefore, the answer is: b', confidence: 0.9 },
            ],
            explanation: 'Therefore, the answer is: b',
            steps: [],
            confidence: 0.9,
            calculations: [],
            cannotAnswer: false,
          }
        : undefined,
    );
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=q1][value=b]')).toBeChecked({ timeout: 15000 });
  });

  test('working in an answer is reduced to the final answer', async ({ openActivity, model }) => {
    model.overrides.push((prompt) =>
      prompt.includes('fieldKey: q3')
        ? {
            answers: { q3: ['3^4 = 81, then 81 + 12 = 93'] },
            explanation: 'x',
            steps: [],
            confidence: 0.9,
            calculations: [],
            cannotAnswer: false,
          }
        : undefined,
    );
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=q3]')).toHaveValue('93', { timeout: 15000 });
  });

  test('Fill answers enters answers in one click, and never submits', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);

    await expect(page.locator('input[name=q3]')).toHaveValue('93', { timeout: 15000 });
    await expect(page.locator('input[name=q1][value=b]')).toBeChecked();
    await expect(page.locator('input[name=q2][value=two]')).toBeChecked();
    await expect(page.locator('input[name=q5]')).toHaveValue('2.2');
    await status(panel, 'review');
    // The line aimed at AI tools is gone before solving, so Q4 fills like any other question.
    await expect(page.locator('textarea[name=q4]')).toHaveValue(/Gravity/);
    await expect(panel.getByTestId('held-q4')).toHaveCount(0);
    await expect(panel.getByTestId('injection-q4')).toContainText('banana');
    expect(model.requests.find((r) => r.includes('dropped ball'))).not.toContain('banana');
    expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
  });

  test('Fill answers replaces whatever is in a box, without asking', async ({ openActivity }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await page.locator('input[name=q3]').fill('something else');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=q3]')).toHaveValue('93', { timeout: 15000 });
    await status(panel, 'review');
    await expect(panel.getByText('This field holds')).toHaveCount(0);
  });
});

test.describe('permission prompt', () => {
  test('Cancel fills nothing and asks again next time', async ({ openActivity, model }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await expect(panel.getByTestId('fill-permission')).toHaveCount(0);
    await panel.getByTestId('auto-fill').click();
    await expect(panel.getByTestId('fill-permission')).toContainText('allow AI help');
    await expect(panel.getByTestId('fill-permission')).toContainText('never submits');
    await panel.getByTestId('permission-cancel').click();
    await expect(panel.getByTestId('fill-permission')).toHaveCount(0);
    expect(model.requests).toEqual([]);
    await expect(page.locator('input[name=q3]')).toHaveValue('');
    await panel.getByTestId('auto-fill').click();
    await expect(panel.getByTestId('fill-permission')).toBeVisible();
  });

  test('Explain only never asks, and fills nothing', async ({ openActivity }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    await expect(panel.getByTestId('fill-permission')).toHaveCount(0);
    await expect(page.locator('input[name=q3]')).toHaveValue('');
  });

  test('Yes lasts for every page of the activity, but not for another activity', async ({
    openActivity,
  }) => {
    const { page, panel } = await openActivity('/vhl/activity.html?page=1');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=p1i1]')).toHaveValue('soy', { timeout: 15000 });
    await status(panel, 'review');

    await page.locator('[data-vhl-next]').click();
    await onPage(panel, 2);
    await status(panel, 'ready');
    await panel.getByTestId('auto-fill').click();
    await expect(panel.getByTestId('fill-permission')).toHaveCount(0);
    await expect(page.locator('select[name=m1]')).toHaveValue('apple', { timeout: 15000 });

    // Survives a reload of the panel too.
    await status(panel, 'review');
    await panel.reload();
    await status(panel, 'review');
    await panel.getByTestId('auto-fill').click();
    await expect(panel.getByTestId('fill-permission')).toHaveCount(0);

    const other = await openActivity('/gradescope/assignment.html');
    await status(other.panel, 'ready');
    await other.panel.getByTestId('auto-fill').click();
    await expect(other.panel.getByTestId('fill-permission')).toBeVisible();
  });
});

test.describe('speed and progress', () => {
  test('sends the whole page in one request, then fills every question', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/vhl/live-fill-in.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('#question_103_wol_1')).toHaveValue('vio', { timeout: 15000 });
    await status(panel, 'review');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toContain('Question 3:');
  });

  test('a slow reply still fills after the dropdown closes', async ({ openActivity, model }) => {
    test.setTimeout(120000);
    model.delayMs = 50000;
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('fill-label')).toHaveText('Answering questions…');
    await panel.close();
    await page.bringToFront();
    await expect(page.locator('input[name=q5]')).toHaveValue('2.2', { timeout: 90000 });
    await expect(page.locator('input[name=q3]')).toHaveValue('93');
  });

  test('shows what it is doing while it works', async ({ openActivity, model }) => {
    model.delayMs = 1500;
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.bringToFront();
    await fillFirstTime(panel);
    await expect(panel.getByTestId('fill-label')).toHaveText('Answering questions…');
    await expect(panel.getByTestId('fill-label')).toHaveText(/Entering \d+ of \d+…/, {
      timeout: 15000,
    });
    await expect(panel.getByTestId('fill-label')).toHaveText('Fill answers', { timeout: 15000 });
    await expect(page.locator('input[name=q5]')).toHaveValue('2.2');
  });

  test('the pill shows progress when the dropdown is closed', async ({ openActivity, model }) => {
    model.delayMs = 1500;
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await page.bringToFront();
    await expect(page.getByTestId('sima-floating-status')).toContainText('Answering questions');
    await expect(page.getByTestId('sima-floating-status')).toContainText('5 of 5', {
      timeout: 15000,
    });
  });
});

test.describe('dropdown rows', () => {
  test('rows stay compact, then open to show the answer and explanation', async ({
    openActivity,
  }) => {
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('row-entered-q3')).toBeVisible({ timeout: 15000 });
    await status(panel, 'review');

    await expect(panel.getByTestId('summary-q3')).toHaveText('93');
    await expect(panel.getByTestId('summary-q1')).toHaveText('b');
    await expect(panel.getByTestId('summary-q2')).toHaveText('a, c');
    await expect(panel.getByTestId('summary-q4')).toHaveCount(0);
    await expect(panel.getByTestId('response-q3')).toBeHidden();
    await expect(panel.getByTestId('checks-q3')).toBeHidden();
    await expect(panel.getByTestId('follow-up-q3')).toBeHidden();
    await expect(panel.getByTestId('injection-marker-q4')).toBeVisible();
    await expect(panel.getByTestId('prompt-q3')).not.toContainText('Q3.');
    await expect(panel.getByTestId('prompt-q5')).not.toContainText('[image:');
    await expect(panel.getByTestId('question-q3')).not.toContainText('numeric');

    await panel.getByTestId('row-q3').click();
    await expect(panel.getByTestId('response-q3')).toBeVisible();
    await expect(panel.getByTestId('confidence-q3')).toBeVisible();
    await expect(panel.getByTestId('field-q3')).toContainText('match');
    await expect(panel.getByTestId('checks-q3')).toBeVisible();
    await expect(panel.getByTestId('follow-up-q3')).toBeVisible();
    await panel.getByTestId('row-q4').click();
    await expect(panel.getByTestId('injection-q4')).toContainText('banana');
    await expect(panel.getByTestId('injection-q4')).toBeVisible();

    // State updates shouldn't snap an open row shut.
    await panel.getByTestId('response-q3').fill('edited');
    await panel.getByTestId('response-q3').blur();
    await expect(panel.getByTestId('response-q3')).toHaveValue('edited');
    await expect(panel.getByTestId('checks-q3')).toBeVisible();
    await panel.getByTestId('row-q3').click();
    await expect(panel.getByTestId('response-q3')).toBeHidden();
  });

  test('a question needing attention opens itself', async ({ openActivity, model }) => {
    model.overrides.push((prompt) =>
      prompt.includes('fieldKey: q3') ? { nope: true } : undefined,
    );
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('row-attention-q3')).toBeVisible({ timeout: 15000 });
    await expect(panel.getByTestId('solve-error-q3')).toBeVisible();
  });

  test('filling keeps going after the dropdown closes', async ({ context, openActivity }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('auto-fill')).toBeDisabled();
    await panel.close();
    await expect(page.locator('input[name=q5]')).toHaveValue('2.2', { timeout: 20000 });
    await expect(page.locator('input[name=q3]')).toHaveValue('93');
    await expect(page.getByTestId('sima-floating-status')).toContainText('5 of 5');
    void context;
  });

  test('fits a toolbar dropdown, and scrolls inside it', async ({ openActivity }) => {
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    for (const id of ['q1', 'q2', 'q3', 'q4', 'q5']) await openRow(panel, id);
    const box = await panel.locator('#root > div').boundingBox();
    expect(box?.width).toBe(380);
    expect(box?.height).toBeLessThanOrEqual(600);
    await expect(panel.getByTestId('task-status')).toBeInViewport();
  });

  test('the header shows only the title and progress', async ({ openActivity }) => {
    const { panel } = await openActivity('/webassign/assignment.html?q=1');
    await status(panel, 'ready');
    const logo = panel.getByTestId('sima-logo');
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(panel.getByTestId('activity-title')).toHaveText('Ch. 2 Homework');
    await expect(panel.getByTestId('progress-text')).toContainText('0 of 1');
    await expect(panel.getByTestId('task-status')).not.toContainText('WebAssign');
    await expect(panel.getByTestId('task-status')).not.toContainText('Page 1');
    await expect(panel.getByText('Enter answers with appropriate units')).toHaveCount(0);
  });
});

test.describe('VHL mock', () => {
  test('follows the page through a client-rendered activity and keeps accents', async ({
    openActivity,
  }) => {
    const { page, panel } = await openActivity('/vhl/activity.html?page=1');
    await status(panel, 'ready');
    await expect(panel.getByTestId('activity-title')).toHaveText('Lección 3: Completar');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=p1i2]')).toHaveValue('vivió', { timeout: 15000 });
    await status(panel, 'review');

    // The student moves on with the page's own button, and Sima follows.
    await page.locator('[data-vhl-next]').click();
    await onPage(panel, 2);
    await status(panel, 'ready');
    await panel.getByTestId('auto-fill').click();
    await expect(page.locator('select[name=m1]')).toHaveValue('apple', { timeout: 15000 });
    await expect(page.locator('select[name=m2]')).toHaveValue('book');
    await expect(page.locator('select[name=art]')).toHaveValue('la');
    await status(panel, 'review');

    await page.locator('[data-vhl-next]').click();
    await onPage(panel, 3);
    await status(panel, 'ready');
  });
});

test.describe('VHL live layout', () => {
  test('fills blanks with accents and leaves everything else alone', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/vhl/live-fill-in.html');
    await status(panel, 'ready');
    await expect(panel.locator('[data-testid^="question-"]')).toHaveCount(3);
    await expect(panel.getByTestId('prompt-q-question_101')).toContainText(
      'Nosotros ____ en la biblioteca',
    );
    await fillFirstTime(panel);
    await expect(page.locator('#question_103_wol_0')).toHaveValue('leí', { timeout: 15000 });
    await expect(page.locator('#question_103_wol_1')).toHaveValue('vio');
    await expect(page.locator('#question_101_wol_0')).toHaveValue('estudiamos');
    await status(panel, 'review');
    expect(model.requests[0]).toContain('[question_101_wol_0]');
    await expect(page.locator('#new-chat-message-1')).toHaveValue('');
    await expect(page.locator('input[name=speed]')).not.toBeChecked();
    const body = await page.evaluate(() => ({ ...document.body.dataset }));
    expect(body.submitted).toBeUndefined();
    expect(body.saved).toBeUndefined();
  });

  test('chooses from custom dropdowns, updating what the page shows', async ({ openActivity }) => {
    const { page, panel } = await openActivity('/vhl/live-dropdown.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('#question_203_1')).toHaveValue('hace', { timeout: 15000 });
    await expect(page.locator('#question_201_0')).toHaveValue('es');
    await expect(page.locator('#question_202_0')).toHaveValue('son');
    await expect(page.locator('#question_202_0_dd_btn')).toContainText('son');
    await status(panel, 'review');
    await expect(panel.getByTestId('row-entered-q-question_201')).toBeVisible();
    await expect(panel.getByText('This field holds')).toHaveCount(0);
    expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
  });

  test('solves a matching set in one request, with each item filled', async ({
    openActivity,
    model,
  }) => {
    const reply = {
      steps: ['Item 1: first', 'Item 2: second'],
      calculations: [],
      answers: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `question_${501 + i}_0`,
          [String.fromCharCode(97 + i)],
        ]),
      ),
      explanation: 'x',
      confidence: 0.9,
      cannotAnswer: false,
    };
    model.overrides.push(() => reply);
    const { page, panel } = await openActivity('/vhl/live-matching.html');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('row-entered-q-question_509')).toBeVisible({ timeout: 15000 });
    await status(panel, 'review');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toContain('Question 9:');
    expect(model.requests[0]?.match(/Choices for questions/g)).toHaveLength(1);
    const values = await page
      .locator('select')
      .evaluateAll((all) => all.map((s) => (s as HTMLSelectElement).value));
    expect(new Set(values).size).toBe(9);
    expect(values).not.toContain('0');
  });

  test('sends the Modelo and word list to the model', async ({ openActivity, model }) => {
    const { panel } = await openActivity('/vhl/live-wordbank.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    expect(model.requests[0]).toContain('Word list: acostarse');
    expect(model.requests[0]).toContain('«se saludan»');
  });

  for (const path of ['/vhl/live-timed.html', '/vhl/live-prueba.html']) {
    test(`stays off on ${path}`, async ({ openActivity, model }) => {
      const { panel } = await openActivity(path);
      await status(panel, 'blocked_restricted');
      expect(model.requests).toEqual([]);
    });
  }
});

test.describe('WebAssign mock', () => {
  test('handles units, a controlled input, full page loads and unlabeled blanks', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/webassign/assignment.html?q=1');
    await status(panel, 'ready');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=speed]')).toHaveValue('12.5', { timeout: 15000 });
    await expect(page.locator('select[name=speed_unit]')).toHaveValue('m/s');
    await status(panel, 'review');

    await page.locator('[data-wa-next]').click();
    await onPage(panel, 2);
    await status(panel, 'ready');
    await panel.getByTestId('auto-fill').click();
    await expect(panel.getByTestId('field-state-ke')).toContainText('Entered', { timeout: 15000 });
    // The mock's controlled input wipes values not set through real input events.
    await page.waitForTimeout(200);
    await expect(page.locator('input[name=ke]')).toHaveValue('9');
    await status(panel, 'review');

    await page.locator('[data-wa-next]').click();
    await onPage(panel, 3);
    await status(panel, 'ready');
    await panel.getByTestId('auto-fill').click();

    // Unlabeled blanks fill without asking, with their place marked for the model.
    await expect(page.locator('input[name=blank_a]')).toHaveValue('2', { timeout: 15000 });
    await expect(page.locator('input[name=blank_b]')).toHaveValue('3');
    await expect(panel.getByTestId('confirm-blank_a')).toHaveCount(0);
    expect(model.requests.at(-1)).toContain('[blank_a] and [blank_b]');
    expect(await page.evaluate(() => document.body.dataset.submitted)).toBeUndefined();
  });
});

test.describe('persistence and recovery', () => {
  test('work survives a page reload', async ({ openActivity }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');
    await openRow(panel, 'q3');
    await panel.getByTestId('response-q3').fill('edited');
    await panel.getByTestId('response-q3').blur();
    await expect(panel.getByTestId('response-q3')).toHaveValue('edited');
    await page.reload();
    await status(panel, 'review');
    await panel.reload();
    await expect(panel.getByTestId('response-q3')).toHaveValue('edited');
    await expect(panel.getByTestId('explanation-q1')).toContainText('Worked');
  });

  test('work survives the service worker being killed', async ({
    context,
    openActivity,
    extensionId,
  }) => {
    const { panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.getByTestId('solve-all').click();
    await status(panel, 'review');

    const cdp = await context
      .browser()
      ?.newBrowserCDPSession()
      .catch(() => null);
    const browserCdp = cdp ?? (await context.newCDPSession(panel));
    const { targetInfos } = await browserCdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    expect(sw).toBeTruthy();
    await browserCdp.send('Target.closeTarget', { targetId: sw!.targetId });
    await panel.waitForTimeout(500);

    await panel.reload();
    await status(panel, 'review');
    await expect(panel.getByTestId('explanation-q1')).toContainText('Worked');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('row-entered-q1')).toBeVisible({ timeout: 15000 });
  });

  test('Fill answers picks a stopped task back up', async ({ openActivity }) => {
    const { page, panel, tabId } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await panel.evaluate(async (id) => {
      const view = await chrome.runtime.sendMessage({ type: 'GET_VIEW', tabId: id });
      await chrome.runtime.sendMessage({ type: 'STOP', taskId: view.data.task.id });
    }, tabId);
    await panel.reload();
    await status(panel, 'stopped');
    await fillFirstTime(panel);
    await expect(page.locator('input[name=q3]')).toHaveValue('93', { timeout: 15000 });
    await status(panel, 'review');
  });

  test('deleting data removes saved work', async ({ context, extensionId, openActivity }) => {
    const { panel, tabId } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByTestId('delete-tasks').click();
    await expect(options.getByTestId('settings-message')).toContainText('Deleted');
    const reply = await options.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'GET_VIEW', tabId: id }),
      tabId,
    );
    expect(reply.data.task).toBeNull();
  });
});

test('a tab that leaves its activity stops showing that task', async ({ openActivity }) => {
  const { page, panel } = await openActivity('/gradescope/assignment.html');
  await status(panel, 'ready');
  await page.goto(`${MOCK}/index.html`);
  await panel.reload();
  await expect(panel.getByTestId('empty-state')).toBeVisible();
});

test('turning a platform off stops Sima acting on it', async ({
  context,
  extensionId,
  openActivity,
  model,
}) => {
  const { page, panel } = await openActivity('/gradescope/assignment.html');
  await status(panel, 'ready');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByTestId('platform-gradescope').click();
  await expect(options.getByTestId('platform-gradescope')).toHaveAttribute(
    'data-state',
    'unchecked',
  );
  await panel.getByTestId('solve-all').click();
  await expect(panel.getByTestId('panel-error')).toContainText('turned off');
  expect(model.requests).toEqual([]);
  void page;
});

test.describe('birth date and default provider', () => {
  async function freshPanel(context: BrowserContext, extensionId: string, worker: Worker) {
    const page = await context.newPage();
    await page.goto(`${MOCK}/vhl/activity.html?page=1`);
    const tabId = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab?.id as number;
    }, page.url());
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    return panel;
  }

  test('a new user sees only the birth date step, and nothing can run before it', async ({
    context,
    extensionId,
    worker,
    model,
  }) => {
    const panel = await freshPanel(context, extensionId, worker);
    await expect(panel.getByTestId('onboarding')).toContainText('Welcome to Sima');
    await expect(panel.getByTestId('age-gate')).toBeVisible();
    await expect(panel.getByTestId('solve-all')).toHaveCount(0);
    await expect(panel.getByTestId('activity-title')).toHaveCount(0);
    await expect(panel.getByTestId('open-settings-gear')).toHaveCount(0);

    // The background refuses too, without going through the panel.
    const page = context.pages().find((open) => open.url().includes('/vhl/activity.html'));
    const reply = await panel.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.runtime.sendMessage({ type: 'ANALYZE', tabId: tab?.id });
      const view = await chrome.runtime.sendMessage({ type: 'GET_VIEW', tabId: tab?.id });
      return chrome.runtime.sendMessage({ type: 'SOLVE', taskId: view.data.task.id });
    }, page?.url() ?? '');
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('birth date');
    expect(model.requests).toEqual([]);

    // Answering it goes straight into Sima, on the same activity.
    await panel.getByTestId('birth-date').fill(MINOR_BIRTH_DATE);
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('onboarding-step')).toContainText('Step 2 of 2');
    await expect(panel.getByTestId('model-missing')).toContainText('local AI');
    await expect(panel.getByTestId('solve-all')).toHaveCount(0);

    // Finishing setup, which happens in another tab, goes straight into Sima on this activity.
    await panel.evaluate(async () => {
      const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { ...data.settings, models: { ...data.settings.models, ollama: 'fake-model' } },
      });
    });
    await expect(panel.getByTestId('onboarding')).toHaveCount(0);
    await expect(panel.getByTestId('activity-title')).toBeVisible();
    await expect(panel.getByTestId('solve-all')).toBeVisible();
  });

  test('the birth date step comes first on a site Sima does not support', async ({
    context,
    extensionId,
    worker,
  }) => {
    const page = await context.newPage();
    await page.goto(`${MOCK}/`);
    const tabId = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab?.id as number;
    }, page.url());
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    await expect(panel.getByTestId('age-gate')).toBeVisible();
    await expect(panel.getByTestId('empty-state')).toHaveCount(0);

    await panel.getByTestId('birth-date').fill(ADULT_BIRTH_DATE);
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('model-missing')).toContainText('Turn on free AI');
    await expect(panel.getByTestId('empty-state')).toHaveCount(0);
    await panel.reload();
    await expect(panel.getByTestId('model-missing')).toBeVisible();
    await expect(panel.getByTestId('age-gate')).toHaveCount(0);

    await panel.evaluate(async () => {
      const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { ...data.settings, models: { ...data.settings.models, gemini: 'g' } },
      });
    });
    await expect(panel.getByTestId('empty-state')).toContainText('No supported activity');
  });

  test('18 or older gets Gemini by default, with the setup and terms shown', async ({
    context,
    extensionId,
    worker,
  }) => {
    const panel = await freshPanel(context, extensionId, worker);
    await panel.getByTestId('birth-date').fill(ADULT_BIRTH_DATE);
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('model-missing')).toContainText('Turn on free AI');

    const opened = context.waitForEvent('page');
    await panel.getByTestId('open-settings').click();
    const settings = await opened;
    await settings.waitForLoadState();
    await expect(settings.getByTestId('provider-select')).toContainText('Google Gemini');
    await expect(settings.getByTestId('gemini-setup')).toContainText('18 or older');
    await expect(settings.getByTestId('gemini-setup')).toContainText('EEA, Switzerland or the UK');
    await expect(settings.getByTestId('privacy-summary')).toContainText('EEA, Switzerland');

    // Adults can still choose the local model.
    await settings.getByTestId('provider-select').click();
    await settings.getByRole('option', { name: 'Ollama (local)' }).click();
    await expect(settings.getByTestId('local-setup')).toBeVisible();
  });

  test('under 18 gets Ollama, and online providers stay refused', async ({
    context,
    extensionId,
    worker,
  }) => {
    const panel = await freshPanel(context, extensionId, worker);
    await panel.getByTestId('birth-date').fill(MINOR_BIRTH_DATE);
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('model-missing')).toContainText('local AI');

    const opened = context.waitForEvent('page');
    await panel.getByTestId('open-settings').click();
    const settings = await opened;
    await settings.waitForLoadState();
    await expect(settings.getByTestId('minor-note')).toBeVisible();
    await settings.getByTestId('provider-select').click();
    await expect(settings.getByRole('option', { name: 'Google Gemini' })).toHaveCount(0);
    await settings.keyboard.press('Escape');

    // Going around the UI is refused too, and the answer can't be changed.
    const replies = await settings.evaluate(async (adultDate) => {
      const send = (message: unknown) => chrome.runtime.sendMessage(message);
      const current = await send({ type: 'GET_SETTINGS' });
      return {
        retry: await send({ type: 'SET_BIRTH_DATE', birthDate: adultDate }),
        forced: await send({
          type: 'SAVE_SETTINGS',
          settings: { ...current.data.settings, activeProvider: 'gemini', ageCheck: 'adult' },
        }),
        key: await send({ type: 'SET_API_KEY', provider: 'gemini', apiKey: 'k' }),
        test: await send({ type: 'TEST_PROVIDER', provider: 'gemini' }),
        after: await send({ type: 'GET_SETTINGS' }),
      };
    }, ADULT_BIRTH_DATE);
    expect(replies.retry.ok).toBe(false);
    expect(replies.forced.ok).toBe(false);
    expect(replies.key.ok).toBe(false);
    expect(replies.test.ok).toBe(false);
    expect(replies.after.data.settings).toMatchObject({
      ageCheck: 'minor',
      activeProvider: 'ollama',
    });
  });

  test('never stores the birth date, and rejects dates that are not real', async ({
    context,
    extensionId,
    worker,
  }) => {
    const panel = await freshPanel(context, extensionId, worker);
    await panel.getByTestId('birth-date').fill('2999-01-01');
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('age-gate-error')).toContainText('real birth date');
    await panel.getByTestId('birth-date').fill(ADULT_BIRTH_DATE);
    await panel.getByTestId('birth-date-submit').click();
    await expect(panel.getByTestId('age-gate')).toHaveCount(0);
    const stored = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(JSON.stringify(stored)).not.toContain(ADULT_BIRTH_DATE);
    expect(JSON.stringify(stored)).toContain('"ageCheck":"adult"');
  });

  test('the Gemini notice states the age and Europe rules before anything is sent', async ({
    context,
    extensionId,
    worker,
  }) => {
    const panel = await freshPanel(context, extensionId, worker);
    await setBirthDate(panel, ADULT_BIRTH_DATE);
    await panel.evaluate(async () => {
      const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const { settings } = current.data;
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { ...settings, models: { ...settings.models, gemini: 'some-model' } },
      });
    });
    await panel.reload();
    await expect(panel.getByTestId('gemini-terms')).toContainText('18 or older');
    await expect(panel.getByTestId('gemini-terms')).toContainText('EEA, Switzerland or the UK');
    await expect(panel.getByTestId('provider-disclosure')).toContainText('human');
  });
});

test.describe('Gemini setup', () => {
  const GOOD_KEY = 'test-key-AbCdEfGhIjKlMnOpQrSt';
  const NO_REGION_KEY = 'test-key-UnsupportedLocation-000';

  /** Stands in for Google, in the worker, so the extension's whole request path still runs. */
  async function fakeGoogle(worker: Worker) {
    await worker.evaluate(
      ([goodKey, noRegionKey]) => {
        const target = globalThis as unknown as { sentKeys: string[] };
        target.sentKeys = [];
        globalThis.fetch = (async (_url: string, init: RequestInit) => {
          const key = (init.headers as Record<string, string>)['x-goog-api-key'] ?? '';
          target.sentKeys.push(key);
          if (key === noRegionKey) {
            return new Response('{"error":{"message":"User location is not supported"}}', {
              status: 400,
            });
          }
          if (key !== goodKey) {
            return new Response('{"error":{"message":"API key not valid"}}', { status: 400 });
          }
          return new Response(
            JSON.stringify({
              models: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-tts'].map(
                (id) => ({
                  name: `models/${id}`,
                  supportedGenerationMethods: ['generateContent'],
                }),
              ),
            }),
          );
        }) as unknown as typeof fetch;
      },
      [GOOD_KEY, NO_REGION_KEY],
    );
  }

  async function freshSettings(context: BrowserContext, extensionId: string, worker: Worker) {
    await fakeGoogle(worker);
    await context.route('https://aistudio.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>AI Studio stand-in</h1>' }),
    );
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    await setBirthDate(settings, ADULT_BIRTH_DATE);
    await settings.reload();
    return settings;
  }

  const paste = (page: Page, text: string) =>
    page.getByTestId('gemini-key').evaluate((input, value) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text', value);
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    }, text);

  const storedKey = async (worker: Worker) =>
    (await worker.evaluate(() => chrome.storage.local.get('apiKey:gemini')))['apiKey:gemini'];

  test('one click opens Google, and pasting finishes setup with no other steps', async ({
    context,
    extensionId,
    worker,
  }) => {
    const settings = await freshSettings(context, extensionId, worker);
    const agreement = settings.getByTestId('gemini-agreement');
    await expect(agreement).toContainText('18 or older');
    await expect(agreement).toContainText('EEA, Switzerland');
    await expect(agreement).toContainText('human reviewers');
    await expect(settings.getByTestId('test-connection')).toHaveCount(0);

    const opened = context.waitForEvent('page');
    await settings.getByTestId('gemini-agree').click();
    const google = await opened;
    await google.waitForLoadState();
    expect(google.url()).toContain('aistudio.google.com/apikey');
    await settings.bringToFront();

    await expect(settings.getByTestId('gemini-steps')).toContainText('Create project');
    await expect(settings.getByTestId('gemini-key')).toBeFocused();
    await paste(settings, `  ${GOOD_KEY}\n`);
    await expect(settings.getByTestId('gemini-ready')).toContainText("You're all set");

    const state = await settings.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }),
    );
    expect(JSON.stringify(state)).toContain('"gemini":"gemini-3.8-flash"');
    expect(JSON.stringify(state)).toContain('"acknowledgedProviders":["gemini"]');
    expect(JSON.stringify(state)).not.toContain(GOOD_KEY);
    expect(await storedKey(worker)).toBe(GOOD_KEY);

    // Google's API needs no extra Chrome prompt.
    const granted = await worker.evaluate(() =>
      chrome.permissions.contains({ origins: ['https://generativelanguage.googleapis.com/*'] }),
    );
    expect(granted).toBe(true);
  });

  test('a wrong key is explained simply, and not kept', async ({
    context,
    extensionId,
    worker,
  }) => {
    const settings = await freshSettings(context, extensionId, worker);
    await settings.getByTestId('gemini-agree').click();
    await settings.bringToFront();
    await paste(settings, 'wrong-key-wrong-key-wrong-key');
    const error = settings.getByTestId('gemini-setup-error');
    await expect(error).toContainText("That key didn't work");
    await expect(error).not.toContainText('400');
    expect(await storedKey(worker)).toBeUndefined();

    await paste(settings, GOOD_KEY);
    await expect(settings.getByTestId('gemini-ready')).toBeVisible();
  });

  test('a region Google refuses points to the local option', async ({
    context,
    extensionId,
    worker,
  }) => {
    const settings = await freshSettings(context, extensionId, worker);
    await settings.getByTestId('gemini-agree').click();
    await settings.bringToFront();
    await paste(settings, NO_REGION_KEY);
    await expect(settings.getByTestId('gemini-setup-error')).toContainText('local model');
    expect(await storedKey(worker)).toBeUndefined();
  });

  test('something that is not a key never leaves the page', async ({
    context,
    extensionId,
    worker,
  }) => {
    const settings = await freshSettings(context, extensionId, worker);
    await settings.getByTestId('gemini-agree').click();
    await settings.bringToFront();
    await paste(settings, 'my grocery list and other private text');
    await expect(settings.getByTestId('gemini-setup-error')).toContainText(
      "doesn't look like a key",
    );
    const sent = await worker.evaluate(
      () => (globalThis as unknown as { sentKeys: string[] }).sentKeys,
    );
    expect(sent).toEqual([]);
    await expect(settings.getByTestId('gemini-key')).toHaveValue('');
  });

  test('typing a key and pressing Enter also works', async ({ context, extensionId, worker }) => {
    const settings = await freshSettings(context, extensionId, worker);
    await settings.getByTestId('gemini-agree').click();
    await settings.bringToFront();
    await settings.getByTestId('gemini-key').fill(GOOD_KEY);
    await settings.getByTestId('gemini-key').press('Enter');
    await expect(settings.getByTestId('gemini-ready')).toBeVisible();
  });

  test('setup offers the local model instead', async ({ context, extensionId, worker }) => {
    const settings = await freshSettings(context, extensionId, worker);
    await settings.getByTestId('gemini-use-local').click();
    await expect(settings.getByTestId('local-setup')).toBeVisible();
    await expect(settings.getByTestId('gemini-setup')).toHaveCount(0);
  });
});

test.describe('local AI setup', () => {
  async function under18Settings(
    context: BrowserContext,
    extensionId: string,
    baseUrl = `http://127.0.0.1:${OLLAMA_PORT}`,
  ) {
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    await setBirthDate(settings, MINOR_BIRTH_DATE);
    await settings.evaluate(async (url) => {
      const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { ...data.settings, ollamaBaseUrl: url },
      });
    }, baseUrl);
    await settings.reload();
    return settings;
  }

  const savedModel = async (settings: Page) =>
    settings.evaluate(async () => {
      const { data } = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return data.settings.models.ollama as string;
    });

  test('under 18 is led to Ollama, then Sima downloads the model', async ({
    context,
    extensionId,
    model,
  }) => {
    model.installed = [];
    await context.route('https://ollama.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Ollama stand-in</h1>' }),
    );
    const settings = await under18Settings(context, extensionId);
    await expect(settings.getByTestId('model')).toHaveCount(0);

    const opened = context.waitForEvent('page');
    await settings.getByTestId('ollama-download').click();
    expect((await opened).url()).toContain('ollama.com/download');
    await settings.bringToFront();

    await settings.getByTestId('ollama-ready').click();
    await expect(settings.getByTestId('local-model-step')).toContainText('5 GB');
    await settings.getByTestId('ollama-pull').click();
    await expect(settings.getByTestId('local-ready')).toContainText("You're all set");
    expect(model.pulled).toEqual(['qwen2.5:7b']);
    expect(await savedModel(settings)).toBe('qwen2.5:7b');
  });

  test('a model already in Ollama is used without another download', async ({
    context,
    extensionId,
    model,
  }) => {
    const settings = await under18Settings(context, extensionId);
    await settings.getByTestId('ollama-ready').click();
    await expect(settings.getByTestId('local-ready')).toBeVisible();
    expect(model.pulled).toEqual([]);
    expect(await savedModel(settings)).toBe('fake-model');
  });

  test('when Ollama is not open, it says so and can try again', async ({
    context,
    extensionId,
    model,
  }) => {
    void model;
    const settings = await under18Settings(context, extensionId, 'http://127.0.0.1:11498');
    await settings.getByTestId('ollama-ready').click();
    const error = settings.getByTestId('local-setup-error');
    await expect(error).toContainText("can't find Ollama");
    await expect(error).not.toContainText('reach provider');
    await expect(settings.getByTestId('ollama-ready')).toBeEnabled();
    expect(await savedModel(settings)).toBe('');
  });

  test('entering the address and model by hand stays possible', async ({
    context,
    extensionId,
    model,
  }) => {
    void model;
    const settings = await under18Settings(context, extensionId);
    await settings.getByTestId('local-manual').click();
    await expect(settings.getByTestId('ollama-url')).toBeVisible();
    await settings.getByTestId('model').fill('fake-model');
    await expect(settings.getByTestId('local-setup')).toHaveCount(0);
  });
});

test.describe('page layout capture', () => {
  test('saves a layout with no secrets from a page Sima cannot read', async ({
    openActivity,
    model,
  }) => {
    const { page, panel } = await openActivity('/gradescope/unrecognized.html');
    await expect(panel.getByTestId('capture-layout')).toBeVisible({ timeout: 15000 });
    await expect(panel.getByText("Sima can't read this page yet")).toBeVisible();
    await expect(page.getByTestId('sima-floating')).toHaveCount(0);

    const downloaded = panel.waitForEvent('download');
    await panel.getByTestId('capture-page').click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(/^sima-page-gradescope-\d{4}-\d{2}-\d{2}\.json$/);
    const saved = readFileSync(await download.path(), 'utf8');
    expect(saved).not.toMatch(/SECRET|jane|doe/i);
    const capture = JSON.parse(saved);
    expect(capture.format).toBe('sima-page-capture-1');
    expect(capture.recognizedBySima).toBe(false);
    expect(capture.counts['input:text']).toBeGreaterThan(0);
    expect(capture.counts['shadow-root']).toBe(1);
    expect(saved).not.toContain('sima-assistant');
    expect(capture.counts['iframe:same-origin']).toBe(1);
    expect(capture.counts['iframe:cross-origin']).toBe(1);
    await expect(panel.getByTestId('capture-message')).toContainText('Downloads');
    expect(model.requests).toEqual([]);
  });

  test('refuses a page that looks like an exam', async ({ openActivity }) => {
    const { panel } = await openActivity('/gradescope/unrecognized-exam.html');
    await expect(panel.getByTestId('capture-layout')).toBeVisible({ timeout: 15000 });
    await panel.getByTestId('capture-page').click();
    await expect(panel.getByTestId('capture-message')).toContainText('looks like an exam');
  });

  test('is not offered on working or restricted activities', async ({ openActivity }) => {
    const working = await openActivity('/gradescope/assignment.html');
    await status(working.panel, 'ready');
    await expect(working.panel.getByTestId('capture-layout')).toHaveCount(0);
    const exam = await openActivity('/gradescope/exam.html');
    await status(exam.panel, 'blocked_restricted');
    await expect(exam.panel.getByTestId('capture-layout')).toHaveCount(0);
  });

  test('content scripts cannot ask for a capture', async ({ context, openActivity }) => {
    const { page, tabId } = await openActivity('/gradescope/assignment.html');
    const cdp = await context.newCDPSession(page);
    const contexts: Array<{ id: number; origin: string; auxData?: { type?: string } }> = [];
    cdp.on('Runtime.executionContextCreated', (e) =>
      contexts.push(e.context as (typeof contexts)[number]),
    );
    await cdp.send('Runtime.enable');
    const isolated = contexts.find(
      (c) => c.auxData?.type === 'isolated' && c.origin.startsWith('chrome-extension'),
    );
    const reply = await cdp.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE', tabId: ${tabId} }).then(r => JSON.stringify(r), e => 'denied')`,
      contextId: isolated!.id,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(String(reply.result.value)).not.toContain('sima-page-capture');
  });
});

test('non-supported pages get nothing from Sima', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${MOCK}/index.html`);
  await page.waitForTimeout(600);
  await expect(page.locator('sima-assistant')).toHaveCount(0);
  void extensionId;
});
