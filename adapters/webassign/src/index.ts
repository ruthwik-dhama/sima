import { extractQuestion, normalizeSpace, visibleText } from '@sima/page-analyzer';
import { hostMatches, isPlaygroundUrl, type PlatformAdapter } from '@sima/adapter-core';

export const webassignAdapter: PlatformAdapter = {
  id: 'webassign',
  displayName: 'WebAssign',
  compatibility: 'mock_only',
  matchPatterns: ['https://*.webassign.net/*'],
  matches: (url) => hostMatches(url, 'webassign.net') || isPlaygroundUrl(url, 'webassign'),
  isReady: (doc) => doc.readyState !== 'loading' && doc.querySelector('[data-wa-loading]') === null,
  detectPage(doc) {
    const root = doc.querySelector('[data-wa-assignment]');
    if (!root) return null;
    const index = Number(root.getAttribute('data-current') ?? '1');
    return {
      pageKey: `question-${index}`,
      pageType: root.getAttribute('data-category') === 'test' ? 'assessment' : 'activity',
      activityId: root.getAttribute('data-wa-assignment') ?? 'assignment',
      activityTitle: normalizeSpace(root.querySelector('h1')?.textContent ?? 'Assignment'),
      pagination: { index, total: Number(root.getAttribute('data-total') ?? '1') },
      instructions: visibleText(
        root.querySelector('[data-wa-instructions]') ?? doc.createElement('div'),
      ),
    };
  },
  platformRestrictions(doc) {
    return doc.querySelector('[data-wa-lockdown]')
      ? [{ code: 'lockdown_browser', evidence: 'Lockdown requirement on page' }]
      : [];
  },
  extractQuestions(doc, page) {
    return Array.from(doc.querySelectorAll('[data-wa-question]')).map((container, index) => {
      const number = container.getAttribute('data-wa-question') ?? String(index + 1);
      return extractQuestion(container, {
        id: `${page.pageKey}-p${number}`,
        number,
        pageKey: page.pageKey,
      });
    });
  },
  findNext: (doc) => doc.querySelector('[data-wa-next]'),
};
