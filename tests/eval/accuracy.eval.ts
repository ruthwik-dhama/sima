// Scores a real local model on the mock questions, which have known answers.
// Run with: SIMA_EVAL_MODEL=llama3.2 pnpm eval
import { appendFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { analyzePage, findAdapter } from '@sima/adapter-core';
import { gradescopeAdapter } from '@sima/adapter-gradescope';
import { vhlAdapter } from '@sima/adapter-vhl';
import { webassignAdapter } from '@sima/adapter-webassign';
import { createOllamaProvider } from '@sima/model-providers';
import { autoFillHold } from '@sima/action-planner';
import { solveQuestion } from '@sima/reasoning-engine';
import type { Question, QuestionRecord } from '@sima/shared-types';
import { startPlayground } from '../../playground/server.mjs';
import { loadMock } from '../helpers';

const MODEL = process.env.SIMA_EVAL_MODEL ?? 'llama3.2';
const RUNS = Number(process.env.SIMA_EVAL_RUNS ?? 3);
const PAGES = [
  '/gradescope/assignment.html',
  '/vhl/activity.html?page=1',
  '/vhl/activity.html?page=2',
  '/webassign/assignment.html?q=1',
  '/webassign/assignment.html?q=2',
  '/webassign/assignment.html?q=3',
];
/** Accepted answers per field. Written responses are skipped, as they have no single answer. */
const KEY: Record<string, (values: string[]) => boolean> = {
  q1: (v) => v.join() === 'b',
  q2: (v) => [...v].sort().join() === 'eleven,two',
  q3: (v) => Number(v[0]) === 93,
  q5: (v) => Number(v[0]) === 2.2,
  p1i1: (v) => v[0]?.trim().toLowerCase() === 'soy',
  p1i2: (v) => v[0]?.trim().toLowerCase() === 'vivió',
  m1: (v) => v.join() === 'apple',
  m2: (v) => v.join() === 'book',
  art: (v) => v.join() === 'la',
  speed: (v) => v[0]?.trim() === '12.5',
  speed_unit: (v) => v.join() === 'm/s',
  accel: (v) => v.join() === '0',
  ke: (v) => Number(v[0]) === 9,
  blank_a: (v) => ['2', '3'].includes(v[0]?.trim() ?? ''),
  blank_b: (v) => ['2', '3'].includes(v[0]?.trim() ?? ''),
};

const say = (line: string) => {
  console.log(line);
  if (process.env.SIMA_EVAL_OUT) appendFileSync(process.env.SIMA_EVAL_OUT, `${line}\n`);
};

let server: Pick<Server, 'close'>;
beforeAll(async () => {
  server = await startPlayground(5199);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

it(`accuracy of ${MODEL}`, { timeout: 1_800_000 }, async () => {
  const adapters = [gradescopeAdapter, vhlAdapter, webassignAdapter];
  const provider = createOllamaProvider({ apiKey: '' });
  const questions: Array<{ question: Question; instructions: string }> = [];
  for (const path of PAGES) {
    const url = new URL(`http://127.0.0.1:5199${path}`);
    const adapter = findAdapter(adapters, url)!;
    const dom = await loadMock(url.href, adapter);
    const analysis = analyzePage(adapter, dom.window.document, url)!;
    for (const question of analysis.questions) {
      questions.push({ question, instructions: analysis.instructions });
    }
  }

  const tally = new Map<string, { right: number; total: number; wrong: string[] }>();
  let solved = 0;
  let unusable = 0;
  const rightConfidence: number[] = [];
  const wrongConfidence: number[] = [];
  const mean = (list: number[]) =>
    Math.round((list.reduce((a, b) => a + b, 0) / Math.max(list.length, 1)) * 100);
  let autoEntered = 0;
  let autoRight = 0;
  const started = Date.now();
  for (let run = 0; run < RUNS; run++) {
    for (const { question, instructions } of questions) {
      let answers: Record<string, string[]> = {};
      let held = true;
      let confidence = 0;
      try {
        const solution = await solveQuestion(question, instructions, (prompt, schema, schemaName) =>
          provider.completeStructured({ ...prompt, schema, schemaName, model: MODEL }),
        );
        confidence = solution.adjustedConfidence;
        held =
          autoFillHold({
            question,
            solution,
            solveError: null,
            responses: {},
          } as unknown as QuestionRecord) !== null;
        answers = Object.fromEntries(solution.answers.map((a) => [a.fieldKey, a.values]));
        solved++;
      } catch {
        unusable++;
      }
      for (const field of question.fields) {
        const check = KEY[field.key];
        if (!check) continue;
        const entry = tally.get(field.key) ?? { right: 0, total: 0, wrong: [] };
        const values = answers[field.key] ?? [];
        entry.total++;
        if (check(values)) {
          entry.right++;
          rightConfidence.push(confidence);
        } else {
          entry.wrong.push(JSON.stringify(values));
          wrongConfidence.push(confidence);
        }
        if (!held) {
          autoEntered++;
          if (check(values)) autoRight++;
        }
        tally.set(field.key, entry);
      }
    }
  }

  let right = 0;
  let total = 0;
  for (const [key, entry] of tally) {
    right += entry.right;
    total += entry.total;
    say(`${key.padEnd(11)} ${entry.right}/${entry.total}  ${entry.wrong.slice(0, 3).join(' ')}`);
  }
  say(`\nMODEL ${MODEL}: ${right}/${total} fields correct (${Math.round((right / total) * 100)}%)`);
  say(`One-click fill would enter ${autoEntered}/${total} fields, ${autoRight} of them correct`);
  say(
    `Shown confidence: ${mean(rightConfidence)}% on right answers, ${mean(wrongConfidence)}% on wrong ones`,
  );
  say(
    `Solved ${solved}, unusable ${unusable}, ${Math.round((Date.now() - started) / 1000 / (solved + unusable))}s per question`,
  );
  expect(total).toBeGreaterThan(0);
});
