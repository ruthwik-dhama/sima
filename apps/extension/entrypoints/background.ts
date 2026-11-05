import { createTaskStore } from '@sima/storage';
import { TaskEngine, type PagePort } from '@sima/task-orchestrator';
import {
  ActionResultSchema,
  CaptureResultSchema,
  ContentEventSchema,
  MODEL_DOWNLOAD_KEY,
  PageAnalysisSchema,
  UiCommandSchema,
  type ContentCommand,
  type FloatingState,
  type ModelDownload,
  type OllamaStatus,
  type Reply,
  type UiCommand,
} from '@sima/shared-types';
import {
  chooseDefaultOllamaModel,
  isOllamaBlocked,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
} from '@sima/model-providers';
import { keepWorkerAlive, ollamaProvider, reasoner } from '@/services/reasoner';
import {
  loadSettings,
  lockStorageToExtensionPages,
  removeOldApiKeys,
  saveSettings,
} from '@/services/settings';

/** How often a running download records that it's still alive, so a dead one can be spotted. */
const DOWNLOAD_HEARTBEAT_MS = 10_000;

const STATUS_LABEL: Record<string, string> = {
  analyzing: 'Reading page',
  blocked_restricted: 'Not available here',
  ready: 'Ready',
  reasoning: 'Working through questions',
  review: 'Ready for review',
  executing: 'Filling fields',
  navigating: 'Changing page',
  paused: 'Paused',
  completed: 'Finished',
  stopped: 'Stopped',
  error: 'Needs attention',
};

