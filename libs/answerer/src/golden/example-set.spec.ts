import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMap, isSeq, parseDocument } from 'yaml';
import { loadFactBank } from '@xapply/fact-bank';
import { answerQuestion } from '../answer.js';
import { fieldValue } from '../fields.js';
import type { ModelCaller } from '../model/caller.js';
import { TEXT_TYPES, type FieldType } from '../types.js';
import { loadGolden } from './format.js';
import { scoreCase } from './score.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, '..', '..', 'golden', 'example.yaml');
const exampleBankPath = join(
  here,
  '..',
  '..',
  '..',
  'fact-bank',
  'fact-bank.example.yaml',
);

const file = loadGolden(examplePath);
const bank = loadFactBank(exampleBankPath);

describe('golden/example.yaml', () => {
  it('loads, against the example bank, on the spec run date', () => {
    expect(file.bank).toBe(exampleBankPath);
    expect(file.runDate).toBe('2026-11-12');
    expect(file.jobs.default).toMatchObject({
      title: 'Backend Engineer',
      company: 'Acme Payments',
    });
    const paragraphs = file.jobs.default?.description
      .split(/\n\s*\n/)
      .filter((p) => p.trim() !== '');
    expect(paragraphs?.length).toBeGreaterThanOrEqual(3);
    expect(file.jobs.default?.description).toContain('Kubernetes');
    expect(file.jobs.default?.description).toMatch(/code\s+review/);
  });

  it('references only facts, answers, stories and fields the example bank has', () => {
    const answerIds = new Set(bank.answers.map((a) => a.id));
    const storyIds = new Set(bank.stories.map((s) => s.id));
    const bad: string[] = [];
    for (const c of file.cases) {
      const e = c.expect;
      for (const s of e.sources ?? []) {
        if ('fact' in s && bank.facts[s.fact] === undefined)
          bad.push(`${c.id}: fact ${s.fact}`);
        if ('answer' in s && !answerIds.has(s.answer))
          bad.push(`${c.id}: answer ${s.answer}`);
        if ('story' in s && !storyIds.has(s.story))
          bad.push(`${c.id}: story ${s.story}`);
        if ('field' in s && fieldValue(s.field, bank) === undefined)
          bad.push(`${c.id}: field ${s.field}`);
      }
      const from = e.valueFrom;
      if (from && 'answer' in from) {
        const a = bank.answers.find((x) => x.id === from.answer);
        if (a?.answer === undefined)
          bad.push(`${c.id}: valueFrom answer without a plain answer`);
      }
      if (e.valueFrom && 'field' in e.valueFrom) {
        if (fieldValue(e.valueFrom.field, bank) === undefined)
          bad.push(`${c.id}: valueFrom field ${e.valueFrom.field}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every backed case its sources, and every backed text case mustNotClaim', () => {
    const isText = (t: string) => (TEXT_TYPES as readonly string[]).includes(t);
    for (const c of file.cases) {
      if (c.expect.status !== 'backed') continue;
      expect(c.expect.sources?.length ?? 0, c.id).toBeGreaterThan(0);
      // Free text: composed, or left open where the answerer may compose.
      if (
        isText(c.question.type) &&
        (c.expect.derivation === undefined ||
          c.expect.derivation === 'composed')
      ) {
        expect(c.expect.mustNotClaim?.length ?? 0, c.id).toBeGreaterThan(0);
      }
    }
  });

  it('gives every case a comment saying which rule it tests', () => {
    const doc = parseDocument(readFileSync(examplePath, 'utf8'));
    const cases = doc.get('cases');
    expect(isSeq(cases)).toBe(true);
    const missing: string[] = [];
    if (isSeq(cases)) {
      for (const [i, item] of cases.items.entries()) {
        if (!isMap(item)) continue;
        // The first item's comment attaches to the list itself.
        const comment =
          item.commentBefore ?? (i === 0 ? cases.commentBefore : undefined);
        if (!(comment ?? '').trim()) missing.push(String(item.get('id')));
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers every field key and every block reason a case can pin', () => {
    const fieldKeys = new Set(
      file.cases.flatMap((c) =>
        (c.expect.sources ?? []).flatMap((s) =>
          'field' in s ? [s.field] : [],
        ),
      ),
    );
    expect([...fieldKeys].sort()).toEqual(
      [
        'firstName',
        'lastName',
        'fullName',
        'email',
        'phone',
        'phoneCountryCode',
        'phoneCountry',
        'city',
        'location',
        'country',
        'linkedin',
        'github',
        'portfolio',
        'resume',
      ].sort(),
    );
    expect(file.cases.map((c) => c.id)).toContain('field-website-empty');
    const reasons = new Set(file.cases.map((c) => c.expect.reason));
    for (const r of [
      'bank-silent',
      'no-story-fits',
      'boundary',
      'unsupported-field',
    ]) {
      expect(reasons.has(r as never), r).toBe(true);
    }
    const types = new Set(file.cases.map((c) => c.question.type as FieldType));
    for (const t of [
      'text',
      'textarea',
      'number',
      'select',
      'radio',
      'checkbox-group',
      'checkbox',
      'file',
      'typeahead',
    ] as const) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it('passes every case that code answers without a model', async () => {
    const noModel: ModelCaller = {
      call: () => Promise.reject(new Error('model call')),
    };
    const scored: string[] = [];
    for (const c of file.cases) {
      const job = file.jobs[c.job ?? 'default'];
      if (!job) throw new Error(`no job for ${c.id}`);
      const ctx = {
        bank,
        job,
        runDate: file.runDate,
        caller: noModel,
        models: { answerModel: 'a', verifyModel: 'v', maxRegenerations: 1 },
      };
      let result;
      try {
        result = await answerQuestion(c.question, ctx);
      } catch {
        continue; // needs a model: run live in the eval.
      }
      const score = scoreCase(c, result, { bank, job });
      expect(score.problems, c.id).toEqual([]);
      scored.push(c.id);
    }
    // 14 filled fields, the empty website, the email over maxLength, the
    // cover letter and the date field.
    expect(scored).toHaveLength(18);
  });
});
