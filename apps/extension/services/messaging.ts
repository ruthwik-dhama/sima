import type { Reply, UiCommand } from '@sima/shared-types';

export async function sendCommand<T = void>(command: UiCommand): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(command)) as Reply<T> | undefined;
  if (!reply) throw new Error('Sima background did not respond.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
