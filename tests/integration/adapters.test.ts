import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzePage, findAdapter } from '@sima/adapter-core';
import { gradescopeAdapter } from '@sima/adapter-gradescope';
import { vhlAdapter } from '@sima/adapter-vhl';
import { webassignAdapter } from '@sima/adapter-webassign';
import { checkAction, executeAction } from '@sima/browser-executor';
import { buildNavigateAction } from '@sima/action-planner';
import type { BrowserAction } from '@sima/shared-types';
import { startPlayground } from '../../playground/server.mjs';
import { loadMock } from '../helpers';

const PORT = 5199;
const base = `http://127.0.0.1:${PORT}`;
let server: Pick<Server, 'close'>;

beforeAll(async () => {
  server = await startPlayground(PORT);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const adapters = [gradescopeAdapter, vhlAdapter, webassignAdapter];

async function analyze(path: string) {
  const url = new URL(base + path);
  const adapter = findAdapter(adapters, url);
  if (!adapter) throw new Error('No adapter');
  const dom = await loadMock(url.href, adapter);
  return {
    dom,
    doc: dom.window.document,
    adapter,
    analysis: analyzePage(adapter, dom.window.document, url)!,
  };
}

describe('adapter selection', () => {
  it('matches real hostnames and mock paths, and nothing else', () => {
    expect(findAdapter(adapters, new URL('https://www.gradescope.com/courses/1'))?.id).toBe(
      'gradescope',
    );
    expect(findAdapter(adapters, new URL('https://www.vhlcentral.com/x'))?.id).toBe('vhl');
    expect(findAdapter(adapters, new URL('https://www.webassign.net/web/x'))?.id).toBe('webassign');
    expect(findAdapter(adapters, new URL('https://example.com/gradescope/'))).toBeNull();
    expect(findAdapter(adapters, new URL('https://notgradescope.com/'))).toBeNull();
    expect(findAdapter(adapters, new URL('http://localhost:3000/gradescope/a'))).toBeNull();
  });
});

describe('Gradescope mock', () => {
  it('extracts every question format, including late-rendered content', async () => {
    const { analysis } = await analyze('/gradescope/assignment.html');
    expect(analysis.restriction.status).toBe('none_detected');
    expect(analysis.questions.map((q) => q.format)).toEqual([
      'multiple_choice',
      'multi_select',
      'numeric',
      'written',
      'numeric',
    ]);
    const [q1, , q3, , q5] = analysis.questions;
    expect(q1?.fields[0]?.options.map((o) => o.label)).toEqual(['Speed', 'Displacement', 'Mass']);
    expect(q3?.prompt).toContain('3^(4) + 12');
    expect(q5?.tables[0]?.[1]).toEqual(['1', '2.0']);
    expect(q5?.images[0]?.alt).toBe('Stopwatch next to a ramp');
  });

  it('keeps hidden injection text out of the prompt and flags the visible attempt', async () => {
    const { analysis } = await analyze('/gradescope/assignment.html');
    const q4 = analysis.questions[3]!;
    expect(q4.prompt).not.toMatch(/API key/);
    expect(q4.prompt).not.toMatch(/submit button/);
    expect(q4.suspiciousText.join(' ')).toMatch(/banana/);
  });

  it('never offers a submit control as navigation', async () => {
    const { analysis } = await analyze('/gradescope/assignment.html');
    expect(analysis.next).toBeNull();
  });
});

describe('restricted pages', () => {
  it.each(['/gradescope/exam.html', '/vhl/test.html', '/webassign/test.html'])(
    '%s yields no questions',
    async (path) => {
      const { analysis } = await analyze(path);
      expect(analysis.restriction.status).toBe('restricted');
      expect(analysis.restriction.signals.length).toBeGreaterThan(0);
      expect(analysis.questions).toEqual([]);
      expect(analysis.next).toBeNull();
    },
  );
});

describe('VHL mock', () => {
  it('waits for client rendering and keeps accented text', async () => {
    const { analysis } = await analyze('/vhl/activity.html?page=1');
    expect(analysis.activity.title).toBe('Lección 3: Completar');
    expect(analysis.pagination).toEqual({ index: 1, total: 3 });
    expect(analysis.questions[1]?.prompt).toContain('Bogotá');
    expect(analysis.next?.label).toBe('Siguiente');
  });

  it('recognizes matching and dropdown questions', async () => {
    const { analysis } = await analyze('/vhl/activity.html?page=2');
    expect(analysis.questions.map((q) => q.format)).toEqual(['matching', 'dropdown']);
    expect(analysis.questions[0]?.fields[0]?.options.map((o) => o.id)).toEqual([
      'apple',
      'book',
      'house',
    ]);
  });

  it('has no next control on the last page, where only submit remains', async () => {
    const { analysis } = await analyze('/vhl/activity.html?page=3');
    expect(analysis.next).toBeNull();
  });
});

describe('WebAssign mock', () => {
  it('maps a value and its separate units dropdown', async () => {
    const { analysis } = await analyze('/webassign/assignment.html?q=1');
    const fields = analysis.questions[0]!.fields;
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['speed', 'text'],
      ['speed_unit', 'select'],
    ]);
    expect(fields.every((f) => f.mappingConfidence >= 0.8)).toBe(true);
  });

  it('marks unlabeled sibling blanks as ambiguous', async () => {
    const { analysis } = await analyze('/webassign/assignment.html?q=3');
    const fields = analysis.questions[0]!.fields;
    expect(fields).toHaveLength(2);
    expect(fields.every((f) => f.mappingConfidence < 0.8)).toBe(true);
  });

  it('does not offer Submit Assignment as a next control on the last page', async () => {
    const { analysis } = await analyze('/webassign/assignment.html?q=3');
    expect(analysis.next).toBeNull();
  });
});

