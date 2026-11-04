import Dexie, { type Table } from 'dexie';
import type {
  ActionRecord,
  PageAnalysis,
  QuestionRecord,
  Task,
  TaskStatus,
} from '@sima/shared-types';
import type { TaskStore } from '@sima/task-orchestrator';

interface AnalysisRow {
  id: string;
  taskId: string;
  analysis: PageAnalysis;
}

class SimaDatabase extends Dexie {
  tasks!: Table<Task, string>;
  questions!: Table<QuestionRecord, string>;
  actions!: Table<ActionRecord, string>;
  analyses!: Table<AnalysisRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      tasks: 'id, [platformId+activityId], tabId, status',
      questions: 'id, taskId, [taskId+pageKey]',
      actions: 'id, taskId',
      analyses: 'id, taskId',
    });
  }
}

export interface DexieTaskStore extends TaskStore {
  deleteAll(): Promise<void>;
}

export function createTaskStore(name = 'sima'): DexieTaskStore {
  const db = new SimaDatabase(name);
  return {
    getTask: (id) => db.tasks.get(id),
    findTask: (platformId, activityId) => db.tasks.where({ platformId, activityId }).first(),
    async findTaskByTab(tabId) {
      const tasks = await db.tasks.where({ tabId }).toArray();
      return tasks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    },
    listInFlight: (statuses: TaskStatus[]) => db.tasks.where('status').anyOf(statuses).toArray(),
    putTask: async (task) => {
      await db.tasks.put(task);
    },
    getQuestions: (taskId, pageKey) =>
      pageKey === undefined
        ? db.questions.where({ taskId }).toArray()
        : db.questions.where({ taskId, pageKey }).toArray(),
    getQuestion: (id) => db.questions.get(id),
    putQuestion: async (record) => {
      await db.questions.put(record);
    },
    getActions: (taskId) => db.actions.where({ taskId }).toArray(),
    getAction: (id) => db.actions.get(id),
    putAction: async (record) => {
      await db.actions.put(record);
    },
    getAnalysis: async (taskId, pageKey) =>
      (await db.analyses.get(`${taskId}|${pageKey}`))?.analysis,
    putAnalysis: async (taskId, analysis) => {
      await db.analyses.put({ id: `${taskId}|${analysis.pageKey}`, taskId, analysis });
    },
    async deleteAll() {
      await Promise.all([
        db.tasks.clear(),
        db.questions.clear(),
        db.actions.clear(),
        db.analyses.clear(),
      ]);
    },
  };
}
