import { mapField } from './fields.js';
import { ModelCallError } from './model/caller.js';
import { GENERATOR_SYSTEM, generatorPrompt } from './prompts/generator.js';
import { generatorOutput, toCandidate } from './prompts/schemas.js';
import { checkCandidate } from './checks.js';
import {
  FIELD_TYPES,
  type AnswerContext,
  type AnswerResult,
  type BlockReason,
  type CallStat,
  type FormQuestion,
} from './types.js';
import { verifyCandidate } from './verify.js';

/** Regenerations allowed after a rejection. Anything but a whole number ≥ 0 counts as 0. */
function regenerations(n: number): number {
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Answers one form question from the bank, or blocks it. Field labels are
 * filled by code. Anything else is generated, checked by code and confirmed by
 * an independent verifier, with up to `maxRegenerations` regenerations after a
 * rejection. A failed model call blocks as `model-error`; a
 * `ModelUnavailableError` (sign-in or usage limit) is rethrown.
 *
 * `detail` strings are fixed text and never hold a value, a claim, the
 * verifier's reasons or the question label.
 */
export async function answerQuestion(
  q: FormQuestion,
  ctx: AnswerContext,
): Promise<AnswerResult> {
  const calls: CallStat[] = [];
  const base = { questionId: q.id, required: q.required, calls };
  const blocked = (reason: BlockReason, detail: string): AnswerResult => ({
    ...base,
    status: 'blocked',
    reason,
    detail,
  });

  if (!(FIELD_TYPES as readonly string[]).includes(q.type)) {
    return blocked('unsupported-field', 'unsupported field type');
  }

  const mapped = mapField(q, ctx.bank);
  switch (mapped.kind) {
    case 'filled':
      return {
        ...base,
        status: 'backed',
        value: mapped.value,
        sources: [{ kind: 'field', key: mapped.key }],
        derivation: 'field',
        inferences: [],
        verification: { verdict: 'not-needed', rounds: 0 },
      };
    case 'blocked':
      return blocked('bank-silent', mapped.detail);
    case 'no-option':
      return blocked('check-failed', mapped.detail);
    case 'none':
      // The only file the answerer fills is the resume, by field mapping.
      if (q.type === 'file') {
        return blocked('unsupported-field', 'unsupported field type');
      }
  }

  const maxRounds = 1 + regenerations(ctx.models.maxRegenerations);
  let feedback: string[] = [];
  try {
    for (let round = 1; ; round++) {
      const generated = await ctx.caller.call({
        role: 'answer',
        model: ctx.models.answerModel,
        system: GENERATOR_SYSTEM,
        prompt: generatorPrompt(q, ctx, feedback),
        schema: generatorOutput,
      });
      calls.push(generated.stat);
      const candidate = toCandidate(generated.value);
      if (candidate.outcome === 'cannot-answer') {
        return blocked(candidate.reason, `generator: ${candidate.reason}`);
      }

      // A broken trace is not fixed by asking again: no retry.
      const checked = checkCandidate(q, candidate, ctx);
      if (!checked.ok) return blocked('check-failed', checked.detail);

      const verdict = await verifyCandidate(
        q,
        ctx,
        candidate,
        checked.value,
        calls,
      );
      if (verdict.verdict === 'confirmed') {
        return {
          ...base,
          status: 'backed',
          value: checked.value,
          sources: candidate.sources,
          derivation: candidate.derivation,
          inferences: candidate.inferences,
          verification: { verdict: 'confirmed', rounds: round },
        };
      }
      if (round >= maxRounds) {
        return blocked(
          'verifier-rejected',
          `verifier rejected: ${verdict.check}`,
        );
      }
      feedback = verdict.feedback;
    }
  } catch (e) {
    if (e instanceof ModelCallError)
      return blocked('model-error', 'model call failed');
    throw e;
  }
}
