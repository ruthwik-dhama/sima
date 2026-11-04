import { z } from 'zod';
import { ActionResultSchema, BrowserActionSchema } from './actions';
import { ElementTargetSchema, PageAnalysisSchema } from './page';
import { ProviderIdSchema, SettingsSchema } from './settings';

/** Messages from the side panel, options page or floating UI to the background. */
export const UiCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('GET_VIEW'), tabId: z.number() }),
  z.object({ type: z.literal('ANALYZE'), tabId: z.number() }),
  z.object({ type: z.literal('AUTHORIZE_FILL'), taskId: z.string(), authorized: z.boolean() }),
  z.object({
    type: z.literal('SOLVE'),
    taskId: z.string(),
    questionIds: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('EDIT_RESPONSE'),
    recordId: z.string(),
    fieldKey: z.string(),
    values: z.array(z.string()),
  }),
  z.object({ type: z.literal('SET_APPROVED'), recordId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal('CONFIRM_FIELD'), recordId: z.string(), fieldKey: z.string() }),
  z.object({ type: z.literal('ALLOW_OVERWRITE'), recordId: z.string(), fieldKey: z.string() }),
  z.object({ type: z.literal('EXECUTE'), taskId: z.string() }),
  z.object({ type: z.literal('AUTO_FILL'), taskId: z.string() }),
  z.object({ type: z.literal('NAVIGATE_NEXT'), taskId: z.string() }),
  z.object({ type: z.literal('PAUSE'), taskId: z.string() }),
  z.object({ type: z.literal('RESUME'), taskId: z.string() }),
  z.object({ type: z.literal('STOP'), taskId: z.string() }),
  z.object({ type: z.literal('COMPLETE'), taskId: z.string() }),
  z.object({ type: z.literal('RESTART'), taskId: z.string() }),
  z.object({
    type: z.literal('FOLLOW_UP'),
    recordId: z.string(),
    question: z.string().min(1).max(2000),
  }),
  z.object({ type: z.literal('GET_SETTINGS') }),
  z.object({ type: z.literal('SAVE_SETTINGS'), settings: SettingsSchema }),
  z.object({
    type: z.literal('SET_API_KEY'),
    provider: ProviderIdSchema,
    apiKey: z.string().max(500),
  }),
  z.object({ type: z.literal('TEST_PROVIDER'), provider: ProviderIdSchema }),
  z.object({ type: z.literal('ACKNOWLEDGE_PROVIDER'), provider: ProviderIdSchema }),
  z.object({ type: z.literal('DELETE_TASK_DATA') }),
  z.object({ type: z.literal('DELETE_API_KEYS') }),
  z.object({ type: z.literal('OPEN_SIDE_PANEL') }),
  z.object({ type: z.literal('DISMISS_FLOATING') }),
]);
export type UiCommand = z.infer<typeof UiCommandSchema>;

/** Messages from the content script to the background. */
export const ContentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PAGE_READY'), analysis: PageAnalysisSchema }),
  z.object({ type: z.literal('NAVIGATION_TIMEOUT'), fromPageKey: z.string() }),
  z.object({ type: z.literal('GET_FLOATING_STATE') }),
]);
export type ContentEvent = z.infer<typeof ContentEventSchema>;

/** Messages from the background to the content script. */
export const ContentCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ANALYZE_PAGE') }),
  z.object({ type: z.literal('EXECUTE_ACTION'), action: BrowserActionSchema }),
  z.object({ type: z.literal('CHECK_ACTION'), action: BrowserActionSchema }),
  z.object({ type: z.literal('FLOATING_STATE'), state: z.lazy(() => FloatingStateSchema) }),
]);
export type ContentCommand = z.infer<typeof ContentCommandSchema>;

export const FloatingStateSchema = z.object({
  visible: z.boolean(),
  status: z.string(),
  activityTitle: z.string(),
  done: z.number(),
  total: z.number(),
  restricted: z.boolean(),
});
export type FloatingState = z.infer<typeof FloatingStateSchema>;

/** Broadcast to extension pages whenever persisted state changes. */
export const StateChangedSchema = z.object({
  type: z.literal('STATE_CHANGED'),
  taskId: z.string().nullable(),
});

export const ExecuteResponseSchema = ActionResultSchema;
export const AnalyzeResponseSchema = PageAnalysisSchema.nullable();
export { ElementTargetSchema };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
