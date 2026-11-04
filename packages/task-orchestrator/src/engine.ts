import { autoFillHold, buildNavigateAction, buildPlan } from '@sima/action-planner';
import { buildFollowUpPrompt, FOLLOW_UP_JSON_SCHEMA, solveQuestion } from '@sima/reasoning-engine';
import {
  FollowUpResponseSchema,
  type ActionFailure,
  type ActionRecord,
  type ActionResult,
  type BrowserAction,
  type PageAnalysis,
  type QuestionRecord,
  type Task,
  type TaskStatus,
  type TaskView,
} from '@sima/shared-types';
import { assertTransition } from './machine';

const MAX_PASSES = 2;
const RETRYABLE: ActionFailure[] = [
  'target_missing',
  'fingerprint_mismatch',
  'not_persisted',
  'no_response',
];
const IN_FLIGHT: TaskStatus[] = ['analyzing', 'reasoning', 'executing', 'navigating'];
const BUSY: TaskStatus[] = ['reasoning', 'executing', 'navigating'];

/** Persistence port. Every state change is written before Sima acts on it. */
export interface TaskStore {
  getTask(id: string): Promise<Task | undefined>;
  findTask(platformId: string, activityId: string): Promise<Task | undefined>;
  findTaskByTab(tabId: number): Promise<Task | undefined>;
  listInFlight(statuses: TaskStatus[]): Promise<Task[]>;
  putTask(task: Task): Promise<void>;
  getQuestions(taskId: string, pageKey?: string): Promise<QuestionRecord[]>;
  getQuestion(id: string): Promise<QuestionRecord | undefined>;
  putQuestion(record: QuestionRecord): Promise<void>;
  getActions(taskId: string): Promise<ActionRecord[]>;
  getAction(id: string): Promise<ActionRecord | undefined>;
  putAction(record: ActionRecord): Promise<void>;
  getAnalysis(taskId: string, pageKey: string): Promise<PageAnalysis | undefined>;
  putAnalysis(taskId: string, analysis: PageAnalysis): Promise<void>;
}

/** The tab, as seen from the engine. Implemented over chrome.tabs messaging in the background. */
export interface PagePort {
  analyze(tabId: number): Promise<PageAnalysis | null>;
  execute(tabId: number, action: BrowserAction): Promise<ActionResult>;
  check(tabId: number, action: BrowserAction): Promise<ActionResult>;
}

export interface Reasoner {
  /** Returns unvalidated model output: the engine parses it with Zod. */
  complete(
    prompt: { system: string; user: string },
    schema: Readonly<Record<string, unknown>>,
    name: string,
  ): Promise<unknown>;
  /** Throws when the provider is unconfigured or its data disclosure was not acknowledged. */
  assertReady(): Promise<void>;
}

export interface EngineDeps {
  store: TaskStore;
  page: PagePort;
  reasoner: Reasoner;
  now?: () => number;
  newId?: () => string;
  onChange?: (taskId: string) => void;
}

export function hasResponse(record: QuestionRecord): boolean {
  return Object.values(record.responses).some((values) => values.length > 0);
}

export function recordId(taskId: string, pageKey: string, questionId: string): string {
  return `${taskId}|${pageKey}|${questionId}`;
}

export class TaskEngine {
  private readonly store: TaskStore;
  private readonly page: PagePort;
  private readonly reasoner: Reasoner;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onChange: (taskId: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.page = deps.page;
    this.reasoner = deps.reasoner;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.onChange = deps.onChange ?? (() => {});
  }

  private async require(taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    return task;
  }

  /**
   * Commands run concurrently, and each read-modify-write spans several awaits. Every state
   * change goes through this queue and re-reads inside it, so none can overwrite a newer one.
   * It isn't reentrant, and page and model calls must stay outside it, because pause and
   * stop have to get through while those are running.
   */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Only call from inside `locked`. With `onlyFrom`, a task that has since moved on is left alone. */
  private async applyStatus(
    taskId: string,
    status: TaskStatus,
    patch: Partial<Task> = {},
    onlyFrom?: TaskStatus[],
  ): Promise<Task> {
    const current = await this.require(taskId);
    if (onlyFrom && !onlyFrom.includes(current.status)) return current;
    assertTransition(current.status, status);
    const next: Task = { ...current, ...patch, status, updatedAt: this.now() };
    await this.store.putTask(next);
    this.onChange(next.id);
    return next;
  }

