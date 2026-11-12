import { describe, expect, it } from 'vitest';
import {
  ModelCallError,
  ModelUnavailableError,
  type ModelCaller,
  type ModelRequest,
} from '../model/caller.js';
import { renderBank } from '../prompts/bank-text.js';
import { fakeCaller } from '../testing/fake-caller.js';
import { bank, job } from '../testing/bank.js';
import type { GoldenCase, GoldenFile } from './format.js';
import { JUDGE_SYSTEM } from './judge.js';
import { runGolden } from './run.js';

type Step = (req: ModelRequest<unknown>) => unknown;

const KUBE = bank.facts[5]?.text as string;

const src = (over: Record<string, unknown>) => ({
  kind: 'fact',
  key: null,
  text: null,
  id: null,
  variant: null,
  quote: null,
  ...over,
});
const out = (over: Record<string, unknown>) => ({
  outcome: 'answer',
  reason: null,
  value: null,
  sources: [],
  derivation: null,
  inferences: [],
  math: null,
  ...over,
});

const kubeMath = out({
  value: '5',
  derivation: 'math',
  sources: [src({ text: KUBE }), src({ kind: 'run-date' })],
  math: { kind: 'years-since', year: 2021, month: 3, expression: null },
});
const silent = out({ outcome: 'cannot-answer', reason: 'bank-silent' });
const kubeText = out({
  value: 'I run Kubernetes in production.',
  derivation: 'composed',
  sources: [src({ text: KUBE })],
});
const claimsOk = {
  claims: [
    {
      claim: 'runs Kubernetes in production',
      mark: 'backed',
      source: 'fact 5',
    },
  ],
  storyDetailAdded: false,
};
const judgeClean = { unsupported: [], mustNotClaimHits: [] };

const yearsCase: GoldenCase = {
  id: 'kube-years',
  question: {
    id: 'kube-years',
    label: 'How many years of Kubernetes experience do you have?',
    type: 'number',
    required: true,
  },
  expect: {
    status: 'backed',
    value: '5',
    sources: [{ fact: 5 }],
    derivation: 'math',
  },
};
const fieldCase: GoldenCase = {
  id: 'email',
  question: { id: 'email', label: 'Email', type: 'text', required: true },
  expect: {
    status: 'backed',
    valueFrom: { field: 'email' },
    sources: [{ field: 'email' }],
  },
};
const textCase: GoldenCase = {
  id: 'kube-text',
  question: {
    id: 'kube-text',
    label: 'Describe your Kubernetes experience.',
    type: 'textarea',
    required: true,
  },
  expect: {
    status: 'backed',
    sources: [{ fact: 5 }],
    mustNotClaim: ['a Kubernetes certification'],
  },
};
const terraformCase: GoldenCase = {
  id: 'terraform',
  question: {
    id: 'terraform',
    label: 'Terraform?',
    type: 'radio',
    options: ['Yes', 'No'],
    required: true,
  },
  expect: { status: 'blocked', reason: 'bank-silent' },
};

const file = (cases: GoldenCase[]): GoldenFile => ({
  runDate: '2026-11-12',
  jobs: { default: job },
  cases,
});

const models = {
  answerModel: 'gen-model',
  verifyModel: 'ver-model',
  judgeModel: 'judge-model',
  maxRegenerations: 0,
};

/** A fake caller whose calls each report the given cost. */
function costing(
  script: Step[],
  cost: number | null,
): ModelCaller & {
  requests: ModelRequest<unknown>[];
} {
  const inner = fakeCaller(script);
  return {
    requests: inner.requests,
    async call(req) {
      const res = await inner.call(req);
      return { ...res, stat: { ...res.stat, costUsd: cost } };
    },
  };
}

