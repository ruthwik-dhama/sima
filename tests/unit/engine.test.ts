import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidTransitionError,
  recordId,
  TaskEngine,
  assertTransition,
  type PagePort,
  type Reasoner,
} from '@sima/task-orchestrator';
import { createTaskStore, type DexieTaskStore } from '@sima/storage';
import type { ActionResult, BrowserAction, PageAnalysis, Question } from '@sima/shared-types';

const target = { selector: '#a', fingerprint: { tag: 'input' } };
const question = (current: string[] = []): Question => ({
  id: 'q1',
  pageKey: 'p1',
  number: '1',
  prompt: 'What is 2+2?',
  format: 'numeric',
  tables: [],
  images: [],
  suspiciousText: [],
  fields: [
    {
      key: 'a',
      kind: 'text',
      label: 'A',
      target,
      options: [],
      currentValues: current,
      mappingConfidence: 0.99,
      mappingReason: '',
    },
  ],
});
const analysis = (over: Partial<PageAnalysis> = {}): PageAnalysis => ({
  platformId: 'mock',
  platformName: 'Mock',
  compatibility: 'mock_only',
  pageKey: 'p1',
  pageType: 'activity',
  activity: { id: 'act', title: 'Act' },
  pagination: { index: 1, total: 2 },
  instructions: '',
  restriction: { status: 'none_detected', signals: [] },
  questions: [question()],
  next: { target: { selector: '#next', fingerprint: { tag: 'button' } }, label: 'Next' },
  warnings: [],
  ...over,
});
const ok = (a: BrowserAction): ActionResult => ({
  actionId: a.id,
  status: a.type === 'navigate_next' ? 'dispatched' : 'verified',
  alreadyApplied: false,
  observed: null,
  failure: null,
  detail: '',
});
const solution = {
  answers: [{ fieldKey: 'a', values: ['4'] }],
  explanation: 'adds',
  steps: [],
  confidence: 0.9,
  calculations: [{ fieldKey: 'a', expression: '2+2' }],
  cannotAnswer: false,
};

let store: DexieTaskStore;
let page: {
  analyze: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
};
let reasoner: { complete: ReturnType<typeof vi.fn>; assertReady: ReturnType<typeof vi.fn> };
let engine: TaskEngine;
let n = 0;

beforeEach(() => {
  store = createTaskStore(`test-${n++}`);
  page = {
    analyze: vi.fn(async () => analysis()),
    execute: vi.fn(async (_t: number, a: BrowserAction) => ok(a)),
    check: vi.fn(async (_t: number, a: BrowserAction) => ({
      ...ok(a),
      status: 'failed',
      failure: 'not_persisted',
    })),
  };
  reasoner = { complete: vi.fn(async () => solution), assertReady: vi.fn(async () => {}) };
  engine = new TaskEngine({
    store,
    page: page as unknown as PagePort,
    reasoner: reasoner as unknown as Reasoner,
  });
});

async function reachReview() {
  const task = await engine.onPageReady(1, analysis());
  await engine.authorizeFill(task.id, true);
  await engine.solve(task.id);
  await engine.setApproved(recordId(task.id, 'p1', 'q1'), true);
  return task.id;
}