  private setStatus(
    task: Task,
    status: TaskStatus,
    patch: Partial<Task> = {},
    onlyFrom?: TaskStatus[],
  ): Promise<Task> {
    return this.locked(() => this.applyStatus(task.id, status, patch, onlyFrom));
  }

  /** Starts a long-running step. Returns null if that step is already running. */
  private claim(taskId: string, status: TaskStatus): Promise<Task | null> {
    return this.locked(async () => {
      const current = await this.require(taskId);
      if (current.status === status) return null;
      return this.applyStatus(taskId, status, { error: null });
    });
  }

  private async updateRecord(
    id: string,
    patch: (record: QuestionRecord) => QuestionRecord,
  ): Promise<void> {
    await this.locked(async () => {
      const record = await this.store.getQuestion(id);
      if (record) await this.store.putQuestion(patch(record));
    });
  }

  private async block(task: Task, analysis?: PageAnalysis): Promise<Task> {
    if (analysis) await this.store.putAnalysis(task.id, analysis);
    return this.setStatus(task, 'blocked_restricted', { resumeStatus: null });
  }

  /**
   * Called whenever a tab reports its page. Finds or creates the activity's task, and
   * completes any navigation that was in flight, including one a dead worker started.
   */
  onPageReady(tabId: number, analysis: PageAnalysis): Promise<Task> {
    return this.locked(() => this.ingestReport(tabId, analysis));
  }

