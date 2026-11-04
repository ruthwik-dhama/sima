import type {
  AnswerField,
  BrowserAction,
  NavigationControl,
  PlanBlocker,
  QuestionRecord,
} from '@sima/shared-types';

export const MAPPING_CONFIDENCE_THRESHOLD = 0.8;
/**
 * Why one-click fill leaves a question for the user, or null if it may be entered. Confidence and
 * failed checks don't hold anything back, since the panel shows them and the user decides how much
 * to trust them. Text trying to steer the model does, because the confidence can't reflect that.
 */
export function autoFillHold(record: QuestionRecord): string | null {
  const { solution, question } = record;
  if (!solution) return record.solveError ? 'Sima could not solve this' : 'Not solved yet';
  if (question.suspiciousText.length > 0) return 'This question contains text aimed at AI tools';
  if (!solution.answers.some((a) => a.values.length > 0)) return 'The model gave no answer';
  return null;
}

/** FNV-1a. Stable across service-worker restarts, which is what duplicate protection needs. */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function actionId(taskId: string, record: QuestionRecord, parts: string[]): string {
  return `${taskId}:${record.pageKey}:${record.question.id}:${stableHash(parts.join('\u0000'))}`;
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

function planField(
  taskId: string,
  record: QuestionRecord,
  field: AnswerField,
  values: string[],
): BrowserAction[] {
  const common = { questionId: record.question.id, fieldKey: field.key };
  const value = values[0] ?? '';
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'contenteditable':
      return [
        {
          ...common,
          type: 'fill_text',
          id: actionId(taskId, record, [field.key, 'fill', value]),
          target: field.target,
          value,
        },
      ];
    case 'select':
      return [
        {
          ...common,
          type: 'select_option',
          id: actionId(taskId, record, [field.key, 'select', value]),
          target: field.target,
          optionValue: value,
        },
      ];
    case 'radio_group': {
      const option = field.options.find((o) => o.id === value);
      return option?.target
        ? [
            {
              ...common,
              type: 'select_radio',
              id: actionId(taskId, record, [field.key, 'radio', value]),
              target: option.target,
              optionId: value,
            },
          ]
        : [];
    }
    case 'checkbox_group':
      return field.options.flatMap((option) => {
        const wanted = values.includes(option.id);
        const current = field.currentValues.includes(option.id);
        if (!option.target || wanted === current) return [];
        return [
          {
            ...common,
            type: 'set_checkbox' as const,
            id: actionId(taskId, record, [field.key, 'check', option.id, String(wanted)]),
            target: option.target,
            optionId: option.id,
            checked: wanted,
          },
        ];
      });
  }
}

/**
 * Turns approved responses into typed actions. Pure, and it refuses rather than guesses:
 * every field that can't be planned safely comes back as a blocker the user can resolve.
 */
export function buildPlan(
  taskId: string,
  records: QuestionRecord[],
): { actions: BrowserAction[]; blockers: PlanBlocker[] } {
  const actions: BrowserAction[] = [];
  const blockers: PlanBlocker[] = [];

  for (const record of records) {
    const questionId = record.question.id;
    if (!record.approved) {
      blockers.push({
        questionId,
        fieldKey: null,
        code: 'not_approved',
        message: `Question ${record.question.number} is not approved yet`,
      });
      continue;
    }
    for (const field of record.question.fields) {
      const values = (record.responses[field.key] ?? []).filter((v) => v !== '');
      const block = (code: PlanBlocker['code'], message: string) =>
        blockers.push({ questionId, fieldKey: field.key, code, message });

      if (values.length === 0) {
        block('no_response', `No response for ${field.label || field.key}`);
        continue;
      }
      if (
        field.mappingConfidence < MAPPING_CONFIDENCE_THRESHOLD &&
        !record.confirmedFields.includes(field.key)
      ) {
        block(
          'low_mapping_confidence',
          `Confirm which blank "${field.key}" is: ${field.mappingReason}`,
        );
        continue;
      }
      if (field.kind !== 'checkbox_group' && values.length > 1) {
        block('multiple_values', `${field.key} accepts one value`);
        continue;
      }
      if (field.options.length > 0 && !values.every((v) => field.options.some((o) => o.id === v))) {
        block('unknown_option', `${field.key} has a response that is not an option on the page`);
        continue;
      }
      if (sameValues(field.currentValues, values)) continue;
      if (field.currentValues.length > 0 && !record.overwriteFields.includes(field.key)) {
        block(
          'existing_value',
          `${field.key} already contains an answer. Allow Sima to replace it, or leave it.`,
        );
        continue;
      }
      actions.push(...planField(taskId, record, field, values));
    }
  }
  return { actions, blockers };
}

export function buildNavigateAction(
  taskId: string,
  pageKey: string,
  next: NavigationControl,
): BrowserAction {
  return {
    type: 'navigate_next',
    id: `${taskId}:${pageKey}:nav:${stableHash(next.target.selector)}`,
    questionId: '',
    fieldKey: '',
    target: next.target,
    label: next.label,
    fromPageKey: pageKey,
  };
}
