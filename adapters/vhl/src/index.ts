import {
  extractQuestion,
  isHidden,
  makeTarget,
  normalizeSpace,
  visibleText,
} from '@sima/page-analyzer';
import {
  hostMatches,
  isPlaygroundUrl,
  type PageInfo,
  type PlatformAdapter,
} from '@sima/adapter-core';
import type { Question, RestrictionSignal } from '@sima/shared-types';

// The real activity layout, learned from structure-only captures of m3a.vhlcentral.com.
const ACTIVITY_FORM = '#activity_form';
const QUESTION = '.js-question';
const QUESTION_BODY = '[id$="_whole_question"]';
const REFERENCE_BLOCK = '.activity_reference_block';
const MAX_REFERENCE_CHARS = 2000;
const DROPDOWN_WRAPPER = '.js-activity-dropdown-wrapper';
const DROPDOWN_BUTTON = '.c-dropdown-disclosure__button';
const TIMERS = '.timer, .timer-wrapper, .alert__timer, .js-a11y-time-remaining';
// Text around a question that isn't part of it. Chat boxes and audio controls sit outside QUESTION.
const NOT_THE_QUESTION =
  '.c-question__correctness, .c-instructor-note-container, .audio-transcript';

// The original synthetic mock, kept because it exercises in-activity page changes.
const MOCK_ACTIVITY = '[data-vhl-activity]';

function isRealActivity(doc: Document): boolean {
  return doc.querySelector(`${ACTIVITY_FORM} ${QUESTION}`) !== null;
}

function customSelectFor(select: Element) {
  const button = select.closest(DROPDOWN_WRAPPER)?.querySelector(DROPDOWN_BUTTON);
  if (!button) return null;
  return {
    button: makeTarget(button),
    // The site attaches each open list to the end of <body>, away from its dropdown.
    optionSelector: '.js-listbox [role="option"]',
    indexAttribute: 'data-index',
  };
}

/** Marks the answer part of an example, which the page shows in bold or underlined. */
function exampleText(example: Element): string {
  const copy = example.cloneNode(true) as Element;
  copy.querySelectorAll('b, strong, u').forEach((answer) => {
    answer.textContent = `«${answer.textContent}»`;
  });
  return visibleText(copy).replace(/^Modelo\s*/i, '');
}

/** The example and word list sit above the questions, outside the directions line. */
function referenceMaterial(doc: Document): string[] {
  const parts: string[] = [];
  for (const block of Array.from(doc.querySelectorAll(REFERENCE_BLOCK))) {
    if (isHidden(block)) continue;
    block.querySelectorAll('[class*="c-model"][id]').forEach((example) => {
      if (!isHidden(example)) parts.push(`Example (Modelo): ${exampleText(example)}`);
    });
    block.querySelectorAll('.c-reference-wordbank').forEach((bank) => {
      if (isHidden(bank)) return;
      const words = Array.from(bank.querySelectorAll('li, td'))
        .map((item) => visibleText(item))
        .filter(Boolean);
      parts.push(`Word list: ${words.length > 0 ? words.join(', ') : visibleText(bank)}`);
    });
    // Anything else here, such as a reading passage. Long ones are shortened to fit the model.
    const other = block.cloneNode(true) as Element;
    other
      .querySelectorAll('[class*="c-model"], .c-reference-wordbank, .c-instructor-note-container')
      .forEach((el) => el.remove());
    const rest = visibleText(other);
    if (rest) parts.push(`Reference: ${rest.slice(0, MAX_REFERENCE_CHARS)}`);
  }
  return parts;
}

function detectRealPage(doc: Document, url: URL): PageInfo {
  return {
    pageKey: 'main',
    pageType: 'activity',
    activityId: url.pathname,
    activityTitle: normalizeSpace(
      doc.querySelector('.js-activity-title')?.textContent ?? 'Activity',
    ),
    pagination: { index: 1, total: 1 },
    instructions: [
      visibleText(doc.querySelector('#direction_line') ?? doc.createElement('div')),
      ...referenceMaterial(doc),
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function extractRealQuestions(doc: Document, page: PageInfo): Question[] {
  const containers = Array.from(doc.querySelectorAll(`${ACTIVITY_FORM} ${QUESTION}`));
  const questions = containers.map((container, index) => {
    const number = String(index + 1);
    return extractQuestion(container, {
      id: container.id ? `q-${container.id}` : `q-${number}`,
      number,
      pageKey: page.pageKey,
      promptEl: container.querySelector(QUESTION_BODY) ?? container,
      excludeFromPrompt: (el) => el.matches(NOT_THE_QUESTION),
      markAllBlanks: true,
      blankAnchor: (control) => control.closest(DROPDOWN_WRAPPER) ?? control,
      customSelect: customSelectFor,
      // Every dropdown starts on a blank first entry whose value is "0".
      isPlaceholderOption: (option, index) => index === 0 && ['', '0', '-1'].includes(option.value),
    });
  });
  // A marked results page keeps the questions but has no boxes left to fill.
  return questions.filter((question) => question.fields.length > 0);
}

export const vhlAdapter: PlatformAdapter = {
  id: 'vhl',
  displayName: 'VHL Central',
  compatibility: 'mock_only',
  matchPatterns: ['https://*.vhlcentral.com/*'],
  matches: (url) => hostMatches(url, 'vhlcentral.com') || isPlaygroundUrl(url, 'vhl'),
  isReady(doc) {
    if (doc.querySelector(MOCK_ACTIVITY)) {
      return doc.querySelector(`${MOCK_ACTIVITY}[data-state="ready"]`) !== null;
    }
    if (doc.readyState === 'loading') return false;
    // Dropdowns are mounted by a script after load, and are empty until then.
    return !Array.from(doc.querySelectorAll(DROPDOWN_WRAPPER)).some(
      (w) => !w.querySelector('select'),
    );
  },
  detectPage(doc, url) {
    if (isRealActivity(doc)) return detectRealPage(doc, url);
    const root = doc.querySelector(MOCK_ACTIVITY);
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
  platformRestrictions(doc): RestrictionSignal[] {
    // These elements sit empty on ordinary activities, so only a timer showing a time counts.
    const running = Array.from(doc.querySelectorAll(TIMERS)).find(
      (timer) => !isHidden(timer) && /\d/.test(timer.textContent ?? ''),
    );
    return running ? [{ code: 'timed_assessment', evidence: 'Countdown timer on page' }] : [];
  },
  extractQuestions(doc, page) {
    if (isRealActivity(doc)) return extractRealQuestions(doc, page);
    return Array.from(doc.querySelectorAll('[data-vhl-item]')).map((container, index) => {
      const number = container.getAttribute('data-vhl-item') ?? String(index + 1);
      return extractQuestion(container, {
        id: `${page.pageKey}-i${number}`,
        number,
        pageKey: page.pageKey,
      });
    });
  },
  // A real activity is one page. Its only footer controls are Save and Submit, which stay manual.
  findNext: (doc) => (isRealActivity(doc) ? null : doc.querySelector('[data-vhl-next]')),
};
