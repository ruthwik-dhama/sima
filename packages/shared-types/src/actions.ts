import { z } from 'zod';
import { ElementTargetSchema } from './page';

const Base = z.object({
  /** Deterministic idempotency key: same task, field and value yield the same id. */
  id: z.string().min(1),
  questionId: z.string(),
  fieldKey: z.string(),
  target: ElementTargetSchema,
});

/**
 * The complete vocabulary of things Sima may do in a page. There is deliberately no
 * submit action and no script or eval action: submission always stays with the user.
 */
export const BrowserActionSchema = z.discriminatedUnion('type', [
  Base.extend({ type: z.literal('fill_text'), value: z.string().max(20000) }),
  Base.extend({ type: z.literal('select_option'), optionValue: z.string() }),
  Base.extend({ type: z.literal('select_radio'), optionId: z.string() }),
  Base.extend({ type: z.literal('set_checkbox'), optionId: z.string(), checked: z.boolean() }),
  Base.extend({
    type: z.literal('navigate_next'),
    label: z.string(),
    fromPageKey: z.string(),
  }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

export const ActionFailureSchema = z.enum([
  'target_missing',
  'fingerprint_mismatch',
  'target_disabled',
  'not_persisted',
  'option_missing',
  'restricted_page',
  'forbidden_navigation',
  'no_response',
]);
export type ActionFailure = z.infer<typeof ActionFailureSchema>;

export const ActionResultSchema = z.object({
  actionId: z.string(),
  status: z.enum(['verified', 'failed', 'dispatched']),
  alreadyApplied: z.boolean(),
  observed: z.string().nullable(),
  failure: ActionFailureSchema.nullable(),
  detail: z.string(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;