describe('runGolden', () => {
  it('fails a case when one of its runs fails, and does the barsHeld math', async () => {
    const caller = fakeCaller([
      () => kubeMath, // run 1: generator
      () => kubeMath, // run 1: blind verifier
      () => silent, // run 2: generator blocks
      () => judgeClean, // email run 1: a backed text answer is judged
      () => judgeClean, // email run 2
    ]);
    const seen: string[] = [];
    const report = await runGolden({
      file: file([yearsCase, fieldCase]),
      bank,
      caller,
      models,
      repeat: 2,
      onCase: (s, r) => seen.push(`${s.id}:${r.status}`),
    });

    const years = report.cases[0];
    expect(years?.id).toBe('kube-years');
    expect(years?.runs.map((r) => r.pass)).toEqual([true, false]);
    expect(years?.runs[1]).toMatchObject({ needlessBlock: true });
    expect(years?.pass).toBe(false);
    expect(years?.results.map((r) => r.status)).toEqual(['backed', 'blocked']);
    expect(years?.judges).toEqual([
      { status: 'not-run' },
      { status: 'not-run' },
    ]);
    expect(report.cases[1]).toMatchObject({ id: 'email', pass: true });
    expect(seen).toEqual([
      'kube-years:backed',
      'kube-years:blocked',
      'email:backed',
      'email:backed',
    ]);

    // 1 needless block out of 4 runs expected backed.
    expect(report.totals).toEqual({
      cases: 2,
      passed: 1,
      hardFails: 0,
      needlessBlockRate: 0.25,
      costUsd: 0,
    });
    expect(report.barsHeld).toBe(false);
  });

  it('holds the bars at 10% needless blocks with no hard failure, and a blocked case does not count', async () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? [() => silent] : [() => kubeMath, () => kubeMath],
    ).flat();
    const report = await runGolden({
      file: file([yearsCase, terraformCase]),
      bank,
      caller: fakeCaller([...blocks, ...Array(10).fill(() => silent)]),
      models,
      repeat: 10,
    });
    expect(report.totals.needlessBlockRate).toBe(0.1);
    expect(report.totals.hardFails).toBe(0);
    expect(report.cases[1]?.pass).toBe(true);
    expect(report.barsHeld).toBe(true);
  });

  it('a hard failure breaks the bars; needlessBlockRate is 0 with no backed expectations', async () => {
    const caller = fakeCaller([
      () =>
        out({
          value: 'No',
          derivation: 'bucket',
          sources: [src({ text: KUBE })],
        }),
      () =>
        out({
          value: 'No',
          derivation: 'bucket',
          sources: [src({ text: KUBE })],
        }),
    ]);
    const report = await runGolden({
      file: file([terraformCase]),
      bank,
      caller,
      models,
      repeat: 1,
    });
    expect(report.cases[0]?.runs[0]).toMatchObject({
      hardFail: true,
      problems: ['expected blocked, got backed'],
    });
    expect(report.totals).toMatchObject({
      hardFails: 1,
      needlessBlockRate: 0,
    });
    expect(report.barsHeld).toBe(false);
  });

  it('judges a backed text answer with a static system prompt and the context on stdin', async () => {
    const caller = costing(
      [
        () => kubeText,
        () => claimsOk,
        () => ({ unsupported: ['is certified'], mustNotClaimHits: [] }),
      ],
      0.25,
    );
    const report = await runGolden({
      file: file([textCase]),
      bank,
      caller,
      models,
      repeat: 1,
    });
    const judgeReq = caller.requests[2];
    expect(judgeReq).toMatchObject({
      role: 'judge',
      model: 'judge-model',
      system: JUDGE_SYSTEM,
    });
    expect(JUDGE_SYSTEM).not.toContain(KUBE);
    expect(JUDGE_SYSTEM).not.toContain(job.company);
    expect(judgeReq?.prompt).toContain(renderBank(bank));
    expect(judgeReq?.prompt).toContain(job.description.trim());
    expect(judgeReq?.prompt).toContain('Describe your Kubernetes experience.');
    expect(judgeReq?.prompt).toContain('I run Kubernetes in production.');
    expect(judgeReq?.prompt).toContain('a Kubernetes certification');

    const c = report.cases[0];
    expect(c?.judges[0]).toMatchObject({
      status: 'judged',
      unsupported: ['is certified'],
      mustNotClaimHits: [],
    });
    expect(c?.runs[0]).toMatchObject({
      hardFail: true,
      problems: ['judge: 1 unsupported'],
    });
    // Every call's cost, the judge's included.
    expect(report.totals.costUsd).toBeCloseTo(0.75);
    expect(report.barsHeld).toBe(false);
  });

  it('never judges a blocked result or a non-text type', async () => {
    const caller = fakeCaller([() => kubeMath, () => kubeMath, () => silent]);
    const report = await runGolden({
      file: file([yearsCase, textCase]),
      bank,
      caller,
      models,
      repeat: 1,
    });
    expect(caller.requests.map((r) => r.role)).toEqual([
      'answer',
      'verify',
      'answer',
    ]);
    expect(report.cases.map((c) => c.judges)).toEqual([
      [{ status: 'not-run' }],
      [{ status: 'not-run' }],
    ]);
  });

  it('a judge model error fails the case without a hard failure', async () => {
    const report = await runGolden({
      file: file([textCase]),
      bank,
      caller: fakeCaller([
        () => kubeText,
        () => claimsOk,
        () => {
          throw new ModelCallError('model call failed');
        },
      ]),
      models,
      repeat: 1,
    });
    expect(report.cases[0]?.judges).toEqual([{ status: 'model-error' }]);
    expect(report.cases[0]?.runs[0]).toMatchObject({
      pass: false,
      hardFail: false,
      problems: ['judge: model error'],
    });
    expect(report.totals.hardFails).toBe(0);
  });

  it('passes a clean judged answer', async () => {
    const report = await runGolden({
      file: file([textCase]),
      bank,
      caller: fakeCaller([() => kubeText, () => claimsOk, () => judgeClean]),
      models,
      repeat: 1,
    });
    expect(report.cases[0]?.pass).toBe(true);
    expect(report.barsHeld).toBe(true);
  });

  it('a ModelUnavailableError propagates, from the answerer or the judge', async () => {
    const unavailable = () => {
      throw new ModelUnavailableError('not signed in');
    };
    await expect(
      runGolden({
        file: file([yearsCase]),
        bank,
        caller: fakeCaller([unavailable]),
        models,
        repeat: 1,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(
      runGolden({
        file: file([textCase]),
        bank,
        caller: fakeCaller([() => kubeText, () => claimsOk, unavailable]),
        models,
        repeat: 1,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('runs only the named case, uses its job, and throws on an unknown case id', async () => {
    const other = { ...job, company: 'Other Co', title: 'Platform Engineer' };
    const placeholder: GoldenCase = {
      id: 'why',
      question: {
        id: 'why',
        label: 'Why this role?',
        type: 'text',
        required: true,
      },
      job: 'other',
      expect: { status: 'backed', valueFrom: { answer: 'why-this-role' } },
    };
    const filled =
      'I want to work on the Platform Engineer role at Other Co, found through LinkedIn.';
    const caller = fakeCaller([
      () =>
        out({
          value: filled,
          derivation: 'as-written',
          sources: [src({ kind: 'answer', id: 'why-this-role' })],
        }),
      () => ({ fits: true, why: 'same question' }),
      () => judgeClean,
    ]);
    const report = await runGolden({
      file: {
        ...file([yearsCase, placeholder]),
        jobs: { default: job, other },
      },
      bank,
      caller,
      models,
      repeat: 1,
      caseId: 'why',
    });
    expect(report.cases.map((c) => c.id)).toEqual(['why']);
    expect(report.cases[0]?.pass).toBe(true);
    expect(caller.requests[0]?.prompt).toContain('Company: Other Co');

    await expect(
      runGolden({
        file: file([yearsCase]),
        bank,
        caller: fakeCaller([]),
        models,
        repeat: 1,
        caseId: 'nope',
      }),
    ).rejects.toThrow('nope');
  });
});
