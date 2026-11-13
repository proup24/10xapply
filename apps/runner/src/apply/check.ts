import type { Job } from '@xapply/answerer';
import {
  CheckFailedError,
  decide,
  OFFER_KINDS,
  type CheckJob,
  type CheckQuestion,
  type Claim,
  type ExtractResult,
} from '@xapply/disqualify';
import type { ReadField, UnknownField } from '../linkedin/types.js';
import { RunEnd, checkStop } from './stop.js';
import type { ApplyDeps, ApplyRun, CheckRecord } from './types.js';

type Checked = { deps: ApplyDeps; run: ApplyRun };

/**
 * What a check sees of the job: never its location or source. The walker
 * already put '' for anything the job page did not show.
 */
export const checkJobOf = (job: Job): CheckJob => ({
  title: job.title,
  company: job.company,
  description: job.description,
});

/** A fresh field as the round's check sees it, under its walker id. */
export function fieldQuestion(
  f: ReadField,
  id: string,
  stepTitle: string | null,
): CheckQuestion {
  const q: CheckQuestion = {
    id,
    label: f.question.label,
    type: f.question.type,
  };
  if (f.question.options) q.options = [...f.question.options];
  if (f.question.helpText !== undefined) q.helpText = f.question.helpText;
  if (stepTitle !== null) q.stepTitle = stepTitle;
  return q;
}

/** A labelled unknown field, sent by its label and its input type or role. */
export function unknownQuestion(
  u: UnknownField & { label: string },
  id: string,
  stepTitle: string | null,
): CheckQuestion {
  const q: CheckQuestion = {
    id,
    label: u.label,
    type: u.inputType ?? u.role ?? u.tag,
  };
  if (stepTitle !== null) q.stepTitle = stepTitle;
  return q;
}

/**
 * Awaits a check and records it, its calls even when it failed. A stop
 * that came while it was in flight wins over its result or its failure.
 */
export async function awaitCheck(
  w: Checked,
  at: CheckRecord['at'],
  step: number | null,
  pending: Promise<ExtractResult>,
): Promise<Claim[]> {
  let res: ExtractResult;
  try {
    res = await pending;
  } catch (e) {
    if (e instanceof CheckFailedError) {
      w.run.checks.push({
        at,
        step,
        ok: false,
        claims: [],
        calls: [...e.calls],
      });
    }
    checkStop(w.deps);
    throw e;
  }
  w.run.checks.push({
    at,
    step,
    ok: true,
    claims: res.claims,
    calls: res.calls,
  });
  checkStop(w.deps);
  return res.claims;
}

/** The job page's sponsorship and relocation offers, the only offers that count. */
export const offersOf = (claims: Claim[]): Claim[] =>
  claims.filter((c) => (OFFER_KINDS as readonly string[]).includes(c.kind));

/** Ends the run as `disqualified` when the rules say so. */
export function judge(w: Checked, claims: Claim[], offers: Claim[]): void {
  const verdict = decide(claims, w.deps.rules, offers);
  if (verdict.kind === 'disqualified') {
    w.run.disqualification = verdict.reasons;
    throw new RunEnd('disqualified');
  }
}
