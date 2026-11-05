import type { CaptureNode, CaptureResult, PageCapture } from '@sima/shared-types';
import { normalizeSpace } from './dom';
import { detectRestrictions } from './restrictions';

const MAX_NODES = 15000;
const MAX_TOKEN_LENGTH = 40;
// sima-assistant is Sima's own floating UI, which isn't part of the site being captured.
const SKIPPED_TAGS = new Set([
  'SIMA-ASSISTANT',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'LINK',
  'META',
  'BASE',
]);
const OPAQUE_TAGS = new Set([
  'SVG',
  'MATH',
  'MJX-CONTAINER',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'OBJECT',
  'EMBED',
]);
/** Attributes whose values could hold content: only the fact that they exist is recorded. */
const PRESENCE_ONLY = [
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-labelledby',
  'value',
  'href',
  'src',
  'action',
  'contenteditable',
];
const TOKEN_ATTRIBUTES = ['id', 'role', 'type', 'name', 'for'] as const;
/** Control labels worth keeping, because adapters must tell Next from Submit. Whole matches only. */
const UI_LABEL =
  /^(next|next question|next page|previous|previous question|prev|back|continue|save|save answer|save answers|save progress|submit|submit answer|submit answers|submit assignment|submit all|submit & view submission|finish|finish attempt|done|check|check answer|check my work|grade|try another|hint|siguiente|anterior|continuar|enviar|guardar|comprobar|terminar)$/i;

/**
 * Keeps an identifier only if it looks like code rather than content. Numbers become # so user,
 * course and question IDs can't identify anyone. Anything unusual is dropped, not cleaned.
 */
export function safeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw
    .trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#');
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  return /^[A-Za-z_#[\]][A-Za-z0-9_:.\-#[\]]*$/.test(token) ? token : null;
}

export function safePath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  const safe = parts.map((part) => {
    if (/^\d+$/.test(part)) return '#';
    // Ordinary route words only. Slugs with dashes can hold course or personal names.
    return /^[a-z_]{1,20}(\.[a-z]{1,5})?$/i.test(part) ? part : '*';
  });
  return `/${safe.join('/')}`;
}

function ownTextLength(el: Element): number {
  let length = 0;
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) length += normalizeSpace(node.textContent ?? '').length;
  });
  return length;
}

function textBucket(length: number): CaptureNode['text'] {
  if (length === 0) return undefined;
  if (length <= 15) return 'short';
  return length <= 120 ? 'medium' : 'long';
}

function uiLabelOf(el: Element): string | undefined {
  const interactive =
    ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) ||
    el.getAttribute('role') === 'button' ||
    ['submit', 'button'].includes((el.getAttribute('type') ?? '').toLowerCase());
  if (!interactive) return undefined;
  const label = normalizeSpace(
    el.getAttribute('aria-label') ||
      (el.tagName === 'INPUT' ? el.getAttribute('value') : el.textContent) ||
      '',
  );
  return UI_LABEL.test(label) ? label.toLowerCase() : undefined;
}

function frameHostOf(el: Element): string | undefined {
  try {
    return new URL(el.getAttribute('src') ?? '', el.ownerDocument.baseURI).hostname || undefined;
  } catch {
    return undefined;
  }
}

interface WalkState {
  nodes: number;
  truncated: boolean;
  counts: Record<string, number>;
}

function bump(state: WalkState, key: string): void {
  state.counts[key] = (state.counts[key] ?? 0) + 1;
}

