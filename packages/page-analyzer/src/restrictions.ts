import type { Restriction, RestrictionSignal } from '@sima/shared-types';
import { visibleText } from './dom';

const TITLE_PATTERN = /\b(exam|midterm|final|test|quiz|assessment)\b/i;
const NOT_RESTRICTED_TITLE = /\b(practice|study guide|review sheet|self[- ]check)\b/i;

const BODY_RULES: Array<{ code: RestrictionSignal['code']; pattern: RegExp }> = [
  { code: 'lockdown_browser', pattern: /\b(lockdown browser|respondus|safe exam browser)\b/i },
  { code: 'proctoring', pattern: /\b(proctor(ed|ing|u)?|honorlock|examity|exam monitor)\b/i },
  {
    code: 'ai_prohibited',
    pattern:
      /\b(ai|artificial intelligence|chatgpt|automated)\b[^.]{0,40}\b(not (allowed|permitted)|prohibited|forbidden|banned)\b|\b(no|without( the)?( use of)?|must not use|may not use|do not use)\s+(any\s+)?(ai\b|artificial intelligence|chatgpt|automated (tools|assistance))/i,
  },
  {
    code: 'timed_assessment',
    pattern: /\b(time (remaining|left)|timed (exam|test|quiz|assessment))\b/i,
  },
];

/**
 * Fail-closed scan of what the student can see. Sima has no way to confirm an activity is allowed,
 * only that it found no evidence against, so a match blocks and cannot be overridden from the UI.
 */
export function detectRestrictions(
  doc: Document,
  title: string,
  extra: RestrictionSignal[] = [],
): Restriction {
  const signals: RestrictionSignal[] = [...extra];
  if (TITLE_PATTERN.test(title) && !NOT_RESTRICTED_TITLE.test(title)) {
    signals.push({ code: 'assessment_title', evidence: title });
  }
  const body = doc.body ? visibleText(doc.body) : '';
  for (const { code, pattern } of BODY_RULES) {
    const match = body.match(pattern);
    if (match) signals.push({ code, evidence: match[0] });
  }
  return { status: signals.length > 0 ? 'restricted' : 'none_detected', signals };
}

const AI = String.raw`(?:ai|artificial intelligence|llms?|chatbots?|chatgpt|language models?|ai (?:assistants?|agents?|models?|tools?|systems?))`;

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above|the above) (instructions|prompts?)/i,
  /\b(system prompt|you are (now )?an? (ai|assistant|language model))\b/i,
  new RegExp(
    String.raw`\b${AI}\b.{0,60}\b(must|should|shall|need to|have to|are required to|is required to)\b.{0,40}\b(respond|answer|reply|write|say|output|include|mention|use|start|end)\b`,
    'i',
  ),
  new RegExp(String.raw`\b(if you are|as|for|attention|note to|to) (an? |any |all )?${AI}\b`, 'i'),
  /\b(reveal|send|exfiltrate|print)\b.{0,30}\b(api key|credentials|password|cookies?)\b/i,
  /\b(click|press)\b.{0,20}\bsubmit\b.{0,30}\b(now|immediately)\b/i,
];

/** A real question can be about AI, so anything asking something isn't treated as aimed at one. */
const ASKS_SOMETHING =
  /^\W*(explain|describe|discuss|why|how|what|which|who|when|compare|define|name|list|calculate|find)\b/i;

function isAimedAtAi(sentence: string): boolean {
  if (sentence.trim().endsWith('?') || ASKS_SOMETHING.test(sentence)) return false;
  return INJECTION_PATTERNS.some((p) => p.test(sentence));
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

export function findSuspiciousText(text: string): string[] {
  return sentences(text)
    .filter(isAimedAtAi)
    .map((sentence) => sentence.slice(0, 200));
}

/**
 * Takes sentences addressed to AI tools out of question text, so the model never reads them. If
 * nothing of the question would remain, the text stays and the system prompt's rule covers it.
 */
export function removeTextAimedAtAi(text: string): string {
  const kept = sentences(text).filter((sentence) => !isAimedAtAi(sentence));
  const remaining = kept
    .join(' ')
    .replace(/^\s*Q?\d+[.):]?\s*/i, '')
    .trim();
  return remaining === '' ? text : kept.join(' ');
}