  private async ingestReport(tabId: number, analysis: PageAnalysis): Promise<Task> {
    let task = await this.store.findTask(analysis.platformId, analysis.activity.id);
    if (!task) {
      const now = this.now();
      task = {
        id: this.newId(),
        tabId,
        platformId: analysis.platformId,
        platformName: analysis.platformName,
        activityId: analysis.activity.id,
        activityTitle: analysis.activity.title,
        status: 'analyzing',
        resumeStatus: null,
        fillAuthorizedAt: null,
        currentPageKey: analysis.pageKey,
        pages: [],
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.store.putTask(task);
    } else if (task.tabId !== tabId) {
      task = { ...task, tabId, updatedAt: this.now() };
      await this.store.putTask(task);
    }
    return this.ingest(task, analysis);
  }

  private async settleNavigation(task: Task, analysis: PageAnalysis): Promise<void> {
    const started = (await this.store.getActions(task.id)).filter(
      (a) => a.action.type === 'navigate_next' && a.status === 'started',
    );
    for (const record of started) {
      const moved =
        record.action.type === 'navigate_next' && record.action.fromPageKey !== analysis.pageKey;
      await this.store.putAction({
        ...record,
        status: moved ? 'verified' : 'failed',
        updatedAt: this.now(),
        result: {
          actionId: record.id,
          status: moved ? 'verified' : 'failed',
          alreadyApplied: false,
          observed: analysis.pageKey,
          failure: moved ? null : 'not_persisted',
          detail: moved ? `Arrived at ${analysis.pageKey}` : 'The page did not change',
        },
      });
    }
  }

  private async ingest(task: Task, analysis: PageAnalysis): Promise<Task> {
    await this.settleNavigation(task, analysis);
    await this.store.putAnalysis(task.id, analysis);

    const pages = task.pages.some((p) => p.pageKey === analysis.pageKey)
      ? task.pages
      : [
          ...task.pages,
          {
            pageKey: analysis.pageKey,
            index: analysis.pagination.index,
            total: analysis.pagination.total,
          },
        ];
    const patch = {
      currentPageKey: analysis.pageKey,
      pages,
      activityTitle: analysis.activity.title,
      error: null,
    };

    if (analysis.restriction.status === 'restricted') {
      return this.applyStatus(task.id, 'blocked_restricted', { ...patch, resumeStatus: null });
    }

    let anySolved = false;
    for (const question of analysis.questions) {
      const id = recordId(task.id, analysis.pageKey, question.id);
      const existing = await this.store.getQuestion(id);
      anySolved ||= existing?.solution != null;
      await this.store.putQuestion(
        existing
          ? { ...existing, question }
          : {
              id,
              taskId: task.id,
              pageKey: analysis.pageKey,
              question,
              solution: null,
              solveError: null,
              responses: {},
              approved: false,
              confirmedFields: [],
              overwriteFields: [],
              followUps: [],
            },
      );
    }

    // A pause, stop or completion belongs to the user: a reload or re-scan must not undo it.
    if (task.status === 'paused' || task.status === 'stopped' || task.status === 'completed') {
      const saved: Task = { ...task, ...patch, updatedAt: this.now() };
      await this.store.putTask(saved);
      this.onChange(saved.id);
      return saved;
    }
    await this.applyStatus(task.id, 'analyzing', patch);
    return this.applyStatus(task.id, anySolved ? 'review' : 'ready');
  }

  /** Re-scan a tab on request. Leaves a running step alone: opening the panel must not abort it. */
  async analyze(tabId: number): Promise<Task | null> {
    const current = await this.store.findTaskByTab(tabId);
    if (current && BUSY.includes(current.status)) return current;
    const analysis = await this.page.analyze(tabId);
    if (!analysis) return null;
    return this.onPageReady(tabId, analysis);
  }

  /** The tab closed or left the activity. Saved work stays, attached to no tab. */
  async detachTab(tabId: number): Promise<void> {
    const taskId = await this.locked(async () => {
      const task = await this.store.findTaskByTab(tabId);
      if (!task) return null;
      await this.store.putTask({ ...task, tabId: null, updatedAt: this.now() });
      return task.id;
    });
    if (taskId) this.onChange(taskId);
  }

  /** Reopens a stopped or finished task, keeping its saved work. */
  async restart(taskId: string): Promise<void> {
    const task = await this.require(taskId);
    const next = await this.setStatus(task, 'analyzing', { error: null });
    if (next.tabId !== null) await this.analyze(next.tabId);
  }

  async authorizeFill(taskId: string, authorized: boolean): Promise<void> {
    await this.locked(async () => {
      const task = await this.require(taskId);
      await this.store.putTask({
        ...task,
        fillAuthorizedAt: authorized ? this.now() : null,
        updatedAt: this.now(),
      });
    });
    this.onChange(taskId);
  }

  async solve(taskId: string, questionIds?: string[]): Promise<void> {
    let task = await this.require(taskId);
    if (task.status === 'blocked_restricted')
      throw new Error('This activity is restricted, so Sima will not reason about it.');
    await this.reasoner.assertReady();
    const analysis = await this.store.getAnalysis(taskId, task.currentPageKey);
    const records = await this.store.getQuestions(taskId, task.currentPageKey);
    if (!(await this.claim(taskId, 'reasoning'))) return;

    for (const record of records) {
      if (questionIds && !questionIds.includes(record.question.id)) continue;
      // A saved solution with no answer isn't finished, so it gets another try.
      if (!questionIds && hasResponse(record)) continue;
      // Reload each time so pause and stop take effect between questions.
      task = await this.require(taskId);
      if (task.status !== 'reasoning') return;
      await this.solveOne(record, analysis?.instructions ?? '');
    }
    await this.setStatus(task, 'review', {}, ['reasoning']);
  }

  private async solveOne(record: QuestionRecord, instructions: string): Promise<void> {
    try {
      const solution = await solveQuestion(record.question, instructions, (prompt, schema, name) =>
        this.reasoner.complete(prompt, schema, name),
      );
      const responses = Object.fromEntries(solution.answers.map((a) => [a.fieldKey, a.values]));
      // A new answer needs fresh approval. Anything else the user did meanwhile is kept.
      await this.updateRecord(record.id, (latest) => ({
        ...latest,
        solution,
        solveError: null,
        responses,
        approved: false,
      }));
    } catch (error) {
      const solveError = error instanceof Error ? error.message : 'Could not solve';
      await this.updateRecord(record.id, (latest) => ({ ...latest, solveError }));
    }
    this.onChange(record.taskId);
  }

  /**
   * One click: solve what's unsolved, approve what passed every check, and enter it. Questions
   * that didn't pass stay unapproved for the user. Still needs the activity's authorization.
   */
  async autoFill(taskId: string): Promise<void> {
    const task = await this.require(taskId);
    if (task.status === 'blocked_restricted') {
      throw new Error('This activity is restricted, so Sima will not fill it.');
    }
    if (!task.fillAuthorizedAt) {
      throw new Error('Confirm that this activity permits automated assistance before filling.');
    }
    await this.solve(taskId);
    if ((await this.require(taskId)).status !== 'review') return;
    for (const record of await this.store.getQuestions(taskId, task.currentPageKey)) {
      if (autoFillHold(record) === null) {
        await this.updateRecord(record.id, (latest) => ({ ...latest, approved: true }));
      }
    }
    this.onChange(taskId);
    await this.execute(taskId);
  }

  async followUp(id: string, question: string): Promise<void> {
    const record = await this.store.getQuestion(id);
    if (!record) throw new Error('Question not found');
    const task = await this.require(record.taskId);
    if (task.status === 'blocked_restricted') throw new Error('This activity is restricted.');
    await this.reasoner.assertReady();
    const raw = await this.reasoner.complete(
      buildFollowUpPrompt(record.question, record.solution?.explanation ?? '', question),
      FOLLOW_UP_JSON_SCHEMA,
      'submit_answer',
    );
    const { answer } = FollowUpResponseSchema.parse(raw);
    await this.updateRecord(id, (latest) => ({
      ...latest,
      followUps: [...latest.followUps, { question, answer, at: this.now() }],
    }));
    this.onChange(record.taskId);
  }

  private async patchRecord(
    id: string,
    patch: (r: QuestionRecord) => QuestionRecord,
  ): Promise<void> {
    const record = await this.store.getQuestion(id);
    if (!record) throw new Error('Question not found');
    await this.updateRecord(id, patch);
    this.onChange(record.taskId);
  }

  editResponse(id: string, fieldKey: string, values: string[]): Promise<void> {
    return this.patchRecord(id, (r) => ({
      ...r,
      responses: { ...r.responses, [fieldKey]: values },
    }));
  }

  setApproved(id: string, approved: boolean): Promise<void> {
    return this.patchRecord(id, (r) => ({ ...r, approved }));
  }

  confirmField(id: string, fieldKey: string): Promise<void> {
    return this.patchRecord(id, (r) => ({
      ...r,
      confirmedFields: [...new Set([...r.confirmedFields, fieldKey])],
    }));
  }

  allowOverwrite(id: string, fieldKey: string): Promise<void> {
    return this.patchRecord(id, (r) => ({
      ...r,
      overwriteFields: [...new Set([...r.overwriteFields, fieldKey])],
    }));
  }

  /** Runs the approved plan for the current page. Safe to call again after any interruption. */
  async execute(taskId: string): Promise<void> {
    const task = await this.require(taskId);
    if (task.status === 'blocked_restricted')
      throw new Error('This activity is restricted, so Sima will not fill it.');
    if (!task.fillAuthorizedAt)
      throw new Error('Confirm that this activity permits automated assistance before filling.');
    if (task.tabId === null) throw new Error('The activity is not open in a tab.');
    const tabId = task.tabId;
    if (!(await this.claim(taskId, 'executing'))) return;

    // Plan from the page as it is now, so a stale read can't make a lost value look entered.
    const initial = await this.page.analyze(tabId);
    if (initial?.restriction.status === 'restricted') {
      await this.block(task, initial);
      return;
    }
    if (initial?.pageKey === task.currentPageKey) await this.refreshFields(taskId, initial);

    // At most two passes. The second only runs for failures a fresh read of the page can fix.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const records = await this.store.getQuestions(taskId, task.currentPageKey);
      const { actions } = buildPlan(
        taskId,
        records.filter((r) => r.approved),
      );
      const outcome = await this.runActions(taskId, tabId, task.currentPageKey, actions);
      if (outcome === 'interrupted') return;
      const analysis = await this.page.analyze(tabId);
      if (analysis?.restriction.status === 'restricted') {
        await this.block(task, analysis);
        return;
      }
      if (analysis?.pageKey === task.currentPageKey) await this.refreshFields(taskId, analysis);
      if (outcome !== 'retryable') break;
    }

    await this.setStatus(task, 'review', {}, ['executing']);
  }

