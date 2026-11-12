import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerResult } from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import {
  formatRedactedSummary,
  formatRunMarkdown,
  redactApplyRun,
  writeApplyReports,
} from './report.js';
import type { ApplyRun } from './types.js';

const markers = new Set<string>();
const mk = (name: string): string => {
  const s = `MK-${name}-${markers.size}`;
  markers.add(s);
  return s;
};
const PHONE = '+44 7700 900123';
const EMAIL = 'someone.private@example.org';
markers.add(PHONE);
markers.add(EMAIL);

function makeBank(): FactBank {
  return {
    version: '1',
    facts: [
      { text: mk('fact-one'), tags: [] },
      { text: mk('fact-two'), tags: [] },
    ],
    answers: [
      {
        id: 'known-one',
        question: mk('bank-question'),
        answer: mk('bank-answer'),
        tags: [],
      },
      {
        id: 'known-two',
        question: mk('bank-question-2'),
        variants: [{ when: mk('when'), answer: mk('variant-answer') }],
        tags: [],
      },
    ],
    stories: [
      {
        id: 'story-one',
        title: mk('story-title'),
        story: mk('story'),
        tags: ['x'],
      },
    ],
    fields: {
      firstName: mk('first'),
      lastName: mk('last'),
      fullName: mk('full'),
      email: EMAIL,
      phone: {
        countryCode: '+44',
        number: '7700 900123',
        country: mk('pc'),
        full: PHONE,
      },
      city: mk('city'),
      country: mk('country'),
      location: mk('location'),
      links: { linkedin: 'https://example.org/in/' + mk('li') },
      resume: mk('resume'),
    },
  } as unknown as FactBank;
}

const calls = [
  {
    role: 'answer' as const,
    model: 'm',
    latencyMs: 5,
    costUsd: 0.01,
    ok: true,
  },
];

function makeRun(bank: FactBank): ApplyRun {
  const fact = bank.facts[0]!.text;
  const backed: AnswerResult = {
    questionId: 's1-q1',
    required: true,
    calls,
    status: 'backed',
    value: PHONE,
    sources: [
      { kind: 'fact', text: fact },
      { kind: 'field', key: 'email' },
      { kind: 'answer', id: 'known-two', variant: 0 },
      { kind: 'story', id: 'story-one' },
      { kind: 'job-post', quote: mk('quote') },
      { kind: 'run-date' },
    ],
    derivation: 'composed',
    inferences: [
      { claim: mk('claim'), source: { kind: 'job-post', quote: mk('quote2') } },
    ],
    verification: { verdict: 'confirmed', rounds: 1 },
  };
  const blocked: AnswerResult = {
    questionId: 's2-q1',
    required: true,
    calls,
    status: 'blocked',
    reason: 'bank-silent',
    detail: mk('block-detail'),
  };
  return {
    jobId: 'job-abc',
    startedAt: '2026-11-12T10:20:30.123Z',
    outcome: 'safety-stop',
    stop: {
      kind: 'error',
      step: 2,
      detail: mk('stop-detail'),
      error: mk('stop-error'),
      pageErrors: [mk('page-error'), EMAIL],
      pathPrefix: '/jobs/',
    },
    job: {
      title: mk('title'),
      company: mk('company'),
      location: mk('job-location'),
      description: mk('description'),
      source: mk('job-source'),
    },
    questions: [
      {
        step: 1,
        question: {
          id: 's1-q1',
          label: mk('label'),
          type: 'text',
          options: [mk('opt-a'), mk('opt-b')],
          required: true,
          helpText: mk('help'),
          stepTitle: mk('step-title'),
        },
        result: backed,
        by: 'bot',
        filled: PHONE,
        changedFromLinkedIn: true,
      },
      {
        step: 2,
        question: {
          id: 's2-q1',
          label: mk('label2'),
          type: 'select',
          options: [mk('opt-c')],
          required: true,
        },
        result: blocked,
        by: 'author',
        filled: [mk('multi-a'), mk('multi-b')],
        changedFromLinkedIn: false,
        savedAs: 'saved-id',
        fillProblem: 'no-option',
      },
    ],
    unknownFields: [{ tag: 'div', role: 'slider', inputType: null }],
    timings: { totalMs: 1234, perStepMs: [100, 200] },
  };
}

