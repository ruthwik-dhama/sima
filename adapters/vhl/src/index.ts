import { extractQuestion, normalizeSpace, visibleText } from '@sima/page-analyzer';
import { hostMatches, isPlaygroundUrl, type PlatformAdapter } from '@sima/adapter-core';

export const vhlAdapter: PlatformAdapter = {
  id: 'vhl',
  displayName: 'VHL Central',
  compatibility: 'mock_only',
  matchPatterns: ['https://*.vhlcentral.com/*'],
  matches: (url) => hostMatches(url, 'vhlcentral.com') || isPlaygroundUrl(url, 'vhl'),
  // Activities render client-side, so readiness means the renderer has finished.
  isReady: (doc) => doc.querySelector('[data-vhl-activity][data-state="ready"]') !== null,
  detectPage(doc) {
    const root = doc.querySelector('[data-vhl-activity]');
    if (!root) return null;
    const index = Number(root.getAttribute('data-page') ?? '1');
    const total = Number(root.getAttribute('data-pages') ?? '1');
    const type = root.getAttribute('data-kind');
    return {
      pageKey: `page-${index}`,
      pageType: type === 'test' ? 'assessment' : 'activity',
      activityId: root.getAttribute('data-vhl-activity') ?? 'activity',
      activityTitle: normalizeSpace(
        root.querySelector('[data-vhl-title]')?.textContent ?? 'Activity',
      ),
      pagination: { index, total },
      instructions: visibleText(
        root.querySelector('[data-vhl-directions]') ?? doc.createElement('div'),
      ),
    };
  },
  platformRestrictions: () => [],
  extractQuestions(doc, page) {
    return Array.from(doc.querySelectorAll('[data-vhl-item]')).map((container, index) => {
      const number = container.getAttribute('data-vhl-item') ?? String(index + 1);
      return extractQuestion(container, {
        id: `${page.pageKey}-i${number}`,
        number,
        pageKey: page.pageKey,
      });
    });
  },
  findNext: (doc) => doc.querySelector('[data-vhl-next]'),
};
