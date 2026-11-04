import { JSDOM } from 'jsdom';
import type { PlatformAdapter } from '@sima/adapter-core';
import { waitForReady } from '@sima/adapter-core';

export async function loadMock(url: string, adapter: PlatformAdapter): Promise<JSDOM> {
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  });
  await new Promise<void>((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', () => resolve());
  });
  const ready = await waitForReady(adapter, dom.window.document);
  if (!ready) throw new Error(`Mock never became ready: ${url}`);
  return dom;
}
