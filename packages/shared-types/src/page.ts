import { z } from 'zod';

/** Explicit reference to a DOM element. The fingerprint detects a selector now pointing elsewhere. */
export const ElementTargetSchema = z.object({
  selector: z.string().min(1).max(1000),
  fingerprint: z.object({
    tag: z.string(),
    inputType: z.string().optional(),
    name: z.string().optional(),
  }),
});
export type ElementTarget = z.infer<typeof ElementTargetSchema>;

export const FieldKindSchema = z.enum([
  'text',
  'textarea',
  'contenteditable',
  'select',
  'radio_group',
  'checkbox_group',
]);
export type FieldKind = z.infer<typeof FieldKindSchema>;

export const FieldOptionSchema = z.object({
  /** Select option value, or the stable id of a radio/checkbox within its group. */
  id: z.string(),
  label: z.string(),
  /** Radio/checkbox input for this option. Absent for <select> options. */
  target: ElementTargetSchema.optional(),
});
export type FieldOption = z.infer<typeof FieldOptionSchema>;

export const AnswerFieldSchema = z.object({
  key: z.string().min(1),
  kind: FieldKindSchema,
  label: z.string(),
  /** The input itself. For radio/checkbox groups, the first option's input. */
  target: ElementTargetSchema,
  options: z.array(FieldOptionSchema),
  /** Text value, or the ids of the selected options. */
  currentValues: z.array(z.string()),
  mappingConfidence: z.number().min(0).max(1),
  mappingReason: z.string(),
});
export type AnswerField = z.infer<typeof AnswerFieldSchema>;

export const QuestionFormatSchema = z.enum([
  'multiple_choice',
  'multi_select',
  'short_answer',
  'numeric',
  'matching',
  'dropdown',
  'written',
  'mixed',
]);
export type QuestionFormat = z.infer<typeof QuestionFormatSchema>;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  pageKey: z.string(),
  number: z.string(),
  prompt: z.string(),
  format: QuestionFormatSchema,
  tables: z.array(z.array(z.array(z.string()))),
  images: z.array(z.object({ src: z.string(), alt: z.string() })),
  fields: z.array(AnswerFieldSchema),
  /** Visible text resembling instructions aimed at an AI. Never treated as instructions. */
  suspiciousText: z.array(z.string()),
});
export type Question = z.infer<typeof QuestionSchema>;

export const RestrictionSignalSchema = z.object({
  code: z.enum([
    'assessment_title',
    'proctoring',
    'lockdown_browser',
    'timed_assessment',
    'ai_prohibited',
    'platform_marker',
  ]),
  evidence: z.string(),
});
export type RestrictionSignal = z.infer<typeof RestrictionSignalSchema>;

export const RestrictionSchema = z.object({
  status: z.enum(['none_detected', 'restricted']),
  signals: z.array(RestrictionSignalSchema),
});
export type Restriction = z.infer<typeof RestrictionSchema>;

export const PageTypeSchema = z.enum(['activity', 'assessment', 'other']);
export type PageType = z.infer<typeof PageTypeSchema>;

export const NavigationControlSchema = z.object({
  target: ElementTargetSchema,
  label: z.string(),
});
export type NavigationControl = z.infer<typeof NavigationControlSchema>;

export const PageAnalysisSchema = z.object({
  platformId: z.string(),
  platformName: z.string(),
  compatibility: z.enum(['mock_only', 'verified_live']),
  pageKey: z.string(),
  pageType: PageTypeSchema,
  activity: z.object({ id: z.string(), title: z.string() }),
  pagination: z.object({ index: z.number().int().min(1), total: z.number().int().min(1) }),
  instructions: z.string(),
  restriction: RestrictionSchema,
  questions: z.array(QuestionSchema),
  next: NavigationControlSchema.nullable(),
  warnings: z.array(z.string()),
});
export type PageAnalysis = z.infer<typeof PageAnalysisSchema>;
