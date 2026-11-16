import type { z } from 'zod';
import { addOffset, MathError } from './math.js';
import {
  claimsOutput,
  fitOutput,
  generatorOutput,
  toCandidate,
} from './prompts/schemas.js';
import {
  VERIFY_SYSTEM,
  blindPrompt,
  claimsPrompt,
  fitPrompt,
} from './prompts/verifier.js';
import { matchOption } from './sources.js';
import {
  CHOICE_TYPES,
  TEXT_TYPES,
  type AnswerContext,
  type AnswerValue,
  type CallStat,
  type Candidate,
  type FormQuestion,
} from './types.js';

type AnswerCandidate = Extract<Candidate, { outcome: 'answer' }>;

export type VerifierCheck = 'blind' | 'fit' | 'claims';

export type Verdict =
  | { verdict: 'confirmed' }
  | {
      verdict: 'rejected';
      check: VerifierCheck | 'none';
      feedback: string[];
    };

/**
 * The verifier checks for a question and derivation, in the order they run.
 * Blind runs for choice and number types, and for math and bucket on any type.
 */
export function checksFor(
  q: FormQuestion,
  derivation: AnswerCandidate['derivation'],
): VerifierCheck[] {
  const checks: VerifierCheck[] = [];
  const isChoice = (CHOICE_TYPES as readonly string[]).includes(q.type);
  if (
    isChoice ||
    q.type === 'number' ||
    derivation === 'math' ||
    derivation === 'bucket'
  ) {
    checks.push('blind');
  }
  if (derivation === 'as-written' || derivation === 'fitted')
    checks.push('fit');
  if (derivation === 'composed') checks.push('claims');
  return checks;
}

const NUMBER_ONLY = /^\d+(?:\.\d+)?$/;

/**
 * True when the verifier's own value, answered blind, is the same answer as
 * the checked value. Anything that is not plainly the same is a mismatch.
 */
function sameBlindValue(
  q: FormQuestion,
  verifierValue: AnswerValue,
  checked: AnswerValue,
): boolean {
  if (q.type === 'number') {
    if (typeof verifierValue !== 'string' || typeof checked !== 'string')
      return false;
    const v = verifierValue.trim();
    return NUMBER_ONLY.test(v) && Number(v) === Number(checked);
  }
  if (q.type === 'date') {
    return (
      typeof verifierValue === 'string' &&
      typeof checked === 'string' &&
      verifierValue.trim() === checked.trim()
    );
  }
  if ((TEXT_TYPES as readonly string[]).includes(q.type)) {
    if (typeof verifierValue !== 'string' || typeof checked !== 'string')
      return false;
    const v = verifierValue.trim();
    const w = checked.trim();
    if (NUMBER_ONLY.test(v) && NUMBER_ONLY.test(w))
      return Number(v) === Number(w);
    return v.toLowerCase() === w.toLowerCase();
  }
  const options = q.options ?? [];
  if (q.type === 'checkbox-group') {
    if (!Array.isArray(verifierValue) || !Array.isArray(checked)) return false;
    const picked = new Set<string>();
    for (const item of verifierValue) {
      const option = matchOption(item, options);
      if (option === null) return false;
      picked.add(option);
    }
    const wanted = new Set(checked);
    return (
      picked.size === wanted.size && [...picked].every((o) => wanted.has(o))
    );
  }
  if (typeof verifierValue !== 'string') return false;
  const option = matchOption(verifierValue, options);
  return option !== null && option === checked;
}

// Fixed feedback lines. Blind and fit feedback never says what the verifier
// picked or why, so the generator cannot steer toward the verifier's value.
const BLIND_REJECTED = 'the verifier did not confirm this answer from the bank';
const FIT_REJECTED = 'the cited entry does not answer this question as asked';
const NO_CLAIMS = 'the verifier found no checkable claims';
const DECLARE_INFERENCES =
  'declare each as an inference with its source, or drop it';

/**
 * The blind answer's value. On a date question with date-offset math, code
 * computes the date, as it does for the candidate: the verifier's own date
 * arithmetic is never trusted. Null when the math does not compute.
 */
function blindValue(
  q: FormQuestion,
  blind: AnswerCandidate,
  runDate: string,
): AnswerValue | null {
  if (q.type !== 'date' || blind.math?.kind !== 'date-offset') {
    return blind.value;
  }
  try {
    return addOffset(runDate, blind.math.amount, blind.math.unit);
  } catch (e) {
    if (e instanceof MathError) return null;
    throw e;
  }
}

const isEmptyValue = (v: AnswerValue): boolean =>
  Array.isArray(v) ? v.length === 0 : v.trim() === '';

/**
 * The independent verifier: fresh calls with their own system prompt. Runs
 * the checks `checksFor` names, stopping at the first rejection. A round with
 * no check is rejected, never confirmed. Each returned call's
 * stat is pushed onto `calls`.
 *
 * Feedback lines go only into the next generator prompt, never into a
 * result's detail. Blind and fit lines are fixed text: they never hold the
 * verifier's own value or reasons. Claims lines name the rejected claims.
 */
export async function verifyCandidate(
  q: FormQuestion,
  ctx: AnswerContext,
  c: AnswerCandidate,
  value: AnswerValue,
  calls: CallStat[],
): Promise<Verdict> {
  const call = async <T>(prompt: string, schema: z.ZodType<T>): Promise<T> => {
    const res = await ctx.caller.call<T>({
      role: 'verify',
      model: ctx.models.verifyModel,
      system: VERIFY_SYSTEM,
      prompt,
      schema,
    });
    calls.push(res.stat);
    return res.value;
  };
  const checked: AnswerCandidate = { ...c, value };

  const checks = checksFor(q, c.derivation);
  // Never confirm without an independent check.
  if (checks.length === 0) {
    return { verdict: 'rejected', check: 'none', feedback: [] };
  }

  if (checks.includes('blind')) {
    const blind = toCandidate(await call(blindPrompt(q, ctx), generatorOutput));
    const blindAnswer =
      blind.outcome === 'answer' ? blindValue(q, blind, ctx.runDate) : null;
    if (blindAnswer === null || !sameBlindValue(q, blindAnswer, value)) {
      return {
        verdict: 'rejected',
        check: 'blind',
        feedback: [BLIND_REJECTED],
      };
    }
  }

  if (checks.includes('fit')) {
    const fit = await call(fitPrompt(q, ctx, checked), fitOutput);
    if (!fit.fits) {
      return {
        verdict: 'rejected',
        check: 'fit',
        feedback: [FIT_REJECTED],
      };
    }
  }

  if (checks.includes('claims')) {
    const claims = await call(claimsPrompt(q, ctx, checked), claimsOutput);
    const feedback = claims.claims
      .filter(
        (x) => x.mark === 'unsupported' || x.mark === 'company-not-in-post',
      )
      .map((x) => `${x.claim} (${x.mark})`);
    if (claims.storyDetailAdded) feedback.push('a story detail was added');
    // A non-empty answer always makes at least one claim.
    if (claims.claims.length === 0 && !isEmptyValue(value)) {
      feedback.push(NO_CLAIMS);
    }
    // Every inference the verifier finds must have been declared.
    const inferred = claims.claims.filter((x) => x.mark === 'inferred');
    if (inferred.length > c.inferences.length) {
      feedback.push(
        ...inferred.map((x) => `${x.claim} (an undeclared inference)`),
        DECLARE_INFERENCES,
      );
    }
    if (feedback.length > 0) {
      return { verdict: 'rejected', check: 'claims', feedback };
    }
  }

  return { verdict: 'confirmed' };
}
