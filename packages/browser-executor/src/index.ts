import {
  BrowserActionSchema,
  type ActionFailure,
  type ActionResult,
  type BrowserAction,
  type CustomSelect,
} from '@sima/shared-types';
import { isHidden, normalizeSpace, resolveTarget } from '@sima/page-analyzer';

const FORBIDDEN_LABEL =
  /\b(submit|finish|turn in|hand in|end (test|exam|quiz|attempt)|grade|complete assignment)\b/i;
const SETTLE_MS = 120;

export interface ExecutorContext {
  doc: Document;
  /** Re-checked before every action, so a page that becomes restricted stops the run. */
  isRestricted: () => boolean;
}

function result(
  action: BrowserAction,
  partial: Partial<ActionResult> & Pick<ActionResult, 'status'>,
): ActionResult {
  return {
    actionId: action.id,
    alreadyApplied: false,
    observed: null,
    failure: null,
    detail: '',
    ...partial,
  };
}

function fail(action: BrowserAction, failure: ActionFailure, detail: string): ActionResult {
  return result(action, { status: 'failed', failure, detail });
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const win = el.ownerDocument.defaultView;
  const proto =
    el.tagName === 'TEXTAREA'
      ? win?.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? win?.HTMLSelectElement.prototype
        : win?.HTMLInputElement.prototype;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, ...types: string[]): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  for (const type of types) el.dispatchEvent(new win.Event(type, { bubbles: true }));
}

function readObserved(el: Element, action: BrowserAction): string {
  if (action.type === 'select_radio' || action.type === 'set_checkbox')
    return String((el as HTMLInputElement).checked);
  if (el.getAttribute('contenteditable') === 'true') return normalizeSpace(el.textContent ?? '');
  return (el as HTMLInputElement).value ?? '';
}

function desired(action: BrowserAction): string | null {
  switch (action.type) {
    case 'fill_text':
      return action.value;
    case 'select_option':
      return action.optionValue;
    case 'select_radio':
      return 'true';
    case 'set_checkbox':
      return String(action.checked);
    case 'navigate_next':
      return null;
  }
}

function matches(action: BrowserAction, observed: string, want: string): boolean {
  if (action.type === 'fill_text') return normalizeSpace(observed) === normalizeSpace(want);
  return observed === want;
}

function apply(el: Element, action: BrowserAction): void {
  const control = el as HTMLInputElement;
  switch (action.type) {
    case 'fill_text':
      control.focus?.();
      if (el.getAttribute('contenteditable') === 'true') {
        el.textContent = action.value;
        fire(el, 'input');
      } else {
        setNativeValue(control, action.value);
        fire(el, 'input', 'change');
      }
      fire(el, 'blur');
      return;
    case 'select_option':
      setNativeValue(control, action.optionValue);
      fire(el, 'input', 'change');
      return;
    case 'select_radio':
    case 'set_checkbox':
      // click() runs the browser's own activation behavior, which frameworks listen for.
      control.click();
      return;
    case 'navigate_next':
      return;
  }
}

function wait(doc: Document, ms: number): Promise<void> {
  return new Promise((resolve) => (doc.defaultView ?? globalThis).setTimeout(resolve, ms));
}

const LIST_OPEN_TIMEOUT_MS = 1000;
const LIST_POLL_MS = 50;

function pressLikeAPerson(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  (el as HTMLElement).click();
}

/** Opens a site's dropdown, clicks the matching visible option, and confirms the <select> changed. */
async function chooseFromCustomSelect(
  action: Extract<BrowserAction, { type: 'select_option' }>,
  custom: CustomSelect,
  select: HTMLSelectElement,
  doc: Document,
): Promise<ActionResult> {
  const button = resolveTarget(doc, custom.button);
  if ('failure' in button) return fail(action, button.failure, 'The dropdown button is missing');
  if (isHidden(button.el) || (button.el as HTMLButtonElement).disabled) {
    return fail(action, 'target_disabled', 'The dropdown button is not available');
  }
  const index = Array.from(select.options).findIndex((o) => o.value === action.optionValue);

  pressLikeAPerson(button.el);
  const started = Date.now();
  let option: Element | undefined;
  while (!option && Date.now() - started < LIST_OPEN_TIMEOUT_MS) {
    option = Array.from(doc.querySelectorAll(custom.optionSelector)).find(
      (candidate) =>
        candidate.getAttribute(custom.indexAttribute) === String(index) && !isHidden(candidate),
    );
    if (!option) await wait(doc, LIST_POLL_MS);
  }
  if (!option) return fail(action, 'option_missing', 'The dropdown list did not open');

  pressLikeAPerson(option);
  await wait(doc, SETTLE_MS);
  return select.value === action.optionValue
    ? result(action, { status: 'verified', observed: select.value, detail: 'Chosen from the list' })
    : fail(action, 'not_persisted', 'Clicked the option, but the dropdown did not change');
}