  private async refreshFields(taskId: string, analysis: PageAnalysis): Promise<void> {
    await this.store.putAnalysis(taskId, analysis);
    for (const question of analysis.questions) {
      await this.updateRecord(recordId(taskId, analysis.pageKey, question.id), (latest) => ({
        ...latest,
        question,
      }));
    }
    this.onChange(taskId);
  }

  private async runActions(
    taskId: string,
    tabId: number,
    pageKey: string,
    actions: BrowserAction[],
  ): Promise<'done' | 'retryable' | 'failed' | 'interrupted'> {
    let retryable = false;
    let failed = false;
    for (const action of actions) {
      const task = await this.require(taskId);
      if (task.status !== 'executing') return 'interrupted';

      // Any journal entry means this exact action ran or may have run: look before acting.
      const journal = await this.store.getAction(action.id);
      if (journal) {
        const check = await this.safely(() => this.page.check(tabId, action), action);
        if (check.status === 'verified') {
          await this.record(action, taskId, pageKey, check, journal.attempts);
          continue;
        }
      }

      const attempts = (journal?.attempts ?? 0) + 1;
      await this.store.putAction({
        id: action.id,
        taskId,
        pageKey,
        action,
        status: 'started',
        attempts,
        result: null,
        updatedAt: this.now(),
      });
      const result = await this.safely(() => this.page.execute(tabId, action), action);
      await this.record(action, taskId, pageKey, result, attempts);
      if (result.failure === 'restricted_page') {
        await this.block(await this.require(taskId));
        return 'interrupted';
      }
      if (result.failure) {
        if (RETRYABLE.includes(result.failure)) retryable = true;
        else failed = true;
      }
      this.onChange(taskId);
    }
    if (retryable) return 'retryable';
    return failed ? 'failed' : 'done';
  }