describe('executor against mocks', () => {
  const ctx = (doc: Document) => ({ doc, isRestricted: () => false });

  it('fills a controlled input and verifies it survives the re-render', async () => {
    const { doc, analysis } = await analyze('/webassign/assignment.html?q=2');
    const field = analysis.questions[1]!.fields[0]!;
    const action: BrowserAction = {
      type: 'fill_text',
      id: 'a',
      questionId: 'x',
      fieldKey: field.key,
      target: field.target,
      value: '9',
    };
    const result = await executeAction(action, ctx(doc));
    expect(result).toMatchObject({ status: 'verified', observed: '9' });
    expect(checkAction(action, doc).status).toBe('verified');
  });

  it('reports not_persisted when a page rejects the value', async () => {
    const { doc, analysis } = await analyze('/webassign/assignment.html?q=2');
    const field = analysis.questions[1]!.fields[0]!;
    const input = doc.querySelector<HTMLInputElement>('input[name="ke"]')!;
    // Resets synchronously after the page's own handler, like a validator refusing the value.
    input.addEventListener('blur', () => {
      input.value = '';
      input.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
    });
    const action: BrowserAction = {
      type: 'fill_text',
      id: 'a',
      questionId: 'x',
      fieldKey: field.key,
      target: field.target,
      value: '9',
    };
    expect(await executeAction(action, ctx(doc))).toMatchObject({
      status: 'failed',
      failure: 'not_persisted',
    });
  });

  it('selects radios, checkboxes and options', async () => {
    const { doc, analysis } = await analyze('/gradescope/assignment.html');
    const radio = analysis.questions[0]!.fields[0]!;
    await executeAction(
      {
        type: 'select_radio',
        id: 'r',
        questionId: 'q',
        fieldKey: radio.key,
        target: radio.options[1]!.target!,
        optionId: 'b',
      },
      ctx(doc),
    );
    expect(doc.querySelector<HTMLInputElement>('input[name=q1][value=b]')!.checked).toBe(true);
    const box = analysis.questions[1]!.fields[0]!;
    const result = await executeAction(
      {
        type: 'set_checkbox',
        id: 'c',
        questionId: 'q',
        fieldKey: box.key,
        target: box.options[0]!.target!,
        optionId: 'two',
        checked: true,
      },
      ctx(doc),
    );
    expect(result.status).toBe('verified');
  });

  it('rejects a missing option, a swapped element, and any restricted page', async () => {
    const { doc, analysis } = await analyze('/webassign/assignment.html?q=1');
    const [speed, unit] = analysis.questions[0]!.fields;
    expect(
      await executeAction(
        {
          type: 'select_option',
          id: 's',
          questionId: 'q',
          fieldKey: unit!.key,
          target: unit!.target,
          optionValue: 'furlongs',
        },
        ctx(doc),
      ),
    ).toMatchObject({ failure: 'option_missing' });
    expect(
      await executeAction(
        {
          type: 'fill_text',
          id: 'f',
          questionId: 'q',
          fieldKey: speed!.key,
          target: { ...speed!.target, fingerprint: { tag: 'textarea' } },
          value: '1',
        },
        ctx(doc),
      ),
    ).toMatchObject({ failure: 'fingerprint_mismatch' });
    expect(
      await executeAction(
        {
          type: 'fill_text',
          id: 'f',
          questionId: 'q',
          fieldKey: speed!.key,
          target: speed!.target,
          value: '1',
        },
        { doc, isRestricted: () => true },
      ),
    ).toMatchObject({ failure: 'restricted_page' });
    expect(doc.querySelector<HTMLInputElement>('input[name=speed]')!.value).toBe('');
  });

  it('refuses to press a submit control even when asked directly', async () => {
    const { doc } = await analyze('/webassign/assignment.html?q=3');
    const action = buildNavigateAction('t', 'p', {
      label: 'Next',
      target: { selector: '#submit-all', fingerprint: { tag: 'button', inputType: 'submit' } },
    });
    expect(await executeAction(action, ctx(doc))).toMatchObject({
      failure: 'forbidden_navigation',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.body.dataset.submitted).toBeUndefined();
  });

  it('rejects anything outside the action vocabulary', async () => {
    const { doc } = await analyze('/webassign/assignment.html?q=1');
    const evil = { type: 'run_script', id: 'x', code: 'alert(1)' } as unknown as BrowserAction;
    await expect(executeAction(evil, ctx(doc))).rejects.toThrow('Rejected malformed action');
  });
});
