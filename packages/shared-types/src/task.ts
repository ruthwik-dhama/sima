import { z } from 'zod';
import { BrowserActionSchema, ActionResultSchema } from './actions';
import { PageAnalysisSchema, QuestionSchema } from './page';
import { ValidatedSolutionSchema } from './solution';

export const TaskStatusSchema = z.enum([
  'analyzing',
  'blocked_restricted',
  'ready',
  'reasoning',
  'review',
  'executing',
  'navigating',
  'paused',
  'completed',
  'stopped',
  'error',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  tabId: z.number().nullable(),
  platformId: z.string(),
  platformName: z.string(),
  activityId: z.string(),
  activityTitle: z.string(),
  status: TaskStatusSchema,
  /** Status to return to on resume; set only while paused. */
  resumeStatus: TaskStatusSchema.nullable(),
  /** Set when the user confirmed their instructor permits automated filling for this activity. */
  fillAuthorizedAt: z.number().nullable(),
  currentPageKey: z.string(),
  pages: z.array(z.object({ pageKey: z.string(), index: z.number(), total: z.number() })),
  error: z.string().nullable(),
  /** What the current step is doing, shown while it runs. */
  activityNote: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const FollowUpSchema = z.object({
  question: z.string(),
  answer: z.string(),
  at: z.number(),
});

export const QuestionRecordSchema = z.object({
  /** taskId|pageKey|questionId */
  id: z.string(),
  taskId: z.string(),
  pageKey: z.string(),
  question: QuestionSchema,
  solution: ValidatedSolutionSchema.nullable(),
  solveError: z.string().nullable(),
  /** The response that will be entered, keyed by field key. Editable by the user. */
  responses: z.record(z.string(), z.array(z.string())),
  approved: z.boolean(),
  /** Field keys whose uncertain mapping the user confirmed. */
  confirmedFields: z.array(z.string()),
  /** Field keys the user allowed Sima to overwrite. */
  overwriteFields: z.array(z.string()),
  followUps: z.array(FollowUpSchema),
});
export type QuestionRecord = z.infer<typeof QuestionRecordSchema>;

export const ActionRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  pageKey: z.string(),
  action: BrowserActionSchema,
  status: z.enum(['started', 'verified', 'failed']),
  attempts: z.number().int(),
  result: ActionResultSchema.nullable(),
  updatedAt: z.number(),
});
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const PlanBlockerSchema = z.object({
  questionId: z.string(),
  fieldKey: z.string().nullable(),
  code: z.enum([
    'not_approved',
    'no_response',
    'low_mapping_confidence',
    'existing_value',
    'unknown_option',
    'multiple_values',
  ]),
  message: z.string(),
});
export type PlanBlocker = z.infer<typeof PlanBlockerSchema>;

/** Everything the UI needs to render a tab's state. */
export const TaskViewSchema = z.object({
  task: TaskSchema.nullable(),
  analysis: PageAnalysisSchema.nullable(),
  questions: z.array(QuestionRecordSchema),
  actions: z.array(ActionRecordSchema),
  plan: z.object({ actions: z.array(BrowserActionSchema), blockers: z.array(PlanBlockerSchema) }),
  progress: z.object({ answered: z.number(), total: z.number() }),
});
export type TaskView = z.infer<typeof TaskViewSchema>;
