import { z } from 'zod';

export const ModelSolutionSchema = z.object({
  answers: z.array(z.object({ fieldKey: z.string(), values: z.array(z.string()) })),
  explanation: z.string(),
  steps: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  /** Arithmetic whose result should equal a numeric answer. Empty when not applicable. */
  calculations: z.array(z.object({ fieldKey: z.string(), expression: z.string() })),
  /** True when the question cannot be answered from the supplied material. */
  cannotAnswer: z.boolean(),
});
export type ModelSolution = z.infer<typeof ModelSolutionSchema>;

export const CheckResultSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'not_checked']),
  detail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ValidatedSolutionSchema = ModelSolutionSchema.extend({
  checks: z.array(CheckResultSchema),
  /** Model confidence capped by the outcome of the checks. */
  adjustedConfidence: z.number().min(0).max(1),
});
export type ValidatedSolution = z.infer<typeof ValidatedSolutionSchema>;

export const FollowUpResponseSchema = z.object({ answer: z.string() });
