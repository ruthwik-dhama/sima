import {
  optionLetter,
  type AnswerField,
  type CheckResult,
  type ModelSolution,
  type Question,
  type ValidatedSolution,
} from '@sima/shared-types';
import { asksForExplanation, asksForWork } from './prompt';
import {
  countSignificantFigures,
  evaluateExpression,
  formatLike,
  numbersAgree,
  parseNumericAnswer,
  replaceNumber,
  toSignificantFigures,
} from './math';

const FAIL_CAP = 0.35;
const ABSTAIN_CAP = 0.1;
/** Below the auto-fill bar: the model and its own calculation disagreed, so a person should look. */
const CORRECTED_CAP = 0.6;

const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
const PLACE_NAMES: Record<string, number> = { tenth: 1, hundredth: 2, thousandth: 3 };

function wordToNumber(word: string): number {
  return /\d/.test(word) ? Number(word) : WORDS.indexOf(word.toLowerCase());
}

function normalizeChoice(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*\(?[a-z0-9]\s*[).:]\s+/, '')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

function optionAtLetter(field: AnswerField, letter: string): string | null {
  const index = letter.toLowerCase().charCodeAt(0) - 97;
  if (optionLetter(index, field.options.length) === null) return null;
  return field.options[index]?.id ?? null;
}

/**
 * Turns what the model said into an option id. The prompt lists choices by letter, so a letter
 * means that position (b = second) even if a page's own ids happen to be letters in another order.
 * Ids and labels are accepted too, since models don't always follow instructions.
 */
function resolveChoice(field: AnswerField, value: string): string | null {
  const text = value.trim();
  const lone = text.match(/^\(?([a-z])\)?[.:)]?$/i)?.[1];
  if (lone) {
    const byLetter = optionAtLetter(field, lone);
    if (byLetter) return byLetter;
  }
  const exact = field.options.find((o) => o.id === value);
  if (exact) return exact.id;
  const wanted = text.toLowerCase();
  const byId = field.options.find((o) => o.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const normalized = normalizeChoice(value);
  const byLabel = field.options.filter((o) => normalizeChoice(o.label) === normalized);
  if (byLabel.length === 1) return byLabel[0]?.id ?? null;
  // Only a clearly marked letter counts, so "a cat" is never read as choice a.
  const marked =
    text.match(/^\(?([a-z])[.:)]\s/i)?.[1] ??
    text.match(/\b(?:answer|option|choice)(?:\s+is)?\s*:?\s*\(?([a-z])\)?[.:)]?\s*$/i)?.[1];
  return marked ? optionAtLetter(field, marked) : null;
}

/** Splits "a, c" and "a and c" for select-all fields, when every piece is a real choice. */
function resolveChoices(field: AnswerField, value: string): Array<string | null> {
  if (field.kind === 'checkbox_group' && resolveChoice(field, value) === null) {
    const pieces = value.split(/\s*(?:,|;|&|\band\b)\s*/i).filter((p) => p !== '');
    const resolved = pieces.map((p) => resolveChoice(field, p));
    if (pieces.length > 1 && resolved.every((r) => r !== null)) return resolved;
  }
  return [resolveChoice(field, value)];
}

/** Reads "the answer is: b" or "the answers are a and c" from reasoning, using the last mention. */
function choicesFromReasoning(field: AnswerField, solution: ModelSolution): string[] {
  const text = [solution.explanation, ...solution.steps].join('\n');
  const mentions = [...text.matchAll(/\banswers?\s+(?:is|are)\s*:?\s*([^\n]+?)\s*(?:[.\n]|$)/gi)];
  const last = mentions[mentions.length - 1]?.[1];
  if (!last) return [];
  const resolved = resolveChoices(field, last);
  return resolved.every((r) => r !== null) ? (resolved as string[]) : [];
}

const BARE_NUMBER = /^[-+−]?[\d,]*\.?\d+(?:[eE][-+]?\d+)?(?:\s*[a-zA-Z°%µ][a-zA-Z0-9°%µ/^·*-]*)?$/;

function isWrittenAnswer(value: string): boolean {
  return parseNumericAnswer(value) === null && value.trim().split(/\s+/).length > 3;
}

function isBareResult(value: string): boolean {
  return BARE_NUMBER.test(value) || !/\s/.test(value);
}