  private async safely(
    call: () => Promise<ActionResult>,
    action: BrowserAction,
  ): Promise<ActionResult> {
    try {
      return await call();
    } catch (error) {
      return {
        actionId: action.id,
        status: 'failed',
        alreadyApplied: false,
        observed: null,
        failure: 'no_response',
        detail: error instanceof Error ? error.message : 'The page did not respond',
      };
    }
  }

  private async record(
    action: BrowserAction,
    taskId: string,
    pageKey: string,
    result: ActionResult,
    attempts: number,
  ): Promise<void> {
    await this.store.putAction({
      id: action.id,
      taskId,
      pageKey,
      action,
      status: result.status === 'failed' ? 'failed' : 'verified',
      attempts,
      result,
      updatedAt: this.now(),
    });
  }

  /** Moves to the next page of the activity. Only ever on the user's request. */
  async navigateNext(taskId: string): Promise<void> {
    const task = await this.require(taskId);
    if (task.tabId === null) throw new Error('The activity is not open in a tab.');
    const analysis = await this.store.getAnalysis(taskId, task.currentPageKey);
    if (!analysis?.next) throw new Error('This page has no next-page control Sima may use.');
    const action = buildNavigateAction(taskId, task.currentPageKey, analysis.next);
    if (!(await this.claim(taskId, 'navigating'))) return;
    const journal = await this.store.getAction(action.id);
    await this.store.putAction({
      id: action.id,
      taskId,
      pageKey: task.currentPageKey,
      action,
      status: 'started',
      attempts: (journal?.attempts ?? 0) + 1,
      result: null,
      updatedAt: this.now(),
    });
    const result = await this.safely(() => this.page.execute(task.tabId as number, action), action);
    // A dropped channel here can be the page unloading, so wait for PAGE_READY or the timeout.
    if (result.status === 'failed' && result.failure !== 'no_response') {
      await this.record(action, taskId, task.currentPageKey, result, (journal?.attempts ?? 0) + 1);
      await this.setStatus(task, 'review', { error: result.detail }, ['navigating']);
    }
  }

