import type { Question } from '@sima/shared-types';
import { isHidden, normalizeSpace, visibleText } from './dom';
import { detectFields, inferFormat } from './fields';
import { findSuspiciousText, removeTextAimedAtAi } from './restrictions';

export interface QuestionExtractionOptions {
  id: string;
  number: string;
  pageKey: string;
  /** Element whose visible text is the question. Defaults to the container. */
  promptEl?: Element;
  /** Subtrees to leave out of the prompt, such as buttons or platform chrome. */
  excludeFromPrompt?: (el: Element) => boolean;
}

export function extractTables(root: Element): string[][][] {
  return Array.from(root.querySelectorAll('table'))
    .filter((table) => !isHidden(table))
    .map((table) =>
      Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th, td')).map((cell) => visibleText(cell)),
      ),
    );
}

export function extractImages(root: Element): Array<{ src: string; alt: string }> {
  return Array.from(root.querySelectorAll('img'))
    .filter((img) => !isHidden(img))
    .map((img) => ({
      src: img.getAttribute('src') ?? '',
      alt: normalizeSpace(img.getAttribute('alt') ?? ''),
    }));
}

/** Builds a Question from one question container. Platform adapters choose the containers. */
export function extractQuestion(container: Element, options: QuestionExtractionOptions): Question {
  const fields = detectFields(container, options.id);
  // Unlabeled blanks are identified by where they sit, so mark that in the question text.
  const blanks = fields.filter((f) => !f.label && f.options.length === 0);
  const markers = new Map<Element, string>();
  if (blanks.length > 1) {
    for (const blank of blanks) {
      const el = container.ownerDocument.querySelector(blank.target.selector);
      if (el) markers.set(el, `[${blank.key}]`);
    }
  }
  const promptRoot = options.promptEl ?? container;
  const prompt = visibleText(
    promptRoot,
    (el) => {
      if (el.tagName === 'TABLE' || el.tagName === 'LABEL') return true;
      return options.excludeFromPrompt?.(el) ?? false;
    },
    markers,
  );
  return {
    id: options.id,
    pageKey: options.pageKey,
    number: options.number,
    prompt: removeTextAimedAtAi(prompt),
    format: inferFormat(fields, prompt),
    tables: extractTables(container),
    images: extractImages(container),
    fields,
    suspiciousText: findSuspiciousText(visibleText(container)),
  };
}