/** Reads whether an action's effect is present, without changing the page. Used during recovery. */
export function checkAction(input: BrowserAction, doc: Document): ActionResult {
  const action = BrowserActionSchema.parse(input);
  const want = desired(action);
  const resolved = resolveTarget(doc, action.target);
  if ('failure' in resolved) return fail(action, resolved.failure, 'Target is not on this page');
  if (want === null)
    return fail(action, 'no_response', 'Navigation cannot be checked by reading a control');
  const observed = readObserved(resolved.el, action);
  return matches(action, observed, want)
    ? result(action, { status: 'verified', observed, alreadyApplied: true })
    : fail(action, 'not_persisted', `Field holds "${observed.slice(0, 80)}"`);
}

/** The only code that changes a page. Input is re-validated: a typed action is all it accepts. */
export async function executeAction(
  input: BrowserAction,
  ctx: ExecutorContext,
): Promise<ActionResult> {
  const parsed = BrowserActionSchema.safeParse(input);
  if (!parsed.success) throw new Error('Rejected malformed action');
  const action = parsed.data;
  if (ctx.isRestricted())
    return fail(action, 'restricted_page', 'This page is restricted, so Sima will not act on it');

  const resolved = resolveTarget(ctx.doc, action.target);
  if ('failure' in resolved)
    return fail(action, resolved.failure, `Could not safely resolve ${action.target.selector}`);
  const { el } = resolved;
  const control = el as HTMLInputElement;

  // A custom dropdown's <select> is hidden by design. Its visible button is what gets checked.
  const custom = action.type === 'select_option' ? action.customSelect : undefined;
  if (isHidden(el) && !custom) return fail(action, 'target_disabled', 'Target is not visible');
  if (control.disabled || control.readOnly)
    return fail(action, 'target_disabled', 'Target is disabled or read-only');

  if (action.type === 'navigate_next') {
    const label = normalizeSpace(el.getAttribute('aria-label') || el.textContent || '');
    if (FORBIDDEN_LABEL.test(label) || el.getAttribute('type') === 'submit') {
      return fail(
        action,
        'forbidden_navigation',
        `Refusing to press "${label}": Sima never submits work`,
      );
    }
    // Deferred so the response is delivered before a page unload can drop the channel.
    (ctx.doc.defaultView ?? globalThis).setTimeout(() => control.click(), 0);
    return result(action, { status: 'dispatched', detail: `Pressed "${label}"` });
  }

  if (
    action.type === 'select_option' &&
    !Array.from((el as unknown as HTMLSelectElement).options).some(
      (o) => o.value === action.optionValue,
    )
  ) {
    return fail(action, 'option_missing', `Option "${action.optionValue}" is not in the dropdown`);
  }

  const want = desired(action) as string;
  if (matches(action, readObserved(el, action), want)) {
    return result(action, {
      status: 'verified',
      alreadyApplied: true,
      observed: want,
      detail: 'Already had this value',
    });
  }

  if (action.type === 'select_option' && custom) {
    return chooseFromCustomSelect(action, custom, el as unknown as HTMLSelectElement, ctx.doc);
  }

  apply(el, action);
  // Read back after a pause: controlled components can revert a value on their next render.
  await wait(ctx.doc, SETTLE_MS);
  const after = resolveTarget(ctx.doc, action.target);
  if ('failure' in after)
    return fail(action, after.failure, 'Target disappeared after the interaction');
  const observed = readObserved(after.el, action);
  return matches(action, observed, want)
    ? result(action, { status: 'verified', observed, detail: 'Value read back from the page' })
    : fail(
        action,
        'not_persisted',
        `Wrote the value, but the page now holds "${observed.slice(0, 80)}"`,
      );
}