/**
 * Reduces a model's answer to its result: "3^4 = 81, then 81 + 12 = 93" becomes "93". Only a chain
 * ending in a number counts, so an answer like "y = 2x + 3" stays whole.
 */
function toFinalAnswer(value: string): string {
  const text = value.trim().replace(/\.$/, '');
  const stated = text.match(
    /\b(?:final answer|the answer|answer|result)\s*(?:is|:|=)\s*(.+)$/i,
  )?.[1];
  const candidate = stated?.trim() ?? text;
  if (BARE_NUMBER.test(candidate)) return candidate;
  const parts = candidate.split('=');
  const last = parts[parts.length - 1]?.trim() ?? '';
  const hasWorking = parts.length > 1 && /\d/.test(parts[0] ?? '');
  return hasWorking && BARE_NUMBER.test(last) ? last : stated ? candidate : value;
}

/**
 * Checks a parsed model answer against the question it answers, and corrects what arithmetic can
 * settle. Anything naming a field or option the page lacks is dropped here, so it can't reach
 * the action planner.
 */
export function validateSolution(question: Question, solution: ModelSolution): ValidatedSolution {
  const checks: CheckResult[] = [];
  const answers: ModelSolution['answers'] = [];
  let corrected = false;

  for (const answer of solution.answers) {
    const field = question.fields.find((f) => f.key === answer.fieldKey);
    if (!field) {
      checks.push({
        name: 'Field is on the page',
        status: 'fail',
        detail: `Dropped unknown field "${answer.fieldKey}"`,
      });
      continue;
    }
    if (field.options.length > 0) {
      const resolved = answer.values.flatMap((v) => resolveChoices(field, v));
      const known = [...new Set(resolved.filter((v): v is string => v !== null))];
      const allKnown = resolved.every((v) => v !== null);
      checks.push(
        allKnown
          ? {
              name: 'Choice is on the page',
              status: 'pass',
              detail: field.label || 'matches an option',
            }
          : {
              name: 'Choice is on the page',
              status: 'fail',
              detail: `An answer for ${field.key} named an option the page doesn't have`,
            },
      );
      answers.push({ fieldKey: field.key, values: known });
      continue;
    }
    const finalOnly = field.kind !== 'textarea' && !asksForWork(question.prompt);
    answers.push({
      fieldKey: field.key,
      values: answer.values
        .map((v) => v.normalize('NFC'))
        .map((v) => (finalOnly ? toFinalAnswer(v) : v))
        .filter((v) => v.trim() !== ''),
    });
  }

  // The model sometimes reasons its way to a choice and leaves answers empty.
  const onlyField = question.fields.length === 1 ? question.fields[0] : undefined;
  if (onlyField && onlyField.options.length > 0) {
    const entry = answers.find((a) => a.fieldKey === onlyField.key);
    if (!entry || entry.values.length === 0) {
      const found = choicesFromReasoning(onlyField, solution);
      if (found.length > 0) {
        if (entry) entry.values = found;
        else answers.push({ fieldKey: onlyField.key, values: found });
        checks.push({
          name: 'Choice is on the page',
          status: 'pass',
          detail: 'Read from the reasoning, where the model stated its answer',
        });
      }
    }
  }

  // A question asking for work or an explanation shouldn't get a bare result, and the model has
  // already written both, so use what it wrote.
  if (asksForWork(question.prompt)) {
    for (const entry of answers) {
      const field = question.fields.find((f) => f.key === entry.fieldKey);
      const value = entry.values[0]?.trim();
      if (!field || field.options.length > 0 || !value || !isBareResult(value)) continue;
      if (asksForExplanation(question.prompt)) {
        if (solution.explanation.trim()) entry.values = [solution.explanation.trim()];
      } else if (solution.steps.length > 0) {
        entry.values = [`${solution.steps.join(' ')} Answer: ${value}`];
      }
    }
  }

  const computedValues = new Map<string, number>();
  for (const calc of solution.calculations) {
    const field = question.fields.find((f) => f.key === calc.fieldKey);
    if (!field || field.options.length > 0) continue;
    // Correction is for numeric results. It must not replace a written answer with a number.
    const written = answers.find((a) => a.fieldKey === calc.fieldKey)?.values[0] ?? '';
    if (asksForWork(question.prompt) || isWrittenAnswer(written)) continue;
    let entry = answers.find((a) => a.fieldKey === calc.fieldKey);
    if (!entry) {
      entry = { fieldKey: field.key, values: [] };
      answers.push(entry);
    }
    const name = `Calculation for ${field.label || field.key}`;
    let computed: number;
    try {
      computed = evaluateExpression(calc.expression.split('=')[0] ?? '');
    } catch {
      checks.push({
        name,
        status: 'not_checked',
        detail: `Could not evaluate ${calc.expression}`,
      });
      continue;
    }
    computedValues.set(field.key, computed);
    const stated = entry.values[0] ?? '';
    if (stated === '') {
      // The model did the work but left the answer blank, so use the calculation's result.
      entry.values = [String(Number(computed.toPrecision(10)))];
      checks.push({ name, status: 'pass', detail: `${calc.expression} = ${computed}` });
      continue;
    }
    if (numbersAgree(stated, computed)) {
      checks.push({ name, status: 'pass', detail: `${calc.expression} = ${computed}` });
      continue;
    }
    // Arithmetic is the one thing Sima can settle itself, so the evaluated result wins.
    const fixed = replaceNumber(stated, formatLike(stated, computed));
    entry.values = [fixed];
    corrected = true;
    checks.push({
      name,
      status: 'pass',
      detail: `Corrected: the model said "${stated}", but ${calc.expression} = ${computed}`,
    });
  }

  const sigFigs = question.prompt.match(
    /\b(\d|one|two|three|four|five|six)\s+sig(?:nificant)?\.?\s*(?:fig(?:ure)?s?|digits)\b/i,
  )?.[1];
  const decimalWord = question.prompt.match(
    /\b(\d|one|two|three|four|five|six)\s+decimal\s+places?\b/i,
  )?.[1];
  const placeName = question.prompt.match(/\bnearest\s+(tenth|hundredth|thousandth)\b/i)?.[1];
  const decimals = decimalWord
    ? wordToNumber(decimalWord)
    : placeName
      ? PLACE_NAMES[placeName.toLowerCase()]
      : undefined;

  for (const entry of answers) {
    const field = question.fields.find((f) => f.key === entry.fieldKey);
    const value = entry.values[0];
    if (!field || field.options.length > 0 || value === undefined) continue;
    const parsed = parseNumericAnswer(value);
    if (parsed === null) continue;
    const exact = computedValues.get(field.key) ?? parsed;
    if (sigFigs) {
      const wanted = wordToNumber(sigFigs);
      if (countSignificantFigures(value) !== wanted) {
        entry.values = [replaceNumber(value, toSignificantFigures(exact, wanted))];
      }
      checks.push({
        name: `Significant figures for ${field.label || field.key}`,
        status: 'pass',
        detail: `${entry.values[0]} has ${wanted}`,
      });
    } else if (decimals !== undefined) {
      entry.values = [replaceNumber(value, exact.toFixed(decimals))];
      checks.push({
        name: `Decimal places for ${field.label || field.key}`,
        status: 'pass',
        detail: `${entry.values[0]} has ${decimals}`,
      });
    }
  }

  const answered = new Set(answers.filter((a) => a.values.length > 0).map((a) => a.fieldKey));
  const missing = question.fields.filter((f) => !answered.has(f.key));
  if (missing.length > 0 && !solution.cannotAnswer) {
    checks.push({
      name: 'All fields answered',
      status: 'fail',
      detail: `No answer for ${missing.map((f) => f.key).join(', ')}`,
    });
  }

  let adjustedConfidence = solution.confidence;
  if (corrected) adjustedConfidence = Math.min(adjustedConfidence, CORRECTED_CAP);
  if (checks.some((c) => c.status === 'fail')) {
    adjustedConfidence = Math.min(adjustedConfidence, FAIL_CAP);
  }
  if (solution.cannotAnswer) adjustedConfidence = Math.min(adjustedConfidence, ABSTAIN_CAP);
  if (question.images.some((image) => !image.alt)) {
    checks.push({
      name: 'Images described',
      status: 'not_checked',
      detail: 'An image has no description, and the model did not see it',
    });
    adjustedConfidence = Math.min(adjustedConfidence, 0.5);
  }

  return { ...solution, answers, checks, adjustedConfidence };
}
