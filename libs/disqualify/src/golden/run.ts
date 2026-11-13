import type { CallStat } from '@xapply/answerer';
import { expandCountries } from '../countries.js';
import { decide } from '../decide.js';
import {
  CheckFailedError,
  extractFromJob,
  extractFromQuestions,
  type ExtractContext,
} from '../extract.js';
import {
  OFFER_KINDS,
  type Claim,
  type ClaimKind,
  type CheckQuestion,
} from '../types.js';
import {
  DisqualifyGoldenError,
  type DisqCase,
  type DisqualifyGolden,
  type ExpectedClaim,
} from './format.js';

export interface DisqRun {
  pass: boolean;
  /** 'pass', 'disqualified', or 'check-failed'. */
  verdict: string;
  claims: Claim[];
  calls: CallStat[];
  error?: string;
}

export interface DisqCaseReport {
  id: string;
  group: DisqCase['group'];
  runs: DisqRun[];
}

export interface DisqEvalReport {
  cases: DisqCaseReport[];
  /** Every run of every case passed. */
  passed: boolean;
  /** Sum of every call's cost; a call with no cost counts as 0. */
  cost: number;
}

export interface RunDisqualifyGoldenOptions {
  golden: DisqualifyGolden;
  ctx: ExtractContext;
  repeat: number;
  caseId?: string;
  /** Called after each run. */
  onRun?: (c: DisqCase, r: DisqRun) => void;
}

const sameCountries = (a: string[], b: string[]): boolean => {
  const x = expandCountries(a);
  const y = expandCountries(b);
  return x.size === y.size && [...x].every((c) => y.has(c));
};

const kindMatches = (expected: ExpectedClaim['kind'], kind: ClaimKind) =>
  Array.isArray(expected)
    ? expected.some((k) => k === kind)
    : expected === kind;

/**
 * Every expected claim needs a returned claim of the same kind (any one of
 * them, for a list) with the same expanded countries. One returned claim may
 * satisfy several expected claims.
 */
function claimsMatch(expected: ExpectedClaim[], returned: Claim[]): boolean {
  return expected.every((e) =>
    returned.some(
      (r) =>
        kindMatches(e.kind, r.kind) && sameCountries(e.countries, r.countries),
    ),
  );
}

async function runOnce(
  c: DisqCase,
  golden: DisqualifyGolden,
  ctx: ExtractContext,
): Promise<DisqRun> {
  const job = c.job ?? golden.defaultJob;
  const questions: CheckQuestion[] = (c.questions ?? []).map((q, i) => ({
    ...q,
    id: `s1-q${i + 1}`,
  }));
  const calls: CallStat[] = [];
  const claims: Claim[] = [];
  let offers: Claim[] = [];
  try {
    if (c.checkJob) {
      const r = await extractFromJob(job, ctx);
      calls.push(...r.calls);
      claims.push(...r.claims);
      offers = r.claims.filter((x) => OFFER_KINDS.some((k) => k === x.kind));
    }
    const q = await extractFromQuestions(questions, job, ctx);
    calls.push(...q.calls);
    claims.push(...q.claims);
  } catch (e) {
    if (e instanceof CheckFailedError) {
      calls.push(...e.calls);
      return {
        pass: false,
        verdict: 'check-failed',
        claims,
        calls,
        error: e.message,
      };
    }
    throw e;
  }
  const verdict = decide(claims, golden.rules, offers).kind;
  return {
    pass: verdict === c.expect.verdict && claimsMatch(c.expect.claims, claims),
    verdict,
    claims,
    calls,
  };
}

/** Runs the set: each case `repeat` times, one call at a time. */
export async function runDisqualifyGolden(
  opts: RunDisqualifyGoldenOptions,
): Promise<DisqEvalReport> {
  const { golden, ctx, repeat } = opts;
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new DisqualifyGoldenError(
      'repeat must be a whole number of at least 1',
    );
  const cases =
    opts.caseId === undefined
      ? golden.cases
      : golden.cases.filter((c) => c.id === opts.caseId);
  if (opts.caseId !== undefined && cases.length === 0)
    throw new DisqualifyGoldenError(`no case with id ${opts.caseId}`);

  const reports: DisqCaseReport[] = [];
  let cost = 0;
  for (const c of cases) {
    const runs: DisqRun[] = [];
    for (let i = 0; i < repeat; i++) {
      const run = await runOnce(c, golden, ctx);
      for (const s of run.calls) cost += s.costUsd ?? 0;
      runs.push(run);
      opts.onRun?.(c, run);
    }
    reports.push({ id: c.id, group: c.group, runs });
  }
  return {
    cases: reports,
    passed: reports.every((r) => r.runs.every((x) => x.pass)),
    cost,
  };
}
