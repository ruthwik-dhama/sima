import { createRoot } from 'react-dom/client';
import { analyzePage, findAdapter, waitForReady, type PlatformAdapter } from '@sima/adapter-core';
import { checkAction, executeAction } from '@sima/browser-executor';
import {
  ContentCommandSchema,
  type ContentEvent,
  type FloatingState,
  type Reply,
} from '@sima/shared-types';
import { FloatingAssistant } from '@/components/FloatingAssistant';
import { ADAPTERS } from '@/services/adapters';
import { sendCommand } from '@/services/messaging';
import floatingCss from '@/styles/floating.css?inline';

const NAVIGATION_TIMEOUT_MS = 10000;

export default defineContentScript({
  matches: [
    'https://*.gradescope.com/*',
    'https://*.vhlcentral.com/*',
    'https://*.webassign.net/*',
  ],
  // Styles are bundled, so no web-accessible file exists for a page to fingerprint Sima with.
  cssInjectionMode: 'manual',
  runAt: 'document_idle',
  async main(ctx) {
    const adapter = findAdapter(ADAPTERS, new URL(location.href));
    if (!adapter) return;
    run(ctx, adapter);
  },
});

function run(ctx: Parameters<typeof createShadowRootUi>[0], adapter: PlatformAdapter) {
  const analyze = () => analyzePage(adapter, document, new URL(location.href));
  let lastKey = '';
  let setFloating: ((state: FloatingState) => void) | undefined;
  let pendingFloating: FloatingState | undefined;
  const applyFloating = (state: FloatingState) => {
    if (setFloating) setFloating(state);
    else pendingFloating = state;
  };

  const emit = (event: ContentEvent) =>
    chrome.runtime.sendMessage(event) as Promise<Reply<unknown> | undefined>;

  async function report() {
    if (!adapter.isReady(document)) return;
    const analysis = analyze();
    if (!analysis) return;
    const key = `${analysis.pageKey}|${analysis.questions.length}|${analysis.restriction.status}`;
    if (key === lastKey) return;
    lastKey = key;
    const reply = await emit({ type: 'PAGE_READY', analysis });
    if (reply?.ok && reply.data) applyFloating(reply.data as FloatingState);
  }

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const parsed = ContentCommandSchema.safeParse(raw);
    if (!parsed.success) return false;
    const command = parsed.data;
    switch (command.type) {
      case 'FLOATING_STATE':
        applyFloating(command.state);
        return false;
      case 'ANALYZE_PAGE':
        void waitForReady(adapter, document).then((ready) =>
          sendResponse(ready ? analyze() : null),
        );
        return true;
      case 'CHECK_ACTION':
        sendResponse(checkAction(command.action, document));
        return false;
      case 'EXECUTE_ACTION':
        void executeAction(command.action, {
          doc: document,
          isRestricted: () => analyze()?.restriction.status === 'restricted',
        }).then((result) => {
          sendResponse(result);
          if (result.status === 'dispatched') watchNavigation(analyze()?.pageKey ?? '');
        });
        return true;
    }
  });

  // A new document reports through a fresh content script. This covers an in-page move that never happens.
  function watchNavigation(fromPageKey: string) {
    window.setTimeout(() => {
      if (analyze()?.pageKey === fromPageKey)
        void emit({ type: 'NAVIGATION_TIMEOUT', fromPageKey });
    }, NAVIGATION_TIMEOUT_MS);
  }

  void waitForReady(adapter, document).then(report);

  // Client-rendered platforms change pages and add questions without a document load.
  let debounce: number | undefined;
  const observer = new MutationObserver(() => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void report(), 250);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state', 'data-page'],
  });
  ctx.onInvalidated(() => observer.disconnect());

  void createShadowRootUi(ctx, {
    name: 'sima-assistant',
    css: floatingCss,
    position: 'inline',
    anchor: 'body',
    onMount(container) {
      const root = createRoot(container);
      const Host = () => (
        <FloatingAssistant
          initial={pendingFloating}
          subscribe={(setter) => {
            setFloating = setter;
          }}
          onOpen={() => void sendCommand({ type: 'OPEN_SIDE_PANEL' }).catch(() => undefined)}
          onDismiss={() => void sendCommand({ type: 'DISMISS_FLOATING' }).catch(() => undefined)}
        />
      );
      root.render(<Host />);
      return root;
    },
    onRemove: (root) => root?.unmount(),
  }).then((ui) => ui.mount());
}
