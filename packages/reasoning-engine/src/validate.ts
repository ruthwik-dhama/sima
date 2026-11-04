import type { CheckResult, ModelSolution, Question, ValidatedSolution } from '@sima/shared-types';
import {
  countSignificantFigures,
  evaluateExpression,
  numbersAgree,
  parseNumericAnswer,
} from './math';

const FAIL_CAP = 0.35;
const ABSTAIN_CAP = 0.1;

/**
 * Checks a parsed model answer against the question it answers. Anything naming a field or
 * option that the page doesn't have is dropped here, before it can reach the action planner.
 */
export function validateSolution(question: Question, solution: ModelSolution): ValidatedSolution {
  const checks: CheckResult[] = [];
  const answers: ModelSolution['answers'] = [];

  for (const answer of solution.answers) {
    const field = question.fields.find((f) => f.key === answer.fieldKey);
    if (!field) {
      checks.push({
        name: 'field exists',
        status: 'fail',
        detail: `Dropped unknown field "${answer.fieldKey}"`,
      });
      continue;
    }
    if (field.options.length > 0) {
      const known = answer.values.filter((v) => field.options.some((o) => o.id === v));
      if (known.length !== answer.values.length) {
        checks.push({
          name: 'Choice is on the page',
          status: 'fail',
          detail: `An answer for ${field.key} named an option the page doesn't have`,
        });
      } else {
        checks.push({
          name: 'Choice is on the page',
          status: 'pass',
          detail: field.label || 'matches an option',
        });
      }
      answers.push({ fieldKey: field.key, values: known });
      continue;
    }
    answers.push({ fieldKey: field.key, values: answer.values.map((v) => v.normalize('NFC')) });
  }

  for (const calc of solution.calculations) {
    const answer = answers.find((a) => a.fieldKey === calc.fieldKey)?.values[0];
    const name = `calculation ${calc.fieldKey}`;
    if (answer === undefined || parseNumericAnswer(answer) === null) {
      checks.push({ name, status: 'not_checked', detail: 'No numeric answer to compare' });
      continue;
    }
    try {
      const computed = evaluateExpression(calc.expression);
      checks.push(
        numbersAgree(answer, computed)
          ? { name, status: 'pass', detail: `${calc.expression} = ${computed}` }
          : {
              name,
              status: 'fail',
              detail: `${calc.expression} = ${computed}, but the answer says ${answer}`,
            },
      );
    } catch {
      checks.push({ name, status: 'not_checked', detail: `Could not evaluate ${calc.expression}` });
    }
  }

  const sigFigs = question.prompt.match(
    /\b(\d|one|two|three|four|five|six)\s+sig(?:nificant)?\.?\s*(?:fig(?:ure)?s?|digits)\b/i,
  )?.[1];
  if (sigFigs) {
    const words = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
    const wanted = /\d/.test(sigFigs) ? Number(sigFigs) : words.indexOf(sigFigs.toLowerCase());
    for (const answer of answers) {
      const field = question.fields.find((f) => f.key === answer.fieldKey);
      const value = answer.values[0];
      if (
        !field ||
        field.options.length > 0 ||
        value === undefined ||
        parseNumericAnswer(value) === null
      )
        continue;
      const count = countSignificantFigures(value);
      checks.push(
        count === wanted
          ? {
              name: `significant figures ${field.key}`,
              status: 'pass',
              detail: `${value} has ${wanted}`,
            }
          : {
              name: `significant figures ${field.key}`,
              status: 'fail',
              detail: `${value} has ${count}, wanted ${wanted}`,
            },
      );
    }
  }

  const answered = new Set(answers.filter((a) => a.values.length > 0).map((a) => a.fieldKey));
  const missing = question.fields.filter((f) => !answered.has(f.key));
  if (missing.length > 0 && !solution.cannotAnswer) {
    checks.push({
      name: 'all fields answered',
      status: 'fail',
      detail: `No answer for ${missing.map((f) => f.key).join(', ')}`,
    });
  }

  let adjustedConfidence = solution.confidence;
  if (checks.some((c) => c.status === 'fail'))
    adjustedConfidence = Math.min(adjustedConfidence, FAIL_CAP);
  if (solution.cannotAnswer) adjustedConfidence = Math.min(adjustedConfidence, ABSTAIN_CAP);
  if (question.images.some((image) => !image.alt)) {
    checks.push({
      name: 'images described',
      status: 'not_checked',
      detail: 'An image has no description, and the model did not see it',
    });
    adjustedConfidence = Math.min(adjustedConfidence, 0.5);
  }

  return { ...solution, answers, checks, adjustedConfidence };
}