  async onNavigationTimeout(tabId: number): Promise<void> {
    const task = await this.store.findTaskByTab(tabId);
    if (task?.status !== 'navigating') return;
    const analysis = await this.store.getAnalysis(task.id, task.currentPageKey);
    if (analysis) await this.settleNavigation(task, analysis);
    await this.setStatus(
      task,
      'review',
      { error: 'The next page did not load. Nothing was retried.' },
      ['navigating'],
    );
  }

  async pause(taskId: string): Promise<void> {
    await this.locked(async () => {
      const task = await this.require(taskId);
      if (task.status === 'paused') return;
      await this.applyStatus(taskId, 'paused', {
        resumeStatus:
          IN_FLIGHT.includes(task.status) || task.status === 'review' || task.status === 'ready'
            ? task.status
            : 'review',
      });
    });
  }

  async resume(taskId: string): Promise<void> {
    const task = await this.require(taskId);
    if (task.status !== 'paused') return;
    const target = task.resumeStatus ?? 'review';
    if (target === 'executing') {
      await this.setStatus(task, 'review', { resumeStatus: null });
      await this.execute(taskId);
    } else if (target === 'reasoning') {
      await this.setStatus(task, 'ready', { resumeStatus: null });
      await this.solve(taskId);
    } else if (target === 'analyzing' || target === 'navigating') {
      const next = await this.setStatus(task, 'analyzing', { resumeStatus: null });
      if (next.tabId !== null) await this.analyze(next.tabId);
    } else {
      await this.setStatus(task, target, { resumeStatus: null });
    }
  }

  async stop(taskId: string): Promise<void> {
    await this.setStatus(await this.require(taskId), 'stopped', { resumeStatus: null });
  }

  async complete(taskId: string): Promise<void> {
    await this.setStatus(await this.require(taskId), 'completed');
  }

  /**
   * Run on every service-worker start. A status still in flight means the previous worker
   * died mid-step, since the status is written before the step starts and cleared after.
   */
  async recover(): Promise<void> {
    for (const task of await this.store.listInFlight(IN_FLIGHT)) {
      if (task.status === 'executing') {
        // execute() checks any `started` action against the page before acting.
        const next = await this.setStatus(task, 'review', { error: null });
        await this.execute(next.id).catch(async (error: unknown) => {
          const latest = await this.require(next.id);
          await this.setStatus(latest, 'review', {
            error: error instanceof Error ? error.message : 'Recovery failed',
          });
        });
      } else if (task.status === 'reasoning') {
        await this.setStatus(task, 'review');
      } else if (task.status === 'analyzing' && task.tabId !== null) {
        await this.analyze(task.tabId).catch(() => undefined);
      }
      // A navigating task waits for PAGE_READY or NAVIGATION_TIMEOUT from the tab.
    }
  }

  async view(tabId: number): Promise<TaskView> {
    const task = (await this.store.findTaskByTab(tabId)) ?? null;
    if (!task)
      return {
        task: null,
        analysis: null,
        questions: [],
        actions: [],
        plan: { actions: [], blockers: [] },
        progress: { answered: 0, total: 0 },
      };
    const analysis = (await this.store.getAnalysis(task.id, task.currentPageKey)) ?? null;
    const questions = await this.store.getQuestions(task.id, task.currentPageKey);
    const plan = buildPlan(task.id, questions);
    const actions = await this.store.getActions(task.id);
    const all = await this.store.getQuestions(task.id);
    const answered = all.filter(
      (r) =>
        r.question.fields.length > 0 && r.question.fields.every((f) => f.currentValues.length > 0),
    ).length;
    return { task, analysis, questions, actions, plan, progress: { answered, total: all.length } };
  }
}