function describe(el: Element, state: WalkState): CaptureNode | null {
  if (SKIPPED_TAGS.has(el.tagName.toUpperCase())) return null;
  if (state.nodes >= MAX_NODES) {
    state.truncated = true;
    return null;
  }
  state.nodes++;

  const tagUpper = el.tagName.toUpperCase();
  const tag = safeToken(el.tagName.toLowerCase()) ?? 'unknown';
  const node: CaptureNode = { tag };

  for (const attribute of TOKEN_ATTRIBUTES) {
    const token = safeToken(el.getAttribute(attribute));
    if (token) node[attribute] = token;
  }
  const classes = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .map(safeToken)
    .filter((c): c is string => c !== null);
  if (classes.length > 0) node.classes = classes;

  const data: Record<string, string | null> = {};
  for (const attribute of Array.from(el.attributes)) {
    if (!attribute.name.startsWith('data-')) continue;
    const key = safeToken(attribute.name);
    if (key)
      data[key] =
        attribute.value === 'true' || attribute.value === 'false' ? attribute.value : null;
  }
  if (Object.keys(data).length > 0) node.data = data;

  const has = PRESENCE_ONLY.filter((attribute) => el.hasAttribute(attribute));
  if (has.length > 0) node.has = has;

  const text = textBucket(ownTextLength(el));
  if (text) node.text = text;
  const uiLabel = uiLabelOf(el);
  if (uiLabel) node.uiLabel = uiLabel;
  if ((el as HTMLButtonElement).disabled) node.disabled = true;

  const win = el.ownerDocument.defaultView;
  if (win) {
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') node.hidden = true;
  }

  if (tagUpper === 'INPUT') bump(state, `input:${safeToken(el.getAttribute('type')) ?? 'text'}`);
  if (tagUpper === 'TEXTAREA' || tagUpper === 'FORM' || tagUpper === 'TABLE') bump(state, tag);
  if (el.getAttribute('contenteditable') === 'true') bump(state, 'contenteditable');

  if (tagUpper === 'SELECT') {
    bump(state, 'select');
    node.optionCount = el.querySelectorAll('option').length;
    return node;
  }
  if (tagUpper === 'TEXTAREA') return node;
  if (OPAQUE_TAGS.has(tagUpper)) {
    bump(state, tagUpper === 'MATH' || tagUpper === 'MJX-CONTAINER' ? 'math' : 'media');
    node.opaque = true;
    return node;
  }

  if (tagUpper === 'IFRAME') {
    let inner: Document | null = null;
    try {
      inner = (el as HTMLIFrameElement).contentDocument;
    } catch {
      inner = null;
    }
    if (inner?.body) {
      bump(state, 'iframe:same-origin');
      node.frame = 'same-origin';
      const child = describe(inner.body, state);
      if (child) node.children = [child];
    } else {
      bump(state, 'iframe:cross-origin');
      node.frame = 'cross-origin';
      const host = frameHostOf(el);
      if (host) node.frameHost = host;
    }
    return node;
  }

  const roots: Element[] = Array.from(el.children);
  if (el.shadowRoot) {
    bump(state, 'shadow-root');
    node.shadowRoot = true;
    roots.push(...Array.from(el.shadowRoot.children));
  }
  const children = roots
    .map((child) => describe(child, state))
    .filter((child): child is CaptureNode => child !== null);
  if (children.length > 0) node.children = children;
  return node;
}

/**
 * Records a page's structure for building adapters: an allowlist of code-like details, built from
 * scratch, not a copy of the page with things removed. Question text, answers, names, links and
 * titles have no path into the output. Pages that look like assessments are refused.
 */
export function capturePageStructure(
  doc: Document,
  url: URL,
  platformId: string,
  recognizedBySima: boolean,
  now: Date = new Date(),
): CaptureResult {
  const restriction = detectRestrictions(doc, doc.title);
  if (restriction.status === 'restricted') {
    return {
      status: 'refused',
      reason:
        "This page looks like an exam or an activity that doesn't allow outside help, so Sima won't capture it.",
    };
  }
  if (!doc.body) return { status: 'refused', reason: 'This page has not loaded yet.' };

  const state: WalkState = { nodes: 0, truncated: false, counts: {} };
  const body = describe(doc.body, state) ?? { tag: 'body' };
  const capture: PageCapture = {
    format: 'sima-page-capture-1',
    platformId,
    host: url.hostname,
    path: safePath(url.pathname),
    capturedOn: now.toISOString().slice(0, 10),
    recognizedBySima,
    truncated: state.truncated,
    counts: state.counts,
    body,
  };
  return { status: 'captured', capture };
}
