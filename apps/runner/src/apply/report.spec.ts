import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerResult } from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import {
  closingLine,
  formatRedactedSummary,
  formatRunMarkdown,
  redactApplyRun,
  writeApplyReports,
} from './report.js';
import type { Claim } from '@xapply/disqualify';
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

/** The value, or a thrown error naming what was missing: no `!`. */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

function makeRun(bank: FactBank): ApplyRun {
  const fact = must(bank.facts[0]).text;
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
    jobId: '4489088601',
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
    unknownFields: [
      { tag: 'div', role: 'slider', inputType: null, label: mk('unknown') },
    ],
    checks: [],
    disqualification: null,
    via: null,
    record: { before: null, beforeAt: null, after: null },
    timings: { totalMs: 1234, perStepMs: [100, 200], submit: null },
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
  '4489088601',
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
    expect(redacted.jobId).toBe('4489088601');
    // Only the job id may hold a long digit run.
    expect(JSON.stringify({ ...redacted, jobId: '' })).not.toMatch(/\d{6,}/);
    expect(summary).not.toMatch(/\d{6,}/);
    expect(redacted.stop).toEqual({
      kind: 'error',
      step: 2,
      pathPrefix: '/jobs/',
    });
    expect(must(redacted.questions[0]).result?.sources).toHaveLength(6);
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
    expect(md).toContain(must(bank.facts[0]).text);
    expect(md).toContain(bank.fields.email);
    expect(md).toContain(must(must(must(bank.answers[1]).variants)[0]).answer);
    expect(md).toContain(must(bank.stories[0]).story);
    expect(md).toContain('saved-id');
    expect(md).toContain('no-option');
    const first = must(run.questions[0]).result as Extract<
      AnswerResult,
      { status: 'backed' }
    >;
    expect(md).toContain(must(first.inferences[0]).claim);
    expect(md).toContain(must(must(run.stop).error));
    expect(md).toContain(must(must(must(run.stop).pageErrors)[0]));
    expect(md).toContain(must(run.job).title);
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
      '2026-11-12T10-20-30.123Z-4489088601.json',
      '2026-11-12T10-20-30.123Z-4489088601.md',
    ]);
    expect(readdirSync(dirs.reports)).toEqual([
      'apply-2026-11-12T10-20-30.123Z.json',
    ]);
    expect(existsSync(out.full)).toBe(true);
    expect(out.full.endsWith('.md')).toBe(true);
    expect(out.redacted.startsWith(dirs.reports)).toBe(true);
    const redactedText = readFileSync(out.redacted, 'utf8');
    for (const m of markers) expect(redactedText).not.toContain(m);
    const back = JSON.parse(redactedText) as { jobId: string };
    expect(back.jobId).toBe('4489088601');
    expect(JSON.stringify({ ...back, jobId: '' })).not.toMatch(/\d{6,}/);
  });

  it('refuses a job id that is not all digits', () => {
    const bank = makeBank();
    const root = mkdtempSync(join(tmpdir(), 'apply-report-'));
    const dirs = { privateRuns: join(root, 'p'), reports: join(root, 'r') };
    for (const bad of ['../x', 'job-abc', '', '12 3']) {
      expect(() =>
        writeApplyReports({ ...makeRun(bank), jobId: bad }, bank, dirs),
      ).toThrow(/job id/);
    }
    expect(existsSync(dirs.privateRuns)).toBe(false);
  });

  it("a pace refusal's message is in the full report, not the redacted copy", () => {
    const bank = makeBank();
    const message = 'pace: target is still off-screen after 40 wheel notches';
    const run: ApplyRun = {
      ...makeRun(bank),
      stop: {
        kind: 'unexpected-page',
        step: 2,
        detail: 'the page did not take an input',
        error: message,
        pathPrefix: '/jobs/',
      },
    };
    expect(formatRunMarkdown(run, bank)).toContain(`Error: ${message}`);
    const redacted = redactApplyRun(run, bank);
    expect(JSON.stringify(redacted)).not.toContain(message);
    expect(formatRedactedSummary(redacted)).not.toContain(message);
  });

  it('an unverified fill shows in the full report and keeps its word in the redacted one', () => {
    const bank = makeBank();
    const base = makeRun(bank);
    const [first] = base.questions;
    const run: ApplyRun = {
      ...base,
      questions: first ? [{ ...first, fillProblem: 'unverified' }] : [],
    };
    expect(formatRunMarkdown(run, bank)).toContain('fill problem: unverified');
    expect(redactApplyRun(run, bank).questions[0]?.fillProblem).toBe(
      'unverified',
    );
  });

  describe('requirements', () => {
    const claim = (over: Partial<Claim>): Claim => ({
      kind: 'asks-sponsorship',
      countries: ['US'],
      countryFrom: 'text',
      quote: 'QUOTE-MARK | a\nb',
      placeQuote: 'PLACE-MARK',
      source: 's2-q1',
      detail: 'DETAIL-MARK',
      ...over,
    });
    const disq = claim({});
    const log = claim({
      kind: 'language-requirement',
      countries: [],
      source: 'job-page',
      quote: 'QUOTE-MARK-2',
      detail: 'DETAIL-MARK-2',
    });
    const unclear = claim({
      kind: 'requires-authorization',
      countries: [],
      source: 's1-u1',
    });
    const dq = (bank: FactBank): ApplyRun => ({
      ...makeRun(bank),
      outcome: 'disqualified',
      stop: undefined,
      unknownFields: [
        { tag: 'div', role: null, inputType: null, label: 'LABEL-MARK' },
      ],
      checks: [
        { at: 'job-page', step: null, ok: true, claims: [log], calls: [] },
        {
          at: 'step',
          step: 2,
          ok: true,
          claims: [disq, unclear],
          calls: [
            {
              role: 'extract',
              model: 'opus',
              latencyMs: 9,
              costUsd: 0.02,
              ok: true,
            },
          ],
        },
      ],
      disqualification: [disq, unclear],
    });

    it('redacts claims to kind, countries, countryFrom and source', () => {
      const bank = makeBank();
      const redacted = redactApplyRun(dq(bank), bank);
      const json = JSON.stringify(redacted);
      for (const m of [
        'QUOTE-MARK',
        'PLACE-MARK',
        'DETAIL-MARK',
        'LABEL-MARK',
        'quote',
        'detail',
        'placeQuote',
        'label',
      ])
        expect(json, m).not.toContain(m);
      expect(redacted.disqualification).toEqual([
        {
          kind: 'asks-sponsorship',
          countries: ['US'],
          countryFrom: 'text',
          source: 's2-q1',
        },
        {
          kind: 'requires-authorization',
          countries: [],
          countryFrom: 'text',
          source: 's1-u1',
        },
      ]);
      expect(redacted.checks).toHaveLength(2);
      expect(redacted.checks[1]?.calls).toHaveLength(1);
      expect(redacted.checks[1]?.step).toBe(2);
      expect(redacted.checks[1]?.ok).toBe(true);
      expect(redactApplyRun(makeRun(bank), bank).disqualification).toBeNull();
    });

    it('the summary headline names kind, countries and source', () => {
      const bank = makeBank();
      const one = redactApplyRun(
        { ...dq(bank), disqualification: [disq] },
        bank,
      );
      expect(formatRedactedSummary(one)).toContain(
        'disqualified: asks-sponsorship US at s2-q1\n',
      );
      const two = formatRedactedSummary(redactApplyRun(dq(bank), bank));
      expect(two).toContain(
        'disqualified: asks-sponsorship US at s2-q1 (+1 more)',
      );
      const none = formatRedactedSummary(
        redactApplyRun({ ...dq(bank), disqualification: [unclear] }, bank),
      );
      expect(none).toContain(
        'disqualified: requires-authorization unclear at s1-u1',
      );
      expect(
        formatRedactedSummary(redactApplyRun(makeRun(bank), bank)),
      ).not.toContain('disqualified:');
    });

    it('the markdown lists every claim with its quote and a verdict', () => {
      const bank = makeBank();
      const md = formatRunMarkdown(dq(bank), bank);
      expect(md).toContain('## Requirements');
      expect(md).toContain('QUOTE-MARK \\| a b');
      expect(md).toContain('QUOTE-MARK-2');
      expect(md).toContain('PLACE-MARK');
      expect(md).toContain('DETAIL-MARK');
      expect(md).toContain(
        'Verdict: disqualified: asks-sponsorship US at s2-q1',
      );
      // A rule kind with no countries is unclear; a log kind's is none.
      expect(md).toContain('| s1-u1 | requires-authorization | unclear |');
      expect(md).toContain('| job-page | language-requirement | - |');
      expect(md.indexOf('## Outcome')).toBeLessThan(
        md.indexOf('## Requirements'),
      );
    });

    it('location claims in the requirements table', () => {
      const bank = makeBank();
      const reqLoc = claim({
        kind: 'requires-location',
        countries: [],
        source: 'job-page',
        quote: 'QUOTE-LOC',
        detail: 'DETAIL-LOC',
      });
      const pref = claim({
        kind: 'location-preference',
        countries: [],
        source: 'job-page',
        quote: 'QUOTE-PREF',
        detail: 'DETAIL-PREF',
      });
      const run: ApplyRun = {
        ...dq(bank),
        checks: [
          {
            at: 'job-page',
            step: null,
            ok: true,
            claims: [reqLoc, pref],
            calls: [],
          },
        ],
        disqualification: [reqLoc],
      };
      const md = formatRunMarkdown(run, bank);
      expect(md).toContain('| job-page | requires-location | unclear |');
      expect(md).toContain('| job-page | location-preference | - |');
      const redacted = redactApplyRun(run, bank);
      const json = JSON.stringify(redacted);
      for (const m of ['DETAIL-LOC', 'DETAIL-PREF', 'QUOTE-LOC', 'detail'])
        expect(json, m).not.toContain(m);
      expect(redacted.disqualification?.[0]).toMatchObject({
        kind: 'requires-location',
        countries: [],
      });
    });

    const reached = (bank: FactBank): ApplyRun => ({
      ...makeRun(bank),
      outcome: 'reached-review',
      stop: undefined,
    });

    it('a pass verdict, and no claims', () => {
      const bank = makeBank();
      const passing: ApplyRun = {
        ...reached(bank),
        checks: [
          { at: 'job-page', step: null, ok: true, claims: [log], calls: [] },
        ],
      };
      const md = formatRunMarkdown(passing, bank);
      expect(md).toContain('Verdict: pass');
      const empty = formatRunMarkdown(
        {
          ...reached(bank),
          checks: [
            { at: 'job-page', step: null, ok: true, claims: [], calls: [] },
          ],
        },
        bank,
      );
      expect(empty).toContain('No requirements found.');
      expect(empty).toContain('Verdict: pass');
    });

    it('a check-failed run is not decided and its requirements are not known', () => {
      const bank = makeBank();
      const failed: ApplyRun = {
        ...makeRun(bank),
        outcome: 'safety-stop',
        stop: {
          kind: 'check-failed',
          step: null,
          detail: 'the requirements check did not give a valid answer',
          pathPrefix: '/jobs/',
        },
        checks: [
          { at: 'job-page', step: null, ok: false, claims: [], calls: [] },
        ],
      };
      const md = formatRunMarkdown(failed, bank);
      expect(md).not.toContain('No requirements found.');
      expect(md).toContain('1 check failed');
      expect(md).toContain('Verdict: not decided (safety-stop/check-failed)');
      expect(md).not.toContain('Verdict: pass');
      expect(redactApplyRun(failed, bank).checks[0]?.ok).toBe(false);
      // A failed round after claims were found still says so.
      const later = formatRunMarkdown(
        {
          ...failed,
          checks: [
            { at: 'job-page', step: null, ok: true, claims: [log], calls: [] },
            { at: 'step', step: 1, ok: false, claims: [], calls: [] },
          ],
        },
        bank,
      );
      expect(later).toContain('1 check failed');
      expect(later).toContain(
        'Verdict: not decided (safety-stop/check-failed)',
      );
    });

    it('a stopped run is not decided, never pass', () => {
      const bank = makeBank();
      const stopped: ApplyRun = {
        ...makeRun(bank),
        outcome: 'stopped',
        stop: {
          kind: 'bridge',
          step: 1,
          detail: 'interrupted',
          pathPrefix: '/jobs/',
        },
        checks: [
          { at: 'job-page', step: null, ok: true, claims: [log], calls: [] },
        ],
      };
      const md = formatRunMarkdown(stopped, bank);
      expect(md).toContain('Verdict: not decided (stopped/bridge)');
      expect(md).not.toContain('Verdict: pass');
      const none = formatRunMarkdown({ ...stopped, checks: [] }, bank);
      expect(none).toContain('No checks ran.');
      expect(none).not.toContain('No requirements found.');
      expect(none).toContain('Verdict: not decided (stopped/bridge)');
    });
  });
});

