import { describe, expect, it } from 'vitest';
import { buildPlan } from '@sima/action-planner';
import type { AnswerField, QuestionRecord } from '@sima/shared-types';

const t = (selector: string) => ({ selector, fingerprint: { tag: 'input' } });
const text: AnswerField = {
  key: 'a',
  kind: 'text',
  label: 'A',
  target: t('#a'),
  options: [],
  currentValues: [],
  mappingConfidence: 0.95,
  mappingReason: 'labeled',
};

function record(
  fields: AnswerField[],
  responses: Record<string, string[]>,
  over: Partial<QuestionRecord> = {},
): QuestionRecord {
  return {
    id: 'r',
    taskId: 't',
    pageKey: 'p',
    question: {
      id: 'q',
      pageKey: 'p',
      number: '1',
      prompt: '',
      format: 'mixed',
      tables: [],
      images: [],
      fields,
      suspiciousText: [],
    },
    solution: null,
    solveError: null,
    responses,
    approved: true,
    confirmedFields: [],
    overwriteFields: [],
    followUps: [],
    ...over,
  };
}
const codes = (r: QuestionRecord) => buildPlan('t', [r]).blockers.map((b) => b.code);

describe('buildPlan', () => {
  it('plans nothing for an unapproved question', () => {
    const plan = buildPlan('t', [record([text], { a: ['1'] }, { approved: false })]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers[0]?.code).toBe('not_approved');
  });

  it('creates a typed action for each kind of control', () => {
    const fields: AnswerField[] = [
      text,
      { ...text, key: 's', kind: 'select', target: t('#s'), options: [{ id: 'x', label: 'X' }] },
      {
        ...text,
        key: 'r',
        kind: 'radio_group',
        options: [{ id: 'o1', label: 'O1', target: t('#o1') }],
      },
      {
        ...text,
        key: 'c',
        kind: 'checkbox_group',
        options: [
          { id: 'c1', label: 'C1', target: t('#c1') },
          { id: 'c2', label: 'C2', target: t('#c2') },
        ],
        currentValues: ['c2'],
      },
    ];
    const plan = buildPlan('t', [
      record(fields, { a: ['1'], s: ['x'], r: ['o1'], c: ['c1'] }, { overwriteFields: ['c'] }),
    ]);
    expect(plan.actions.map((a) => a.type)).toEqual([
      'fill_text',
      'select_option',
      'select_radio',
      'set_checkbox',
      'set_checkbox',
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('holds an ambiguous mapping until the user confirms it', () => {
    const fuzzy = { ...text, mappingConfidence: 0.45 };
    expect(codes(record([fuzzy], { a: ['1'] }))).toEqual(['low_mapping_confidence']);
    expect(
      buildPlan('t', [record([fuzzy], { a: ['1'] }, { confirmedFields: ['a'] })]).actions,
    ).toHaveLength(1);
  });

  it('will not overwrite an existing answer unless allowed', () => {
    const filled = { ...text, currentValues: ['mine'] };
    expect(codes(record([filled], { a: ['1'] }))).toEqual(['existing_value']);
    expect(
      buildPlan('t', [record([filled], { a: ['1'] }, { overwriteFields: ['a'] })]).actions,
    ).toHaveLength(1);
  });

  it('skips a field that already holds the response', () => {
    const plan = buildPlan('t', [record([{ ...text, currentValues: ['1'] }], { a: ['1'] })]);
    expect(plan.actions).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it('rejects options the page does not have', () => {
    const select: AnswerField = { ...text, kind: 'select', options: [{ id: 'x', label: 'X' }] };
    expect(codes(record([select], { a: ['nope'] }))).toEqual(['unknown_option']);
  });

  it('gives identical work the same id and edited work a new one', () => {
    const id = (value: string) => buildPlan('t', [record([text], { a: [value] })]).actions[0]?.id;
    expect(id('1')).toBe(id('1'));
    expect(id('1')).not.toBe(id('2'));
  });
});
