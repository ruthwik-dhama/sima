import type { TaskStatus } from '@sima/shared-types';

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  analyzing: ['ready', 'review', 'blocked_restricted', 'error', 'paused', 'stopped'],
  blocked_restricted: ['analyzing', 'stopped'],
  ready: [
    'analyzing',
    'reasoning',
    'navigating',
    'completed',
    'paused',
    'stopped',
    'blocked_restricted',
  ],
  reasoning: ['review', 'ready', 'error', 'paused', 'stopped', 'analyzing', 'blocked_restricted'],
  review: [
    'analyzing',
    'reasoning',
    'executing',
    'navigating',
    'completed',
    'paused',
    'stopped',
    'blocked_restricted',
  ],
  executing: ['review', 'analyzing', 'error', 'paused', 'stopped', 'blocked_restricted'],
  navigating: ['analyzing', 'review', 'error', 'paused', 'stopped', 'blocked_restricted'],
  paused: [
    'analyzing',
    'ready',
    'reasoning',
    'review',
    'executing',
    'navigating',
    'stopped',
    'blocked_restricted',
  ],
  completed: ['analyzing', 'stopped'],
  stopped: ['analyzing'],
  error: ['analyzing', 'stopped', 'review'],
};

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`A task cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from !== to && !TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
}
