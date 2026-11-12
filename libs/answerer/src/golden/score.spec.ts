import { describe, expect, it } from 'vitest';
import { bank, job } from '../testing/bank.js';
import type { AnswerResult, CallStat, Source } from '../types.js';
import type { Expect, GoldenCase } from './format.js';
import type { JudgeRun } from './judge.js';
import { scoreCase } from './score.js';

const ctx = { bank, job };
const KUBE = bank.facts[5]?.text as string;
const NOTICE = bank.facts[3]?.text as string;

const stat: CallStat = {
  role: 'judge',
  model: 'judge-model',
  latencyMs: 1,
  costUsd: null,
  ok: true,
};

const kase = (expect: Expect, over: Partial<GoldenCase> = {}): GoldenCase => ({
  id: 'case-1',
  question: {
    id: 'case-1',
    label: 'The secret question label',
    type: 'textarea',
    required: true,
  },
  expect,
  ...over,
});

const backed = (
  value: string | string[],
  sources: Source[],
  derivation: Extract<
    AnswerResult,
    { status: 'backed' }
  >['derivation'] = 'composed',
): AnswerResult => ({
  questionId: 'case-1',
  required: true,
  calls: [],
  status: 'backed',
  value,
  sources,
  derivation,
  inferences: [],
  verification: { verdict: 'confirmed', rounds: 1 },
});

const blocked = (
  reason: Extract<AnswerResult, { status: 'blocked' }>['reason'],
): AnswerResult => ({
  questionId: 'case-1',
  required: true,
  calls: [],
  status: 'blocked',
  reason,
  detail: 'generator: bank-silent',
});

const judged = (unsupported: string[], hits: string[] = []): JudgeRun => ({
  status: 'judged',
  unsupported,
  mustNotClaimHits: hits,
  stat,
});

