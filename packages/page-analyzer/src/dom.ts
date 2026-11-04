import type { ElementTarget } from '@sima/shared-types';

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'INPUT',
]);

export function normalizeSpace(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * Rendered-visibility check. Hidden text is the main prompt-injection channel, so anything
 * a sighted user cannot see is excluded from what reaches the model.
 */
export function isHidden(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return true;
    if (!win) continue;
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (parseFloat(style.opacity || '1') === 0) return true;
    if (style.fontSize === '0px') return true;
    if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    if (
      ['absolute', 'fixed'].includes(style.position) &&
      (parseFloat(style.left) <= -500 || parseFloat(style.top) <= -500)
    ) {
      return true;
    }
    if (
      style.overflow === 'hidden' &&
      (parseFloat(style.height) === 0 || parseFloat(style.width) <= 1)
    ) {
      return true;
    }
    const indent = parseFloat(style.textIndent);
    if (indent <= -500) return true;
  }
  return false;
}

/** Visible text of a subtree, keeping exponents and subscripts meaningful. */
export function visibleText(root: Element, exclude?: (el: Element) => boolean): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName) || isHidden(el) || exclude?.(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'math') {
      const tex = el.querySelector('annotation[encoding*="tex" i]');
      parts.push(tex?.textContent ?? el.textContent ?? '');
      return;
    }
    if (tag === 'img') {
      parts.push(` [image: ${el.getAttribute('alt') || 'no description'}] `);
      return;
    }
    if (tag === 'sup') parts.push('^(');
    if (tag === 'sub') parts.push('_(');
    el.childNodes.forEach(walk);
    if (tag === 'sup' || tag === 'sub') parts.push(')');
    if (/^(p|div|li|tr|h[1-6]|br|td|th)$/.test(tag)) parts.push(' ');
  };
  walk(root);
  return normalizeSpace(parts.join(''));
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);
}

function isUnique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

export function buildSelector(el: Element): string {
  const doc = el.ownerDocument;
  if (el.id) {
    const byId = `#${cssEscape(el.id)}`;
    if (isUnique(doc, byId, el)) return byId;
  }
  const name = el.getAttribute('name');
  if (name) {
    const value =
      el.getAttribute('type') === 'radio' || el.getAttribute('type') === 'checkbox'
        ? el.getAttribute('value')
        : null;
    const selector = `${el.tagName.toLowerCase()}[name="${name.replace(/["\\]/g, '\\$&')}"]${
      value !== null ? `[value="${value.replace(/["\\]/g, '\\$&')}"]` : ''
    }`;
    if (isUnique(doc, selector, el)) return selector;
  }
  const path: string[] = [];
  for (
    let node: Element | null = el;
    node && node !== doc.documentElement;
    node = node.parentElement
  ) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const index = Array.from(parent.children).indexOf(node) + 1;
    path.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
  }
  return path.join(' > ');
}

export function makeTarget(el: Element): ElementTarget {
  const inputType = el.getAttribute('type') ?? undefined;
  const name = el.getAttribute('name') ?? undefined;
  return {
    selector: buildSelector(el),
    fingerprint: {
      tag: el.tagName.toLowerCase(),
      ...(inputType ? { inputType } : {}),
      ...(name ? { name } : {}),
    },
  };
}

/** Finds a target and confirms it is still the same kind of element. */
export function resolveTarget(
  doc: Document,
  target: ElementTarget,
): { el: Element } | { failure: 'target_missing' | 'fingerprint_mismatch' } {
  let el: Element | null = null;
  try {
    el = doc.querySelector(target.selector);
  } catch {
    return { failure: 'target_missing' };
  }
  if (!el) return { failure: 'target_missing' };
  const { tag, inputType, name } = target.fingerprint;
  const matches =
    el.tagName.toLowerCase() === tag &&
    (el.getAttribute('type') ?? undefined) === inputType &&
    (el.getAttribute('name') ?? undefined) === name;
  return matches ? { el } : { failure: 'fingerprint_mismatch' };
}