/** Every string leaf in the run, so the markers can be checked to cover all. */
function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === 'object')
    Object.values(v).forEach((x) => leaves(x, out));
  return out;
}

const NOT_TEXT = new Set([
  'job-abc',
  '2026-11-12T10:20:30.123Z',
  'safety-stop',
  'error',
  '/jobs/',
  'div',
  'slider',
  's1-q1',
  's2-q1',
  'text',
  'select',
  'bot',
  'author',
  'saved-id',
  'no-option',
  'backed',
  'blocked',
  'bank-silent',
  'answer',
  'm',
  'fact',
  'field',
  'email',
  'story',
  'story-one',
  'known-two',
  'job-post',
  'run-date',
  'composed',
  'confirmed',
]);

describe('apply reports', () => {
  it('redacted copy holds no label', () => {
    const bank = makeBank();
    const run = makeRun(bank);
    // Every free-text string in the run is a marker.
    for (const s of leaves(run)) {
      expect(markers.has(s) || NOT_TEXT.has(s), s).toBe(true);
    }
    const redacted = redactApplyRun(run, bank);
    const json = JSON.stringify(redacted);
    const summary = formatRedactedSummary(redacted);
    for (const m of markers) {
      expect(json, m).not.toContain(m);
      expect(summary, m).not.toContain(m);
    }
    expect(json).not.toMatch(/\d{6,}/);
    expect(summary).not.toMatch(/\d{6,}/);
    expect(redacted.stop).toEqual({
      kind: 'error',
      step: 2,
      pathPrefix: '/jobs/',
    });
    expect(redacted.questions[0]!.result?.sources).toHaveLength(6);
    expect(summary).toContain('safety-stop');
    expect(summary).toContain('error');
  });

  it('markdown has every question and quotes its sources', () => {
    const bank = makeBank();
    const run = makeRun(bank);
    const md = formatRunMarkdown(run, bank);
    for (const q of run.questions) {
      expect(md).toContain(q.question.label);
      for (const o of q.question.options ?? []) expect(md).toContain(o);
    }
    expect(md).toContain(bank.facts[0]!.text);
    expect(md).toContain(bank.fields.email);
    expect(md).toContain(bank.answers[1]!.variants![0]!.answer);
    expect(md).toContain(bank.stories[0]!.story);
    expect(md).toContain('saved-id');
    expect(md).toContain('no-option');
    const first = run.questions[0]!.result as Extract<
      AnswerResult,
      { status: 'backed' }
    >;
    expect(md).toContain(first.inferences[0]!.claim);
    expect(md).toContain(run.stop!.error!);
    expect(md).toContain(run.stop!.pageErrors![0]!);
    expect(md).toContain(run.job!.title);
  });

  it('writes three files to the given dirs', () => {
    const bank = makeBank();
    const root = mkdtempSync(join(tmpdir(), 'apply-report-'));
    const dirs = {
      privateRuns: join(root, 'p', 'runs'),
      reports: join(root, 'r'),
    };
    const out = writeApplyReports(makeRun(bank), bank, dirs);
    expect(readdirSync(dirs.privateRuns).sort()).toEqual([
      '2026-11-12T10-20-30.123Z-job-abc.json',
      '2026-11-12T10-20-30.123Z-job-abc.md',
    ]);
    expect(readdirSync(dirs.reports)).toEqual([
      'apply-2026-11-12T10-20-30.123Z.json',
    ]);
    expect(existsSync(out.full)).toBe(true);
    expect(out.full.endsWith('.md')).toBe(true);
    expect(out.redacted.startsWith(dirs.reports)).toBe(true);
    const redactedText = readFileSync(out.redacted, 'utf8');
    for (const m of markers) expect(redactedText).not.toContain(m);
  });
});