describe('scoreCase', () => {
  it('passes a backed result that matches value, sources and derivation', () => {
    const s = scoreCase(
      kase({
        status: 'backed',
        value: 'Less than 2 weeks',
        sources: [{ fact: 3 }],
        derivation: 'bucket',
      }),
      backed(
        ' Less than 2 weeks ',
        [{ kind: 'fact', text: ` ${NOTICE}` }],
        'bucket',
      ),
      ctx,
    );
    expect(s).toEqual({
      id: 'case-1',
      pass: true,
      hardFail: false,
      needlessBlock: false,
      problems: [],
    });
  });

  it('passes a blocked result with the expected reason, or any reason when none is expected', () => {
    expect(
      scoreCase(
        kase({ status: 'blocked', reason: 'bank-silent' }),
        blocked('bank-silent'),
        ctx,
      ).pass,
    ).toBe(true);
    expect(
      scoreCase(kase({ status: 'blocked' }), blocked('check-failed'), ctx).pass,
    ).toBe(true);
  });

  describe('hard failures', () => {
    it('backed when blocked was expected', () => {
      const s = scoreCase(
        kase({ status: 'blocked', reason: 'bank-silent' }),
        backed('No', [{ kind: 'fact', text: KUBE }]),
        ctx,
      );
      expect(s).toMatchObject({ pass: false, hardFail: true });
      expect(s.problems).toEqual(['expected blocked, got backed']);
    });

    it('a value mismatch', () => {
      const s = scoreCase(
        kase({ status: 'backed', value: '5', sources: [{ fact: 5 }] }),
        backed('6', [{ kind: 'fact', text: KUBE }], 'math'),
        ctx,
      );
      expect(s).toMatchObject({ pass: false, hardFail: true });
      expect(s.problems).toEqual(['value mismatch']);
    });

    it('a multi-select compared as a set', () => {
      const expectSet: Expect = {
        status: 'backed',
        value: ['Kubernetes', 'TypeScript'],
        sources: [{ fact: 5 }],
      };
      const src: Source[] = [{ kind: 'fact', text: KUBE }];
      expect(
        scoreCase(
          kase(expectSet),
          backed(['TypeScript', 'Kubernetes'], src, 'bucket'),
          ctx,
        ).pass,
      ).toBe(true);
      expect(
        scoreCase(kase(expectSet), backed(['Kubernetes'], src, 'bucket'), ctx)
          .problems,
      ).toEqual(['value mismatch']);
      expect(
        scoreCase(kase(expectSet), backed('Kubernetes', src, 'bucket'), ctx)
          .problems,
      ).toEqual(['value mismatch']);
    });

    it('a valueFrom field mismatch', () => {
      const s = scoreCase(
        kase({
          status: 'backed',
          valueFrom: { field: 'city' },
          sources: [{ field: 'city' }],
        }),
        backed('York', [{ kind: 'field', key: 'city' }], 'field'),
        ctx,
      );
      expect(s).toMatchObject({ hardFail: true, problems: ['value mismatch'] });
      expect(
        scoreCase(
          kase({
            status: 'backed',
            valueFrom: { field: 'city' },
            sources: [{ field: 'city' }],
          }),
          backed(bank.fields.city, [{ kind: 'field', key: 'city' }], 'field'),
          ctx,
        ).pass,
      ).toBe(true);
    });

    it('a valueFrom answer that cannot resolve (unknown, or has variants)', () => {
      for (const id of ['no-such-answer', 'contractor-rate']) {
        const s = scoreCase(
          kase({ status: 'backed', valueFrom: { answer: id } }),
          backed('30 USD per hour', [{ kind: 'answer', id, variant: 0 }]),
          ctx,
        );
        expect(s).toMatchObject({ hardFail: true });
        expect(s.problems).toEqual([`valueFrom answer:${id} not resolvable`]);
      }
    });

    it('each missing source kind', () => {
      const s = scoreCase(
        kase({
          status: 'backed',
          sources: [
            { fact: 5 },
            { answer: 'contractor-rate' },
            { story: 'missed-launch-date' },
            { field: 'email' },
            { jobPost: true },
          ],
        }),
        backed('Text', [{ kind: 'fact', text: NOTICE }]),
        ctx,
      );
      expect(s).toMatchObject({ pass: false, hardFail: true });
      expect(s.problems).toEqual([
        'missing source fact:5',
        'missing source answer:contractor-rate',
        'missing source story:missed-launch-date',
        'missing source field:email',
        'missing source job-post',
      ]);
    });

    it('matches each source kind, an answer with any variant', () => {
      const s = scoreCase(
        kase({
          status: 'backed',
          sources: [
            { fact: 5 },
            { answer: 'contractor-rate' },
            { story: 'missed-launch-date' },
            { field: 'email' },
            { jobPost: true },
          ],
        }),
        backed('Text', [
          { kind: 'story', id: 'missed-launch-date' },
          { kind: 'job-post', quote: 'code review' },
          { kind: 'answer', id: 'contractor-rate', variant: 2 },
          { kind: 'field', key: 'email' },
          { kind: 'fact', text: KUBE },
          { kind: 'run-date' },
        ]),
        ctx,
      );
      expect(s.problems).toEqual([]);
    });

    it('a fact index past the end of the bank never matches', () => {
      const s = scoreCase(
        kase({ status: 'backed', sources: [{ fact: 999 }] }),
        backed('Text', [{ kind: 'fact', text: KUBE }]),
        ctx,
      );
      expect(s.problems).toEqual(['missing source fact:999']);
    });

    it('a derivation mismatch', () => {
      const s = scoreCase(
        kase({ status: 'backed', value: '5', derivation: 'math' }),
        backed('5', [{ kind: 'fact', text: KUBE }], 'fitted'),
        ctx,
      );
      expect(s).toMatchObject({ pass: false, hardFail: true });
      expect(s.problems).toEqual(['expected derivation math, got fitted']);
    });

    it('the judge finding unsupported claims or mustNotClaim hits, by count only', () => {
      const s = scoreCase(
        kase({ status: 'backed', mustNotClaim: ['a percentage'] }),
        backed('Text', [{ kind: 'fact', text: KUBE }]),
        ctx,
        judged(['claim one', 'claim two'], ['cut review time by 30%']),
      );
      expect(s).toMatchObject({ pass: false, hardFail: true });
      expect(s.problems).toEqual([
        'judge: 2 unsupported',
        'judge: 1 mustNotClaim',
      ]);
    });
  });

  it('a judge with nothing found passes; a judge model error fails the case but is not a hard failure', () => {
    const c = kase({ status: 'backed', mustNotClaim: ['x'] });
    const r = backed('Text', [{ kind: 'fact', text: KUBE }]);
    expect(scoreCase(c, r, ctx, judged([])).pass).toBe(true);
    expect(scoreCase(c, r, ctx, { status: 'not-run' }).pass).toBe(true);
    expect(scoreCase(c, r, ctx, { status: 'model-error' })).toEqual({
      id: 'case-1',
      pass: false,
      hardFail: false,
      needlessBlock: false,
      problems: ['judge: model error'],
    });
  });

  it('needlessBlock when backed was expected and blocked came back', () => {
    const s = scoreCase(
      kase({ status: 'backed', value: '5', sources: [{ fact: 5 }] }),
      blocked('bank-silent'),
      ctx,
    );
    expect(s).toEqual({
      id: 'case-1',
      pass: false,
      hardFail: false,
      needlessBlock: true,
      problems: ['expected backed, got blocked (bank-silent)'],
    });
  });

  it('a different block reason fails the case, neither hard nor needless', () => {
    const s = scoreCase(
      kase({ status: 'blocked', reason: 'boundary' }),
      blocked('verifier-rejected'),
      ctx,
    );
    expect(s).toEqual({
      id: 'case-1',
      pass: false,
      hardFail: false,
      needlessBlock: false,
      problems: ['expected reason boundary, got verifier-rejected'],
    });
  });

  it('valueFrom an answer fills its placeholders and trims', () => {
    const c = kase({
      status: 'backed',
      valueFrom: { answer: 'why-this-role' },
      sources: [{ answer: 'why-this-role' }],
      derivation: 'as-written',
    });
    const filled =
      'I want to work on the Backend Engineer role at Acme Payments, found through LinkedIn.';
    const src: Source[] = [{ kind: 'answer', id: 'why-this-role' }];
    expect(
      scoreCase(c, backed(`  ${filled}\n`, src, 'as-written'), ctx).pass,
    ).toBe(true);
    expect(
      scoreCase(
        c,
        backed(
          'I want to work on the {jobTitle} role at {company}, found through {source}.',
          src,
          'as-written',
        ),
        ctx,
      ).problems,
    ).toEqual(['value mismatch']);
  });

  it('problems never contain a value, a fact, a label or a judge finding', () => {
    const secrets = [
      'secret-expected-value',
      'secret-actual-value',
      'The secret question label',
      'secret judge claim',
      'secret mustNotClaim',
      KUBE,
      NOTICE,
      bank.fields.email,
    ];
    const results = [
      scoreCase(
        kase({
          status: 'backed',
          value: 'secret-expected-value',
          sources: [{ fact: 3 }, { field: 'email' }],
          mustNotClaim: ['secret mustNotClaim'],
        }),
        backed('secret-actual-value', [{ kind: 'fact', text: KUBE }]),
        ctx,
        judged(['secret judge claim'], ['secret mustNotClaim']),
      ),
      scoreCase(
        kase({ status: 'backed', valueFrom: { field: 'email' } }),
        backed('secret-actual-value', [{ kind: 'fact', text: KUBE }]),
        ctx,
      ),
      scoreCase(
        kase({ status: 'blocked' }),
        backed('secret-actual-value', [{ kind: 'fact', text: KUBE }]),
        ctx,
      ),
    ];
    const text = results.flatMap((r) => r.problems).join('\n');
    expect(text).not.toBe('');
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
