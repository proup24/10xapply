import type { z } from 'zod';
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
  | { verdict: 'rejected'; check: VerifierCheck; feedback: string[] };

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

/**
 * The independent verifier: fresh calls with their own system prompt. Runs
 * blind (choice and number types), then fit (as-written and fitted), then
 * claims (composed), stopping at the first rejection. Each returned call's
 * stat is pushed onto `calls`.
 *
 * Feedback lines go only into the next generator prompt. They never hold the
 * verifier's own value, which is never used.
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

  const isChoice = (CHOICE_TYPES as readonly string[]).includes(q.type);
  if (isChoice || q.type === 'number') {
    const blind = toCandidate(await call(blindPrompt(q, ctx), generatorOutput));
    const same =
      blind.outcome === 'answer' && sameBlindValue(q, blind.value, value);
    if (!same) {
      return {
        verdict: 'rejected',
        check: 'blind',
        feedback: [
          q.type === 'number'
            ? 'the verifier picked a different number'
            : 'the verifier picked a different option',
        ],
      };
    }
  }

  if (c.derivation === 'as-written' || c.derivation === 'fitted') {
    const fit = await call(fitPrompt(q, ctx, checked), fitOutput);
    if (!fit.fits) {
      return {
        verdict: 'rejected',
        check: 'fit',
        feedback: ['the cited entry does not answer this question', fit.why],
      };
    }
  }

  if (c.derivation === 'composed') {
    const claims = await call(claimsPrompt(q, ctx, checked), claimsOutput);
    const feedback = claims.claims
      .filter(
        (x) => x.mark === 'unsupported' || x.mark === 'company-not-in-post',
      )
      .map((x) => `${x.claim} (${x.mark})`);
    if (claims.storyDetailAdded) feedback.push('a story detail was added');
    if (feedback.length > 0) {
      return { verdict: 'rejected', check: 'claims', feedback };
    }
  }

  return { verdict: 'confirmed' };
}
