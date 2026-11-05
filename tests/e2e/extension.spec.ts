import { expect, fillFirstTime, MOCK, onPage, openRow, status, test } from './fixtures';

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
    await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'SET_API_KEY',
        provider: 'openai',
        apiKey: 'sk-e2e-secret',
      }),
    );
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
    await options.getByTestId('ollama-url').fill('https://attacker.example');
    await expect(options.getByTestId('settings-message')).toBeVisible();
    await options.reload();
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

  test('does not replace an answer the student already typed without permission', async ({
    openActivity,
  }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await page.locator('input[name=q3]').fill('my own answer');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('overwrite-q3')).toBeVisible({ timeout: 15000 });
    await status(panel, 'review');
    await expect(page.locator('input[name=q3]')).toHaveValue('my own answer');
    await panel.getByTestId('overwrite-q3').getByRole('button').click();
    await panel.getByTestId('auto-fill').click();
    await expect(page.locator('input[name=q3]')).toHaveValue('93', { timeout: 15000 });
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

  test('a question needing attention opens itself', async ({ openActivity }) => {
    const { page, panel } = await openActivity('/gradescope/assignment.html');
    await status(panel, 'ready');
    await page.locator('input[name=q3]').fill('my own answer');
    await fillFirstTime(panel);
    await expect(panel.getByTestId('row-attention-q3')).toBeVisible({ timeout: 15000 });
    await expect(panel.getByTestId('overwrite-q3')).toBeVisible();
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

test('the panel leads a new user to settings, and updates once a model is set', async ({
  context,
  extensionId,
  worker,
}) => {
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.options_ui?.open_in_tab).toBe(true);

  const page = await context.newPage();
  await page.goto(`${MOCK}/vhl/activity.html?page=1`);
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id as number;
  }, page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await expect(panel.getByTestId('model-missing')).toBeVisible();

  // Settings open in their own tab, since a permission prompt would close the dropdown.
  const opened = context.waitForEvent('page');
  await panel.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.waitForLoadState();
  expect(settings.url()).toContain('options.html');
  await settings.getByTestId('model').fill('fake-model');
  await expect(panel.getByTestId('model-missing')).toHaveCount(0);

  // The gear reaches them too, including with no supported activity on the tab.
  const empty = await context.newPage();
  await empty.goto(`chrome-extension://${extensionId}/popup.html?tabId=999999`);
  await expect(empty.getByTestId('empty-state')).toBeVisible();
  const again = context.waitForEvent('page');
  await empty.getByTestId('open-settings-gear').click();
  const second = await again;
  await second.waitForLoadState();
  await expect(second.getByTestId('model')).toHaveValue('fake-model');
});

test('non-supported pages get nothing from Sima', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${MOCK}/index.html`);
  await page.waitForTimeout(600);
  await expect(page.locator('sima-assistant')).toHaveCount(0);
  void extensionId;
});
