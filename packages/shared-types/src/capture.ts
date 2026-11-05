import { z } from 'zod';

export interface CaptureNode {
  tag: string;
  id?: string;
  classes?: string[];
  role?: string;
  type?: string;
  name?: string;
  for?: string;
  /** data-* attribute names. Their values are dropped, apart from true and false. */
  data?: Record<string, string | null>;
  /** Attributes that exist on the element. Their values are never kept. */
  has?: string[];
  /** Rough length of the element's own text. The text itself is never kept. */
  text?: 'short' | 'medium' | 'long';
  /** Set only when the whole label is a known control word, such as Next or Submit. */
  uiLabel?: string;
  hidden?: boolean;
  disabled?: boolean;
  optionCount?: number;
  /** Contents not recorded: scripts, styles, math and drawings. */
  opaque?: boolean;
  frame?: 'same-origin' | 'cross-origin';
  frameHost?: string;
  shadowRoot?: boolean;
  children?: CaptureNode[];
}

const CaptureNodeSchema: z.ZodType<CaptureNode> = z.lazy(() =>
  z.object({
    tag: z.string(),
    id: z.string().optional(),
    classes: z.array(z.string()).optional(),
    role: z.string().optional(),
    type: z.string().optional(),
    name: z.string().optional(),
    for: z.string().optional(),
    data: z.record(z.string(), z.string().nullable()).optional(),
    has: z.array(z.string()).optional(),
    text: z.enum(['short', 'medium', 'long']).optional(),
    uiLabel: z.string().optional(),
    hidden: z.boolean().optional(),
    disabled: z.boolean().optional(),
    optionCount: z.number().optional(),
    opaque: z.boolean().optional(),
    frame: z.enum(['same-origin', 'cross-origin']).optional(),
    frameHost: z.string().optional(),
    shadowRoot: z.boolean().optional(),
    children: z.array(CaptureNodeSchema).optional(),
  }),
);

export const PageCaptureSchema = z.object({
  format: z.literal('sima-page-capture-1'),
  platformId: z.string(),
  host: z.string(),
  /** The path with numbers and anything name-like replaced. */
  path: z.string(),
  capturedOn: z.string(),
  recognizedBySima: z.boolean(),
  truncated: z.boolean(),
  counts: z.record(z.string(), z.number()),
  body: CaptureNodeSchema,
});
export type PageCapture = z.infer<typeof PageCaptureSchema>;

export const CaptureResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), capture: PageCaptureSchema }),
  z.object({ status: z.literal('refused'), reason: z.string() }),
]);
export type CaptureResult = z.infer<typeof CaptureResultSchema>;
