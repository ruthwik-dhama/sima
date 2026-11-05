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
import { chunkForSolving, solveBatch } from '@sima/reasoning-engine';
import type { Question, QuestionRecord, ValidatedSolution } from '@sima/shared-types';
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
  '/vhl/live-matching.html',
  '/vhl/live-subjunctive.html',
  '/vhl/live-wordbank.html',
];
/** Accepted answers per field. Written responses are skipped, as they have no single answer. */
const KEY: Record<string, (values: string[]) => boolean> = {
  question_501_0: (v) => v[0]?.trim().toLowerCase() === 'busco el libro',
  question_502_0: (v) => v[0]?.trim().toLowerCase() === '¿viste la película',
  question_503_0: (v) => v[0]?.trim().toLowerCase() === 'necesito el número del dentista',
  question_504_0: (v) => v[0]?.trim().toLowerCase() === '¿dónde compraste los zapatos',
  question_505_0: (v) => v[0]?.trim().toLowerCase() === '¿quién se comió la pizza',
  question_506_0: (v) => v[0]?.trim().toLowerCase() === 'prefiero un jefe',
  question_507_0: (v) => v[0]?.trim().toLowerCase() === 'no conozco a nadie',
  question_508_0: (v) => v[0]?.trim().toLowerCase() === 'quiero una bicicleta',
  question_509_0: (v) => v[0]?.trim().toLowerCase() === '¿me recomiendas un restaurante',
  question_601_wol_0: (v) => v[0]?.trim().toLowerCase() === 'pague',
  question_602_wol_0: (v) => v[0]?.trim().toLowerCase() === 'entiendan',
  question_603_wol_0: (v) => v[0]?.trim().toLowerCase() === 'enseñe',
  question_604_wol_0: (v) => v[0]?.trim().toLowerCase() === 'sepa',
  question_605_wol_0: (v) => v[0]?.trim().toLowerCase() === 'protejan',
  question_606_wol_0: (v) => v[0]?.trim().toLowerCase() === 'esté',
  question_607_wol_0: (v) => v[0]?.trim().toLowerCase() === 'tenga',
  question_608_wol_0: (v) => v[0]?.trim().toLowerCase() === 'sea',
  question_701_wol_0: (v) => v[0]?.trim().toLowerCase() === 'me despierto',
  question_702_wol_0: (v) => v[0]?.trim().toLowerCase() === 'se acuestan',
  question_703_wol_0: (v) => v[0]?.trim().toLowerCase() === 'te duchas',
  question_704_wol_0: (v) => v[0]?.trim().toLowerCase() === 'nos lavamos',
  question_705_wol_0: (v) => v[0]?.trim().toLowerCase() === 'se queja',
  question_706_wol_0: (v) => v[0]?.trim().toLowerCase() === 'se visten',
  question_707_wol_0: (v) => v[0]?.trim().toLowerCase() === 'me voy',
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
  const provider = createOllamaProvider();
  const pages: Array<{ list: Question[]; instructions: string }> = [];
  for (const path of PAGES.filter((page) => page.includes(process.env.SIMA_EVAL_ONLY ?? ''))) {
    const url = new URL(`http://127.0.0.1:5199${path}`);
    const adapter = findAdapter(adapters, url)!;
    const dom = await loadMock(url.href, adapter);
    const analysis = analyzePage(adapter, dom.window.document, url)!;
    pages.push({ list: analysis.questions, instructions: analysis.instructions });
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
    const units = pages.flatMap(({ list, instructions }) =>
      chunkForSolving(list).map((group) => ({ group, instructions })),
    );
    for (const { group, instructions } of units) {
      let solutions = new Map<string, ValidatedSolution>();
      try {
        solutions = await solveBatch(group, instructions, (prompt, schema, schemaName) =>
          provider.completeStructured({ ...prompt, schema, schemaName, model: MODEL }),
        );
        solved++;
      } catch {
        unusable++;
      }
      for (const question of group) {
        const solution = solutions.get(question.id);
        const confidence = solution?.adjustedConfidence ?? 0;
        const held =
          !solution ||
          autoFillHold({
            question,
            solution,
            solveError: null,
            responses: {},
          } as unknown as QuestionRecord) !== null;
        const answers: Record<string, string[]> = Object.fromEntries(
          (solution?.answers ?? []).map((a) => [a.fieldKey, a.values]),
        );
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
  }

  let right = 0;
  let total = 0;
  const sets: Record<string, [number, number]> = {
    'matching (VHL style)': [0, 0],
    'subjunctive (VHL style)': [0, 0],
    'word list (VHL style)': [0, 0],
    'original mock questions': [0, 0],
  };
  for (const [key, entry] of tally) {
    const name = /_50\d_/.test(key)
      ? 'matching (VHL style)'
      : /_60\d_/.test(key)
        ? 'subjunctive (VHL style)'
        : /_70\d_/.test(key)
          ? 'word list (VHL style)'
          : 'original mock questions';
    sets[name]![0] += entry.right;
    sets[name]![1] += entry.total;
  }
  for (const [name, [r, t]] of Object.entries(sets)) say(`SET ${name}: ${r}/${t}`);
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
