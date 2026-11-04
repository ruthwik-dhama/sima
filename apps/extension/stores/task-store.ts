import { create } from 'zustand';
import type { TaskView, UiCommand } from '@sima/shared-types';
import { sendCommand } from '@/services/messaging';

interface TaskStore {
  tabId: number | null;
  view: TaskView | null;
  error: string | null;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  setTab: (tabId: number) => Promise<void>;
  refresh: () => Promise<void>;
  /** Sends a command, then refreshes. Failures surface in the panel, not the console. */
  run: (command: UiCommand) => Promise<void>;
  dismissError: () => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tabId: null,
  view: null,
  error: null,
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  async setTab(tabId) {
    set({ tabId, view: null, error: null });
    await sendCommand({ type: 'ANALYZE', tabId }).catch(() => undefined);
    await get().refresh();
  },
  async refresh() {
    const { tabId } = get();
    if (tabId === null) return;
    try {
      const view = await sendCommand<TaskView>({ type: 'GET_VIEW', tabId });
      if (get().tabId === tabId) set({ view });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Could not load Sima state' });
    }
  },
  async run(command) {
    set({ error: null });
    try {
      await sendCommand(command);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'That did not work' });
    }
    await get().refresh();
  },
  dismissError: () => set({ error: null }),
}));
