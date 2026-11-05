import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { capturePageStructure, safePath, safeToken } from '@sima/page-analyzer';
import { PageCaptureSchema, type CaptureNode, type PageCapture } from '@sima/shared-types';
import { startPlayground } from '../../playground/server.mjs';

const base = 'http://127.0.0.1:5199';
let server: Pick<Server, 'close'>;
beforeAll(async () => {
  server = await startPlayground(5199);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

async function capture(path: string) {
  const dom = await JSDOM.fromURL(base + path, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  return capturePageStructure(dom.window.document, new URL(base + path), 'gradescope', false);
}

function find(node: CaptureNode, match: (n: CaptureNode) => boolean): CaptureNode | undefined {
  if (match(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

async function captured(path: string): Promise<PageCapture> {
  const result = await capture(path);
  if (result.status !== 'captured') throw new Error(result.reason);
  return result.capture;
}

describe('page capture', () => {
  it('leaks none of the secrets planted in the page', async () => {
    const output = JSON.stringify(await captured('/gradescope/unrecognized.html'));
    expect(output).not.toMatch(/SECRET/i);
    expect(output).not.toMatch(/jane|doe|PHYS|speed of light/i);
    for (const id of ['12345', '987654', '55512', '77123', '77124'])
      expect(output).not.toContain(id);
    expect(output).not.toContain('127.0.0.1:9');
  });

  it('keeps the structure an adapter needs', async () => {
    const { body, counts, path } = await captured('/gradescope/unrecognized.html');
    expect(path).toBe('/gradescope/unrecognized.html');
    expect(body.classes).toEqual(['course-page', 'student-#']);
    expect(body.data).toEqual({ 'data-user-email': null, 'data-user-id': null });
    const input = find(body, (n) => n.name === 'answers[#][value]');
    expect(input).toMatchObject({ tag: 'input', id: 'ans_#', type: 'text' });
    expect(input?.has).toEqual(expect.arrayContaining(['value', 'placeholder', 'aria-label']));
    expect(find(body, (n) => n.classes?.includes('question-#') === true)?.tag).toBe('section');
    expect(find(body, (n) => n.tag === 'select')?.optionCount).toBe(2);
    expect(find(body, (n) => n.tag === 'select')?.children).toBeUndefined();
    expect(find(body, (n) => n.tag === 'math')?.opaque).toBe(true);
    expect(counts).toMatchObject({
      'input:text': 3,
      'input:radio': 1,
      'input:hidden': 1,
      select: 1,
      textarea: 1,
      contenteditable: 1,
    });
  });

  it('tells Next from Submit, but keeps no other label', async () => {
    const { body } = await captured('/gradescope/unrecognized.html');
    expect(find(body, (n) => n.classes?.includes('nav-next') === true)?.uiLabel).toBe('next');
    expect(find(body, (n) => n.classes?.includes('nav-submit') === true)?.uiLabel).toBe('submit');
    expect(find(body, (n) => n.classes?.includes('nav-other') === true)?.uiLabel).toBeUndefined();
  });

  it("leaves out Sima's own floating UI", () => {
    const dom = new JSDOM(
      '<body><p class="site"></p><sima-assistant class="own"></sima-assistant></body>',
    );
    const result = capturePageStructure(dom.window.document, new URL(base), 'x', false);
    expect(JSON.stringify(result)).toContain('site');
    expect(JSON.stringify(result)).not.toContain('sima-assistant');
  });

  it('records frames and shadow roots', async () => {
    const { body, counts } = await captured('/gradescope/unrecognized.html');
    expect(counts['shadow-root']).toBe(1);
    expect(find(body, (n) => n.classes?.includes('in-shadow') === true)?.name).toBe(
      'shadow_answer',
    );
    const inner = find(body, (n) => n.classes?.includes('inner-frame') === true);
    expect(inner?.frame).toBe('same-origin');
    expect(find(inner!, (n) => n.classes?.includes('frame-input') === true)).toBeTruthy();
    const outer = find(body, (n) => n.classes?.includes('outer-frame') === true);
    expect(outer?.frame).toBe('cross-origin');
    expect(outer?.children).toBeUndefined();
  });

  it('matches its own schema', async () => {
    const result = await capture('/gradescope/unrecognized.html');
    expect(result.status).toBe('captured');
    if (result.status === 'captured') expect(PageCaptureSchema.parse(result.capture)).toBeTruthy();
  });

  it.each(['/gradescope/unrecognized-exam.html', '/gradescope/exam.html', '/webassign/test.html'])(
    'refuses %s',
    async (path) => {
      const result = await capture(path);
      expect(result.status).toBe('refused');
      expect(JSON.stringify(result)).not.toContain('input');
    },
  );

  it('stops at its size limit and says so', () => {
    const dom = new JSDOM(`<body>${'<div></div>'.repeat(16000)}</body>`);
    const result = capturePageStructure(dom.window.document, new URL(base), 'x', false);
    expect(result.status === 'captured' && result.capture.truncated).toBe(true);
  });
});

describe('safeToken', () => {
  it.each([
    ['question-123', 'question-#'],
    ['answers[12][value]', 'answers[#][value]'],
    ['ans_77', 'ans_#'],
    ['btn-primary', 'btn-primary'],
  ])('%s becomes %s', (raw, expected) => {
    expect(safeToken(raw)).toBe(expected);
  });

  it.each([
    'jane.doe@school.edu',
    'has space',
    "it's",
    'https://x.test/a',
    'a'.repeat(41),
    '',
    '<b>',
    'w-1/2',
  ])('drops %s', (raw) => {
    expect(safeToken(raw)).toBeNull();
  });

  it('removes IDs, including long hex and UUIDs', () => {
    expect(safeToken('item-3f2a9c81d4')).toBe('item-#');
    expect(safeToken('x-550e8400-e29b-41d4-a716-446655440000')).toBe('x-#');
  });
});

describe('safePath', () => {
  it.each([
    ['/courses/123/assignments/456/submissions/new', '/courses/#/assignments/#/submissions/new'],
    ['/courses/jane-doe-physics-201/x', '/courses/*/x'],
    ['/web/Student/Assignment-Responses/last', '/web/Student/*/last'],
    ['/a/activity.html', '/a/activity.html'],
    ['/', '/'],
  ])('%s becomes %s', (raw, expected) => {
    expect(safePath(raw)).toBe(expected);
  });
});
