import { z } from 'zod';
import {
  ModelSolutionSchema,
  type ModelSolution,
  type Question,
  type ValidatedSolution,
} from '@sima/shared-types';
import {
  buildBatchPrompt,
  buildBatchSchema,
  buildSolutionSchema,
  buildSolvePrompt,
} from './prompt';
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
  options: { set?: boolean; uniqueChoices?: boolean } = {},
): Promise<ValidatedSolution> {
  const prompt = buildSolvePrompt(question, instructions, { set: options.set ?? false });
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
      const solution = validateSolution(
        question,
        ModelSolutionSchema.parse(normalizeAnswers(raw)),
        {
          instructions,
          uniqueChoices: options.uniqueChoices ?? false,
        },
      );
      if (!best || failures(solution).length < failures(best).length) best = solution;
      const failed = failures(solution);
      if (failed.length === 0) break;
      feedback = `\n\nA previous attempt failed these checks. Correct them:\n- ${failed.join('\n- ')}`;
    } catch (error) {
      lastError = error;
      // Ollama already retried. Asking again only makes an outage or a missing model take longer.
      if ((error as { status?: number } | null)?.status !== undefined) break;
      feedback = '\n\nA previous attempt was unusable. Return only JSON matching the schema.';
    }
  }

  if (best) return best;
  throw lastError instanceof Error ? lastError : new Error('Could not solve');
}

const UNIQUE_CHOICE_MINIMUM = 5;

function sharedChoices(question: Question): string | null {
  const [field] = question.fields;
  if (question.fields.length !== 1 || !field || field.options.length < 2) return null;
  if (field.kind === 'checkbox_group') return null;
  return field.options.map((o) => o.id).join('\u0000');
}

/**
 * Splits questions into what should be solved together. Neighbors offering the identical list of
 * choices form a set, because they can't be answered well without seeing each other.
 */
export function groupForSolving(questions: Question[]): Question[][] {
  const groups: Question[][] = [];
  for (const question of questions) {
    const last = groups[groups.length - 1];
    const lastQuestion = last?.[0];
    const key = sharedChoices(question);
    if (last && lastQuestion && key !== null && key === sharedChoices(lastQuestion)) {
      last.push(question);
    } else {
      groups.push([question]);
    }
  }
  return groups;
}

const MAX_FIELDS_PER_REQUEST = 25;

/**
 * Splits a page's questions into requests, without separating questions that share choices. A
 * large request risks a cut-off reply, so very long pages are sent in more than one.
 */
