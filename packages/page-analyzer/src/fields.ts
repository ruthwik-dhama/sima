import type { AnswerField, FieldKind, FieldOption, QuestionFormat } from '@sima/shared-types';
import { isHidden, makeTarget, normalizeSpace, visibleText } from './dom';

const TEXT_INPUT_TYPES = new Set(['', 'text', 'number', 'search', 'tel', 'url', 'email']);

function explicitLabel(el: Element): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute('aria-label');
  if (aria) return normalizeSpace(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map((n) => visibleText(n))
      .join(' ');
    if (text) return normalizeSpace(text);
  }
  if (el.id) {
    const label = Array.from(doc.querySelectorAll('label')).find(
      (candidate) => candidate.getAttribute('for') === el.id,
    );
    if (label) return visibleText(label);
  }
  const wrapping = el.closest('label');
  if (wrapping) return visibleText(wrapping);
  return '';
}

function readValue(el: Element): string {
  return (el as HTMLInputElement).value ?? '';
}

export interface DetectedFields {
  fields: AnswerField[];
}

/** Finds the answer controls in a question container and scores how sure each mapping is. */
export function detectFields(container: Element, questionId: string): AnswerField[] {
  const controls = Array.from(
    container.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
  ).filter((el) => !isHidden(el));

  const fields: AnswerField[] = [];
  const groups = new Map<string, HTMLInputElement[]>();
  const singles: Element[] = [];

  for (const el of controls) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        const name = el.getAttribute('name') ?? `${type}:${groups.size}`;
        const group = groups.get(`${type}|${name}`) ?? [];
        group.push(el as HTMLInputElement);
        groups.set(`${type}|${name}`, group);
        continue;
      }
      if (!TEXT_INPUT_TYPES.has(type)) continue;
    }
    singles.push(el);
  }

  const totalControls = singles.length + groups.size;

  for (const el of singles) {
    const tag = el.tagName;
    const kind: FieldKind =
      tag === 'SELECT'
        ? 'select'
        : tag === 'TEXTAREA'
          ? 'textarea'
          : tag === 'INPUT'
            ? 'text'
            : 'contenteditable';
    const label = explicitLabel(el);
    const scoped = totalControls === 1;
    const confidence = label ? (scoped ? 0.99 : 0.95) : scoped ? 0.92 : 0.85;
    const reason = label
      ? 'Control has an explicit label inside the question'
      : scoped
        ? 'Only control inside the question'
        : 'Unlabeled blank, placed by where it sits in the question';
    const options: FieldOption[] =
      kind === 'select'
        ? Array.from((el as HTMLSelectElement).options)
            .filter((o) => o.value !== '')
            .map((o) => ({ id: o.value, label: normalizeSpace(o.textContent ?? '') }))
        : [];
    const value = kind === 'contenteditable' ? normalizeSpace(el.textContent ?? '') : readValue(el);
    fields.push({
      key: el.getAttribute('name') || el.id || `${questionId}:f${fields.length + 1}`,
      kind,
      label,
      target: makeTarget(el),
      options,
      currentValues: value ? [value] : [],
      mappingConfidence: confidence,
      mappingReason: reason,
    });
  }

  for (const [groupKey, inputs] of groups) {
    const first = inputs[0];
    if (!first) continue;
    const type = groupKey.split('|')[0] === 'radio' ? 'radio_group' : 'checkbox_group';
    const options: FieldOption[] = inputs.map((input, index) => ({
      id: input.value && input.value !== 'on' ? input.value : `option-${index + 1}`,
      label: explicitLabel(input),
      target: makeTarget(input),
    }));
    const allLabeled = options.every((o) => o.label);
    fields.push({
      key: first.getAttribute('name') || `${questionId}:g${fields.length + 1}`,
      kind: type,
      label: first.closest('fieldset')?.querySelector('legend')?.textContent?.trim() ?? '',
      target: makeTarget(first),
      options,
      currentValues: inputs.flatMap((input, index) =>
        input.checked ? [options[index]?.id ?? ''] : [],
      ),
      mappingConfidence: allLabeled ? 0.98 : 0.4,
      mappingReason: allLabeled
        ? 'Named input group with a label on every option'
        : 'Some options have no readable label',
    });
  }

  return fields;
}

export function inferFormat(fields: AnswerField[], prompt: string): QuestionFormat {
  if (fields.length === 0) return 'written';
  const kinds = new Set(fields.map((f) => f.kind));
  if (kinds.size > 1) return 'mixed';
  const kind = fields[0]?.kind;
  if (kind === 'radio_group') return 'multiple_choice';
  if (kind === 'checkbox_group') return 'multi_select';
  if (kind === 'select') return fields.length > 1 ? 'matching' : 'dropdown';
  if (kind === 'textarea' || kind === 'contenteditable') return 'written';
  return /\b(calculate|compute|find|determine|evaluate|how (many|much)|what is the value)\b/i.test(
    prompt,
  ) && /\d/.test(prompt)
    ? 'numeric'
    : 'short_answer';
}