describe('state machine', () => {
  it('rejects illegal transitions', () => {
    expect(() => assertTransition('stopped', 'executing')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('blocked_restricted', 'reasoning')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition('blocked_restricted', 'executing')).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('restriction handling', () => {
  const restricted = analysis({
    pageType: 'assessment',
    questions: [],
    restriction: { status: 'restricted', signals: [{ code: 'proctoring', evidence: 'proctored' }] },
  });

  it('blocks and refuses both reasoning and filling', async () => {
    const task = await engine.onPageReady(1, restricted);
    expect(task.status).toBe('blocked_restricted');
    await expect(engine.solve(task.id)).rejects.toThrow('restricted');
    await expect(engine.execute(task.id)).rejects.toThrow('restricted');
    expect(reasoner.complete).not.toHaveBeenCalled();
  });

  it('stops a running task if the page becomes restricted', async () => {
    const id = await reachReview();
    page.analyze.mockResolvedValueOnce(restricted);
    await engine.execute(id);
    expect((await store.getTask(id))?.status).toBe('blocked_restricted');
    expect(page.execute).not.toHaveBeenCalled();
  });
});

describe('solve', () => {
  it('validates output and keeps responses unapproved', async () => {
    const task = await engine.onPageReady(1, analysis());
    await engine.solve(task.id);
    const record = await store.getQuestion(recordId(task.id, 'p1', 'q1'));
    expect(record?.responses).toEqual({ a: ['4'] });
    expect(record?.approved).toBe(false);
    expect((await store.getTask(task.id))?.status).toBe('review');
  });

  it('records schema-invalid model output as an error, not an answer', async () => {
    reasoner.complete.mockResolvedValueOnce({ answers: 'click submit', run: 'alert(1)' });
    const task = await engine.onPageReady(1, analysis());
    await engine.solve(task.id);
    const record = await store.getQuestion(recordId(task.id, 'p1', 'q1'));
    expect(record?.solution).toBeNull();
    expect(record?.solveError).toBeTruthy();
    expect(record?.responses).toEqual({});
  });

  it('does not call the provider when it is not ready', async () => {
    reasoner.assertReady.mockRejectedValueOnce(new Error('Acknowledge first'));
    const task = await engine.onPageReady(1, analysis());
    await expect(engine.solve(task.id)).rejects.toThrow('Acknowledge');
    expect(reasoner.complete).not.toHaveBeenCalled();
  });
});

describe('execute', () => {
  it('requires the per-activity authorization', async () => {
    const task = await engine.onPageReady(1, analysis());
    await engine.solve(task.id);
    await engine.setApproved(recordId(task.id, 'p1', 'q1'), true);
    await expect(engine.execute(task.id)).rejects.toThrow('permits automated assistance');
    expect(page.execute).not.toHaveBeenCalled();
  });

  it('fills approved answers and journals the verified result', async () => {
    const id = await reachReview();
    page.analyze
      .mockResolvedValueOnce(analysis())
      .mockResolvedValue(analysis({ questions: [question(['4'])] }));
    await engine.execute(id);
    expect(page.execute).toHaveBeenCalledOnce();
    expect((await store.getActions(id))[0]?.status).toBe('verified');
    expect((await store.getTask(id))?.status).toBe('review');
  });

  it('does not repeat an action that a dead worker already applied', async () => {
    const id = await reachReview();
    const { buildPlan } = await import('@sima/action-planner');
    const action = buildPlan(id, await store.getQuestions(id, 'p1')).actions[0]!;
    await store.putAction({
      id: action.id,
      taskId: id,
      pageKey: 'p1',
      action,
      status: 'started',
      attempts: 1,
      result: null,
      updatedAt: 0,
    });
    await store.putTask({ ...(await store.getTask(id))!, status: 'executing' });
    page.check.mockImplementation(async (_t: number, a: BrowserAction) => ({
      ...ok(a),
      status: 'verified',
      alreadyApplied: true,
    }));
    await engine.recover();
    expect(page.check).toHaveBeenCalled();
    expect(page.execute).not.toHaveBeenCalled();
    expect((await store.getAction(action.id))?.status).toBe('verified');
    expect((await store.getTask(id))?.status).toBe('review');
  });

  it('re-applies when recovery finds the action never took effect', async () => {
    const id = await reachReview();
    const { buildPlan } = await import('@sima/action-planner');
    const action = buildPlan(id, await store.getQuestions(id, 'p1')).actions[0]!;
    await store.putAction({
      id: action.id,
      taskId: id,
      pageKey: 'p1',
      action,
      status: 'started',
      attempts: 1,
      result: null,
      updatedAt: 0,
    });
    await store.putTask({ ...(await store.getTask(id))!, status: 'executing' });
    await engine.recover();
    expect(page.execute).toHaveBeenCalledOnce();
  });

  it('re-enters a value the page lost after a reload', async () => {
    const id = await reachReview();
    await engine.execute(id);
    page.execute.mockClear();
    await engine.execute(id);
    expect(page.execute).toHaveBeenCalledOnce();
  });

  it('retries a recoverable failure once, after re-reading the page', async () => {
    const id = await reachReview();
    page.execute.mockImplementationOnce(async (_t: number, a: BrowserAction) => ({
      ...ok(a),
      status: 'failed',
      failure: 'target_missing',
    }));
    await engine.execute(id);
    expect(page.execute).toHaveBeenCalledTimes(2);
    expect(page.analyze.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not loop on a permanent failure', async () => {
    const id = await reachReview();
    page.execute.mockImplementation(async (_t: number, a: BrowserAction) => ({
      ...ok(a),
      status: 'failed',
      failure: 'target_disabled',
    }));
    await engine.execute(id);
    expect(page.execute).toHaveBeenCalledOnce();
    expect((await store.getTask(id))?.status).toBe('review');
    expect((await store.getActions(id))[0]?.status).toBe('failed');
  });

  it('stops between actions when paused', async () => {
    const two = analysis({
      questions: [
        question(),
        { ...question(), id: 'q2', fields: [{ ...question().fields[0]!, key: 'b' }] },
      ],
    });
    page.analyze.mockResolvedValue(two);
    reasoner.complete.mockResolvedValue({
      ...solution,
      answers: [
        { fieldKey: 'a', values: ['4'] },
        { fieldKey: 'b', values: ['5'] },
      ],
      calculations: [],
    });
    const task = await engine.onPageReady(1, two);
    await engine.authorizeFill(task.id, true);
    await engine.solve(task.id);
    await engine.setApproved(recordId(task.id, 'p1', 'q1'), true);
    await engine.setApproved(recordId(task.id, 'p1', 'q2'), true);
    page.execute.mockImplementationOnce(async (_t: number, a: BrowserAction) => {
      await engine.pause(task.id);
      return ok(a);
    });
    await engine.execute(task.id);
    expect(page.execute).toHaveBeenCalledOnce();
    const paused = await store.getTask(task.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.resumeStatus).toBe('executing');
    await engine.resume(task.id);
    expect(page.execute).toHaveBeenCalledTimes(3);
  });
});

describe('multi-page progress', () => {
  it('completes navigation across a page load, even after a worker restart', async () => {
    const id = await reachReview();
    await engine.navigateNext(id);
    expect((await store.getTask(id))?.status).toBe('navigating');

    const restarted = new TaskEngine({
      store,
      page: page as unknown as PagePort,
      reasoner: reasoner as unknown as Reasoner,
    });
    await restarted.recover();
    const page2 = analysis({
      pageKey: 'p2',
      pagination: { index: 2, total: 2 },
      next: null,
      questions: [{ ...question(), pageKey: 'p2' }],
    });
    const task = await restarted.onPageReady(1, page2);

    expect(task.status).toBe('ready');
    expect(task.pages.map((p) => p.pageKey)).toEqual(['p1', 'p2']);
    const nav = (await store.getActions(id)).find((a) => a.action.type === 'navigate_next');
    expect(nav?.status).toBe('verified');
    expect((await restarted.view(1)).progress.total).toBe(2);
  });

  it('keeps earlier work when returning to a page', async () => {
    const id = await reachReview();
    const again = await engine.onPageReady(1, analysis());
    expect(again.status).toBe('review');
    const record = await store.getQuestion(recordId(id, 'p1', 'q1'));
    expect(record?.responses).toEqual({ a: ['4'] });
    expect(record?.approved).toBe(true);
  });

  it('reports a page that never changed, without retrying', async () => {
    const id = await reachReview();
    await engine.navigateNext(id);
    await engine.onNavigationTimeout(1);
    const task = await store.getTask(id);
    expect(task?.status).toBe('review');
    expect(task?.error).toMatch(/did not load/);
    expect(
      page.execute.mock.calls.filter(([, a]) => (a as BrowserAction).type === 'navigate_next'),
    ).toHaveLength(1);
  });

  it('does not let a reload undo a pause or stop', async () => {
    const id = await reachReview();
    await engine.pause(id);
    expect((await engine.onPageReady(1, analysis())).status).toBe('paused');
    await engine.stop(id);
    expect((await engine.onPageReady(1, analysis())).status).toBe('stopped');
  });
});

describe('task lifecycle', () => {
  it('leaves a running step alone when asked to re-read the page', async () => {
    const id = await reachReview();
    await store.putTask({ ...(await store.getTask(id))!, status: 'executing' });
    page.analyze.mockClear();
    await engine.analyze(1);
    expect(page.analyze).not.toHaveBeenCalled();
    expect((await store.getTask(id))?.status).toBe('executing');
  });

  it('restarts a stopped task and keeps its saved work', async () => {
    const id = await reachReview();
    await engine.stop(id);
    await engine.restart(id);
    expect((await store.getTask(id))?.status).toBe('review');
    expect((await store.getQuestion(recordId(id, 'p1', 'q1')))?.responses).toEqual({ a: ['4'] });
  });

  it('detaches a closed tab without losing work', async () => {
    const id = await reachReview();
    await engine.detachTab(1);
    expect((await engine.view(1)).task).toBeNull();
    expect((await store.getTask(id))?.tabId).toBeNull();
    await expect(engine.execute(id)).rejects.toThrow('not open in a tab');
  });
});

describe('concurrent commands', () => {
  it('keeps an authorization made while a page report is being processed', async () => {
    const task = await engine.onPageReady(1, analysis());
    await Promise.all([engine.onPageReady(1, analysis()), engine.authorizeFill(task.id, true)]);
    expect((await store.getTask(task.id))?.fillAuthorizedAt).not.toBeNull();
  });

  it('keeps a detach that lands during a page report', async () => {
    const task = await engine.onPageReady(1, analysis());
    await Promise.all([engine.onPageReady(1, analysis()), engine.detachTab(1)]);
    expect((await store.getTask(task.id))?.tabId).toBeNull();
  });

  it('keeps a pause issued while solving finishes', async () => {
    const task = await engine.onPageReady(1, analysis());
    reasoner.complete.mockImplementationOnce(async () => {
      await engine.pause(task.id);
      return solution;
    });
    await engine.solve(task.id);
    expect((await store.getTask(task.id))?.status).toBe('paused');
  });

  it('keeps a pause issued between the final action and the end of a run', async () => {
    const id = await reachReview();
    let calls = 0;
    page.analyze.mockImplementation(async () => {
      calls++;
      // Second read is the one after the last action, just before the run closes.
      if (calls === 2) await engine.pause(id);
      return analysis();
    });
    await engine.execute(id);
    expect((await store.getTask(id))?.status).toBe('paused');
  });

  it('keeps a field confirmation made while the question is being solved', async () => {
    const task = await engine.onPageReady(1, analysis());
    const q1 = recordId(task.id, 'p1', 'q1');
    reasoner.complete.mockImplementationOnce(async () => {
      await engine.confirmField(q1, 'a');
      return solution;
    });
    await engine.solve(task.id, ['q1']);
    const record = await store.getQuestion(q1);
    expect(record?.confirmedFields).toEqual(['a']);
    expect(record?.solution).not.toBeNull();
  });

  it('ignores a second run requested while one is active', async () => {
    const id = await reachReview();
    await Promise.all([engine.execute(id), engine.execute(id).catch(() => undefined)]);
    expect(page.execute).toHaveBeenCalledOnce();
  });
});

describe('data deletion', () => {
  it('removes all task data', async () => {
    const id = await reachReview();
    await store.deleteAll();
    expect(await store.getTask(id)).toBeUndefined();
    expect(await store.getQuestions(id)).toEqual([]);
  });
});