export function chunkForSolving(questions: Question[]): Question[][] {
  const chunks: Question[][] = [];
  let current: Question[] = [];
  let size = 0;
  for (const group of groupForSolving(questions)) {
    const fields = group.reduce((total, q) => total + q.fields.length, 0);
    if (current.length > 0 && size + fields > MAX_FIELDS_PER_REQUEST) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(...group);
    size += fields;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const BatchReplySchema = z.object({
  steps: z.array(z.string()).default([]),
  calculations: ModelSolutionSchema.shape.calculations.default([]),
  answers: ModelSolutionSchema.shape.answers,
  perQuestion: z
    .array(
      z.object({
        question: z.coerce.string(),
        explanation: z.string().default(''),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .default([]),
  explanation: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
  cannotAnswer: z.boolean().default(false),
});
type BatchReply = z.infer<typeof BatchReplySchema>;

function solutionFor(question: Question, label: number, reply: BatchReply): ModelSolution {
  const keys = new Set(question.fields.map((f) => f.key));
  const mine = reply.perQuestion.find((entry) => entry.question.trim() === String(label));
  const steps = reply.steps.filter((step) => new RegExp(`\\bQuestion ${label}\\b`, 'i').test(step));
  return {
    answers: reply.answers.filter((a) => keys.has(a.fieldKey)),
    calculations: reply.calculations.filter((c) => keys.has(c.fieldKey)),
    steps: steps.length > 0 ? steps : reply.steps,
    explanation: mine?.explanation ?? reply.explanation,
    confidence: mine?.confidence ?? reply.confidence,
    cannotAnswer: reply.cannotAnswer,
  };
}

const UNIQUE_CHECK = 'Each choice used once';

/** Marks choices used twice in a matching set. Returns the IDs of the questions to ask again. */
function checkSets(groups: Question[][], best: Map<string, ValidatedSolution>): Set<string> {
  const retry = new Set<string>();
  for (const group of groups) {
    const choiceCount = group[0]?.fields[0]?.options.length ?? 0;
    // A short list like ser/estar is meant to repeat, but a long one matched 1:1 isn't.
    if (group.length < 2 || choiceCount < UNIQUE_CHOICE_MINIMUM || group.length > choiceCount)
      continue;
    const seen = new Map<string, string>();
    for (const question of group) {
      const solution = best.get(question.id);
      const value = solution?.answers[0]?.values[0];
      if (!solution || value === undefined) continue;
      solution.checks = solution.checks.filter((c) => c.name !== UNIQUE_CHECK);
      const earlier = seen.get(value);
      if (earlier) {
        const label = question.fields[0]?.options.find((o) => o.id === value)?.label ?? value;
        solution.checks.push({
          name: UNIQUE_CHECK,
          status: 'fail',
          detail: `"${label}" is used for both ${earlier} and ${solution.answers[0]?.fieldKey}. Each choice fits one question.`,
        });
        solution.adjustedConfidence = Math.min(solution.adjustedConfidence, 0.35);
        group.forEach((member) => retry.add(member.id));
      } else {
        seen.set(value, solution.answers[0]?.fieldKey ?? '');
      }
    }
  }
  return retry;
}

/**
 * Solves several questions in one request, which is much faster than one each and lets the model
 * see them together. Each answer is still checked against its own question, and only the questions
 * that fail are asked again. Some questions can be missing from the result if the model skips them.
 */
export async function solveBatch(
  questions: Question[],
  instructions: string,
  complete: CompleteFn,
): Promise<Map<string, ValidatedSolution>> {
  const [first] = questions;
  if (!first) return new Map();
  if (questions.length === 1) {
    return new Map([[first.id, await solveQuestion(first, instructions, complete)]]);
  }

  const best = new Map<string, ValidatedSolution>();
  let remaining = questions;
  let feedback = '';
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && remaining.length > 0; attempt++) {
    const prompt = buildBatchPrompt(groupForSolving(remaining), instructions);
    try {
      const raw = await complete(
        { system: prompt.system, user: prompt.user + feedback },
        buildBatchSchema(remaining),
        'submit_answers',
      );
      const reply = BatchReplySchema.parse(normalizeAnswers(raw));
      remaining.forEach((question, index) => {
        const solution = validateSolution(question, solutionFor(question, index + 1, reply), {
          instructions,
        });
        const previous = best.get(question.id);
        if (!previous || failures(solution).length <= failures(previous).length) {
          best.set(question.id, solution);
        }
      });
    } catch (error) {
      lastError = error;
      if ((error as { status?: number } | null)?.status !== undefined) break;
      feedback = '\n\nA previous attempt was unusable. Return only JSON matching the schema.';
      continue;
    }
    const inSets = checkSets(groupForSolving(questions), best);
    const again = questions.filter((question) => {
      const solution = best.get(question.id);
      return !solution || failures(solution).length > 0 || inSets.has(question.id);
    });
    const lines = again.flatMap((question) => failures(best.get(question.id) ?? emptySolution));
    feedback = lines.length
      ? `\n\nA previous attempt failed these checks. Correct them:\n- ${[...new Set(lines)].join('\n- ')}`
      : '';
    remaining = again;
  }

  if (best.size === 0) throw lastError instanceof Error ? lastError : new Error('Could not solve');
  return best;
}

const emptySolution: ValidatedSolution = {
  answers: [],
  calculations: [],
  steps: [],
  explanation: '',
  confidence: 0,
  cannotAnswer: false,
  checks: [],
  adjustedConfidence: 0,
};
