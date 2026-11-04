import { extractQuestion, normalizeSpace, visibleText } from '@sima/page-analyzer';
import { hostMatches, isPlaygroundUrl, type PlatformAdapter } from '@sima/adapter-core';

const QUESTION = '[data-gs-question]';

export const gradescopeAdapter: PlatformAdapter = {
  id: 'gradescope',
  displayName: 'Gradescope',
  compatibility: 'mock_only',
  matchPatterns: ['https://*.gradescope.com/*'],
  matches: (url) => hostMatches(url, 'gradescope.com') || isPlaygroundUrl(url, 'gradescope'),
  isReady: (doc) => doc.readyState !== 'loading' && !doc.querySelector('[data-gs-loading]'),
  detectPage(doc, url) {
    const header = doc.querySelector('[data-gs-assignment]');
    if (!header) return null;
    const title = normalizeSpace(header.querySelector('h1')?.textContent ?? 'Untitled assignment');
    return {
      pageKey: 'main',
      pageType: header.getAttribute('data-gs-assignment') === 'exam' ? 'assessment' : 'activity',
      activityId: `${url.pathname}`,
      activityTitle: title,
      pagination: { index: 1, total: 1 },
      instructions: visibleText(
        doc.querySelector('[data-gs-instructions]') ?? doc.createElement('div'),
      ),
    };
  },
  platformRestrictions(doc) {
    return doc.querySelector('[data-gs-timer]')
      ? [{ code: 'timed_assessment', evidence: 'Countdown timer on page' }]
      : [];
  },
  extractQuestions(doc, page) {
    return Array.from(doc.querySelectorAll(QUESTION)).map((container, index) => {
      const number = container.getAttribute('data-gs-question') ?? String(index + 1);
      return extractQuestion(container, {
        id: `q${number}`,
        number,
        pageKey: page.pageKey,
        promptEl: container.querySelector('[data-gs-prompt]') ?? container,
      });
    });
  },
  // Gradescope online assignments are one page; saving and submitting stay with the student.
  findNext: () => null,
};