describe('closingLine', () => {
  const base = (over: Partial<ApplyRun>): ApplyRun => ({
    ...makeRun(makeBank()),
    stop: undefined,
    via: null,
    record: { before: null, beforeAt: null, after: null },
    ...over,
  });
  const rec = (r: Partial<ApplyRun['record']>): ApplyRun['record'] => ({
    before: null,
    beforeAt: null,
    after: null,
    ...r,
  });

  it.each([
    [
      { outcome: 'submitted', record: rec({ after: 'applied' }) },
      'submitted; LinkedIn shows Applied',
    ],
    [
      { outcome: 'submitted', record: rec({ after: 'submitting' }) },
      'submitted; LinkedIn shows Applied, but the record was not updated; the next run settles it',
    ],
    [
      {
        outcome: 'already-applied',
        via: 'record',
        record: rec({ beforeAt: '2026-11-14T10:00:00.000Z' }),
      },
      'already applied (record, 2026-11-14); not opened',
    ],
    [
      { outcome: 'already-applied', via: 'linkedin' },
      'LinkedIn shows Applied; recorded',
    ],
    [
      {
        outcome: 'disqualified',
        via: 'record',
        record: rec({ beforeAt: '2026-11-13T09:00:00.000Z' }),
      },
      'disqualified earlier (record, 2026-11-13); not retried',
    ],
    [
      { outcome: 'submit-unconfirmed', record: rec({ before: 'submitting' }) },
      'previous submit unconfirmed; marked failed; run again to apply',
    ],
    [
      { outcome: 'submit-unconfirmed', record: rec({ before: null }) },
      'Submit clicked but LinkedIn does not show Applied; marked failed. Check the job on LinkedIn before running again',
    ],
  ] as [Partial<ApplyRun>, string][])('closingLine %#', (over, line) => {
    expect(closingLine(base(over))).toBe(line);
  });

  it.each(['stopped', 'safety-stop'] as const)(
    '%s after the Submit click says it may have gone through',
    (outcome) => {
      const line = closingLine(
        base({
          outcome,
          record: rec({ after: 'submitting' }),
          timings: {
            totalMs: 1,
            perStepMs: [],
            submit: { clickToSentMs: null, sentToMarkerMs: null },
          },
        }),
      );
      expect(line).toContain('Submit may have gone through');
      expect(line).toContain('next run settles it');
      expect(line).not.toMatch(/nothing (was )?submitted/);
    },
  );

  it('other outcomes use fixed words only', () => {
    const run = makeRun(makeBank());
    for (const outcome of [
      'reached-review',
      'not-easy-apply',
      'needs-author',
      'stopped',
      'safety-stop',
      'bridge-unavailable',
      'disqualified',
    ] as const) {
      const line = closingLine({ ...run, outcome, via: null });
      for (const m of markers) expect(line, m).not.toContain(m);
    }
  });

  it('the redacted report carries via, record and submit timings and no label', () => {
    const bank = makeBank();
    const run = makeRun(bank);
    const r = redactApplyRun(
      {
        ...run,
        via: 'record',
        record: rec({ before: 'submitting', after: 'failed' }),
        timings: {
          totalMs: 1,
          perStepMs: [],
          submit: { clickToSentMs: 5, sentToMarkerMs: 7 },
        },
      },
      bank,
    );
    expect(r.via).toBe('record');
    expect(r.record).toEqual({
      before: 'submitting',
      beforeAt: null,
      after: 'failed',
    });
    expect(r.timings.submit).toEqual({ clickToSentMs: 5, sentToMarkerMs: 7 });
    for (const m of markers) expect(JSON.stringify(r)).not.toContain(m);
  });

  it('verdict: submitted is pass', () => {
    const bank = makeBank();
    const md = formatRunMarkdown(
      { ...makeRun(bank), outcome: 'submitted', stop: undefined },
      bank,
    );
    expect(md).toContain('Verdict: pass');
  });
});