export default defineBackground(() => {
  const store = createTaskStore();

  const page: PagePort = {
    async analyze(tabId) {
      const raw = await chrome.tabs.sendMessage(tabId, {
        type: 'ANALYZE_PAGE',
      } satisfies ContentCommand);
      const analysis = PageAnalysisSchema.nullable().parse(raw);
      const settings = await loadSettings();
      return analysis && settings.disabledPlatforms.includes(analysis.platformId) ? null : analysis;
    },
    async execute(tabId, action) {
      const raw = await chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_ACTION',
        action,
      } satisfies ContentCommand);
      return ActionResultSchema.parse(raw);
    },
    async check(tabId, action) {
      const raw = await chrome.tabs.sendMessage(tabId, {
        type: 'CHECK_ACTION',
        action,
      } satisfies ContentCommand);
      return ActionResultSchema.parse(raw);
    },
  };

  const engine = new TaskEngine({
    store,
    page,
    reasoner,
    onChange: (taskId) => void announce(taskId),
  });

  async function floatingState(tabId: number): Promise<FloatingState> {
    const settings = await loadSettings();
    const session = await chrome.storage.session.get(`dismissed:${tabId}`);
    const view = await engine.view(tabId);
    const task = view.task;
    return {
      visible: settings.floatingEnabled && !session[`dismissed:${tabId}`] && task !== null,
      status: task ? (STATUS_LABEL[task.status] ?? task.status) : '',
      activityTitle: task?.activityTitle ?? '',
      done: view.progress.answered,
      total: view.progress.total,
      restricted: task?.status === 'blocked_restricted',
      note: task?.activityNote ?? null,
    };
  }

  async function pushFloating(tabId: number): Promise<void> {
    const state = await floatingState(tabId);
    await chrome.tabs
      .sendMessage(tabId, { type: 'FLOATING_STATE', state } satisfies ContentCommand)
      .catch(() => undefined);
  }

  async function announce(taskId: string | null): Promise<void> {
    await chrome.runtime.sendMessage({ type: 'STATE_CHANGED', taskId }).catch(() => undefined);
    if (!taskId) return;
    const task = await store.getTask(taskId);
    if (task?.tabId != null) await pushFloating(task.tabId);
  }

  /** Finds Ollama, and picks an installed model if none is chosen, so setup needs no clicks. */
  async function checkOllama(): Promise<OllamaStatus> {
    const settings = await loadSettings();
    try {
      const models = await ollamaProvider(settings).listModels();
      const pick = settings.model ? null : chooseDefaultOllamaModel(models);
      if (pick) await saveSettings({ ...(await loadSettings()), model: pick });
      return { status: 'ready', models };
    } catch (error) {
      return { status: isOllamaBlocked(error) ? 'blocked' : 'not_running', models: [] };
    }
  }

  /**
   * Downloads the recommended model here rather than in the dropdown, which closes whenever the
   * user clicks elsewhere. Progress goes to storage so any Sima page can show it.
   */
  async function downloadModel(): Promise<void> {
    const stored = await chrome.storage.local.get(MODEL_DOWNLOAD_KEY);
    const current = stored[MODEL_DOWNLOAD_KEY] as ModelDownload | undefined;
    if (current?.state === 'running' && Date.now() - current.updatedAt < 3 * DOWNLOAD_HEARTBEAT_MS)
      return;
    let state: Omit<ModelDownload, 'updatedAt'> = {
      model: RECOMMENDED_OLLAMA_MODEL,
      state: 'running',
      fraction: null,
    };
    const write = () =>
      chrome.storage.local.set({ [MODEL_DOWNLOAD_KEY]: { ...state, updatedAt: Date.now() } });
    await write();
    const heartbeat = setInterval(() => void write(), DOWNLOAD_HEARTBEAT_MS);
    let lastWrite = 0;
    try {
      const settings = await loadSettings();
      await keepWorkerAlive(() =>
        pullOllamaModel(settings.ollamaBaseUrl, RECOMMENDED_OLLAMA_MODEL, (fraction) => {
          state = { ...state, fraction };
          if (Date.now() - lastWrite > 500) {
            lastWrite = Date.now();
            void write();
          }
        }),
      );
      clearInterval(heartbeat);
      const latest = await loadSettings();
      await saveSettings({ ...latest, model: latest.model || RECOMMENDED_OLLAMA_MODEL });
      await chrome.storage.local.remove(MODEL_DOWNLOAD_KEY);
    } catch (error) {
      clearInterval(heartbeat);
      state = { ...state, state: isOllamaBlocked(error) ? 'blocked' : 'failed', fraction: null };
      await write();
    }
  }

  async function assertPlatformEnabled(taskId: string): Promise<void> {
    const task = await store.getTask(taskId);
    const settings = await loadSettings();
    if (task && settings.disabledPlatforms.includes(task.platformId)) {
      throw new Error(`${task.platformName} is turned off in Settings.`);
    }
  }

  async function handleUi(command: UiCommand): Promise<unknown> {
    switch (command.type) {
      case 'GET_VIEW':
        return engine.view(command.tabId);
      case 'ANALYZE':
        // No content script answering means this tab has left every supported page.
        return engine.analyze(command.tabId).catch(() => engine.detachTab(command.tabId));
      case 'AUTHORIZE_FILL':
        return engine.authorizeFill(command.taskId, command.authorized);
      case 'SOLVE':
        await assertPlatformEnabled(command.taskId);
        return engine.solve(command.taskId, command.questionIds);
      case 'EDIT_RESPONSE':
        return engine.editResponse(command.recordId, command.fieldKey, command.values);
      case 'SET_APPROVED':
        return engine.setApproved(command.recordId, command.approved);
      case 'CONFIRM_FIELD':
        return engine.confirmField(command.recordId, command.fieldKey);
      case 'ALLOW_OVERWRITE':
        return engine.allowOverwrite(command.recordId, command.fieldKey);
      case 'EXECUTE':
        await assertPlatformEnabled(command.taskId);
        return engine.execute(command.taskId);
      case 'AUTO_FILL':
        await assertPlatformEnabled(command.taskId);
        return engine.autoFill(command.taskId);
      case 'NAVIGATE_NEXT':
        await assertPlatformEnabled(command.taskId);
        return engine.navigateNext(command.taskId);
      case 'PAUSE':
        return engine.pause(command.taskId);
      case 'RESUME':
        return engine.resume(command.taskId);
      case 'STOP':
        return engine.stop(command.taskId);
      case 'COMPLETE':
        return engine.complete(command.taskId);
      case 'RESTART':
        await assertPlatformEnabled(command.taskId);
        return engine.restart(command.taskId);
      case 'FOLLOW_UP':
        return engine.followUp(command.recordId, command.question);
      case 'CAPTURE_PAGE': {
        const raw = await chrome.tabs
          .sendMessage(command.tabId, { type: 'CAPTURE_PAGE' } satisfies ContentCommand)
          .catch(() => {
            throw new Error(
              'Sima can only capture supported sites. Reload the page and try again.',
            );
          });
        return CaptureResultSchema.parse(raw);
      }
      case 'GET_SETTINGS':
        return { settings: await loadSettings() };
      case 'SAVE_SETTINGS':
        return saveSettings(command.settings);
      case 'CHECK_OLLAMA':
        return checkOllama();
      case 'DOWNLOAD_MODEL':
        // Answers at once. The download carries on, and reports through storage.
        void downloadModel();
        return undefined;
      case 'DELETE_TASK_DATA':
        await store.deleteAll();
        await announce(null);
        return undefined;
      case 'OPEN_POPUP':
      case 'DISMISS_FLOATING':
        throw new Error('Handled from the content script');
    }
  }

  async function handleContent(raw: unknown, tabId: number): Promise<unknown> {
    const event = ContentEventSchema.parse(raw);
    switch (event.type) {
      case 'PAGE_READY': {
        const settings = await loadSettings();
        if (settings.disabledPlatforms.includes(event.analysis.platformId)) return null;
        await engine.onPageReady(tabId, event.analysis);
        return floatingState(tabId);
      }
      case 'NAVIGATION_TIMEOUT':
        return engine.onNavigationTimeout(tabId);
      case 'GET_FLOATING_STATE':
        return floatingState(tabId);
    }
  }

  const respond = (work: Promise<unknown>, sendResponse: (reply: Reply<unknown>) => void) => {
    work
      .then((data) => sendResponse({ ok: true, data: data ?? null }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Something went wrong',
        }),
      );
    return true;
  };

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) ?? false;
    const type = (raw as { type?: unknown } | null)?.type;

    if (!fromExtensionPage) {
      // Content scripts run alongside untrusted pages, so they get a deliberately small surface.
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      if (type === 'OPEN_POPUP') {
        // Must be called synchronously to keep the user gesture from the click.
        return respond(chrome.action.openPopup(), sendResponse);
      }
      if (type === 'DISMISS_FLOATING') {
        return respond(chrome.storage.session.set({ [`dismissed:${tabId}`]: true }), sendResponse);
      }
      return respond(handleContent(raw, tabId), sendResponse);
    }

    if (type === 'STATE_CHANGED') return false;
    const parsed = UiCommandSchema.safeParse(raw);
    if (!parsed.success)
      return respond(Promise.reject(new Error('Unrecognized command')), sendResponse);
    return respond(handleUi(parsed.data), sendResponse);
  });

  chrome.tabs.onRemoved.addListener((tabId) => void engine.detachTab(tabId).catch(() => undefined));

  void lockStorageToExtensionPages();
  void removeOldApiKeys();
  // A status still in flight here means the previous worker died partway through a step.
  void engine.recover().catch(() => undefined);
});
