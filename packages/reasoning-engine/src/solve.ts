import { ModelSolutionSchema, type Question, type ValidatedSolution } from '@sima/shared-types';
import { buildSolutionSchema, buildSolvePrompt } from './prompt';
import { validateSolution } from './validate';

export type CompleteFn = (
  prompt: { system: string; user: string },
  schema: Readonly<Record<string, unknown>>,
  name: string,
) => Promise<unknown>;

const MAX_ATTEMPTS = 2;

function failures(solution: ValidatedSolution): string[] {
  return solution.checks.filter((c) => c.status === 'fail').map((c) => c.detail);
}

/** The per-question schema returns answers keyed by field. The rest of Sima uses a list. */
function normalizeAnswers(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const { answers } = raw as { answers?: unknown };
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return raw;
  return {
    ...raw,
    answers: Object.entries(answers).map(([fieldKey, values]) => ({ fieldKey, values })),
  };
}

/**
 * Solves one question. If the output is unusable or fails a check, it asks once more with the
 * failures spelled out, and keeps whichever attempt failed fewer checks.
 */
export async function solveQuestion(
  question: Question,
  instructions: string,
  complete: CompleteFn,
): Promise<ValidatedSolution> {
  const prompt = buildSolvePrompt(question, instructions);
  const schema = buildSolutionSchema(question);
  let best: ValidatedSolution | null = null;
  let lastError: unknown = null;
  let feedback = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await complete(
        { system: prompt.system, user: prompt.user + feedback },
        schema,
        'submit_solution',
      );
      const solution = validateSolution(question, ModelSolutionSchema.parse(normalizeAnswers(raw)));
      if (!best || failures(solution).length < failures(best).length) best = solution;
      const failed = failures(solution);
      if (failed.length === 0) break;
      feedback = `\n\nA previous attempt failed these checks. Correct them:\n- ${failed.join('\n- ')}`;
    } catch (error) {
      lastError = error;
      feedback = '\n\nA previous attempt was unusable. Return only JSON matching the schema.';
    }
  }

  if (best) return best;
  throw lastError instanceof Error ? lastError : new Error('Could not solve');
}
