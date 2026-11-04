import type {
  NavigationControl,
  PageAnalysis,
  PageType,
  Question,
  RestrictionSignal,
} from '@sima/shared-types';
import {
  detectRestrictions,
  isHidden,
  makeTarget,
  normalizeSpace,
  visibleText,
} from '@sima/page-analyzer';

export interface PageInfo {
  pageKey: string;
  pageType: PageType;
  activityId: string;
  activityTitle: string;
  pagination: { index: number; total: number };
  instructions: string;
}

/**
 * Everything platform-specific lives behind this interface. The engine knows nothing about
 * any site's selectors, and adding a platform means adding one adapter to the registry.
 */
export interface PlatformAdapter {
  id: string;
  displayName: string;
  /** Be honest here: `verified_live` only after testing on the real site. */
  compatibility: PageAnalysis['compatibility'];
  matchPatterns: string[];
  matches(url: URL): boolean;
  /** False while dynamic content is still rendering. */
  isReady(doc: Document): boolean;
  detectPage(doc: Document, url: URL): PageInfo | null;
  platformRestrictions(doc: Document): RestrictionSignal[];
  extractQuestions(doc: Document, page: PageInfo): Question[];
  findNext(doc: Document): Element | null;
}

export function isPlaygroundUrl(url: URL, path: string): boolean {
  return (
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.port === '5199' &&
    url.pathname.startsWith(`/${path}/`)
  );
}

export function hostMatches(url: URL, domain: string): boolean {
  return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
}

/** Labels that end an attempt rather than move through it. Sima never clicks these. */
export const FORBIDDEN_NAVIGATION =
  /\b(submit|finish|turn in|hand in|end (test|exam|quiz|attempt)|grade|complete assignment)\b/i;

export function toNavigationControl(el: Element | null): NavigationControl | null {
  if (!el || isHidden(el) || (el as HTMLButtonElement).disabled) return null;
  const label = normalizeSpace(
    el.getAttribute('aria-label') || visibleText(el) || el.textContent || '',
  );
  if (FORBIDDEN_NAVIGATION.test(label) || el.getAttribute('type') === 'submit') return null;
  return { target: makeTarget(el), label };
}

export function analyzePage(
  adapter: PlatformAdapter,
  doc: Document,
  url: URL,
): PageAnalysis | null {
  const page = adapter.detectPage(doc, url);
  if (!page) return null;
  const restriction = detectRestrictions(
    doc,
    page.activityTitle,
    adapter.platformRestrictions(doc),
  );
  const restricted = restriction.status === 'restricted' || page.pageType === 'assessment';
  // Nothing from a restricted page is extracted, so nothing can reach a model.
  const questions = restricted ? [] : adapter.extractQuestions(doc, page);
  const warnings: string[] = [];
  if (!restricted && page.pageType === 'activity' && questions.length === 0) {
    warnings.push(
      `No questions recognized. This ${adapter.displayName} layout may not be supported yet.`,
    );
  }
  if (adapter.compatibility === 'mock_only' && !isPlaygroundUrl(url, adapter.id)) {
    warnings.push(
      `The ${adapter.displayName} adapter has only been tested against a local mock, not this live site.`,
    );
  }
  return {
    platformId: adapter.id,
    platformName: adapter.displayName,
    compatibility: adapter.compatibility,
    pageKey: page.pageKey,
    pageType: restricted ? 'assessment' : page.pageType,
    activity: { id: page.activityId, title: page.activityTitle },
    pagination: page.pagination,
    instructions: page.instructions,
    restriction:
      restricted && restriction.status !== 'restricted'
        ? {
            status: 'restricted',
            signals: [{ code: 'platform_marker', evidence: 'Assessment page' }],
          }
        : restriction,
    questions,
    next: restricted ? null : toNavigationControl(adapter.findNext(doc)),
    warnings,
  };
}

export function findAdapter(adapters: PlatformAdapter[], url: URL): PlatformAdapter | null {
  return adapters.find((a) => a.matches(url)) ?? null;
}

export function waitForReady(
  adapter: PlatformAdapter,
  doc: Document,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (adapter.isReady(doc)) return resolve(true);
    const win = doc.defaultView;
    const started = Date.now();
    const timer = win?.setInterval(() => {
      if (adapter.isReady(doc)) {
        win.clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        win.clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}
