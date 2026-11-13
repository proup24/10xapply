import type { FactBank } from '@xapply/fact-bank';
import type {
  AnswerResult,
  BlockReason,
  CallStat,
  Derivation,
  Source,
} from './types.js';

export interface RedactedResult {
  questionId: string;
  required: boolean;
  status: 'backed' | 'blocked';
  reason?: BlockReason;
  derivation?: Derivation;
  sources: { kind: Source['kind']; ref?: string | number }[];
  inferenceCount: number;
  rounds?: number;
  calls: CallStat[];
}

function redactSource(
  s: Source,
  bank: FactBank,
): RedactedResult['sources'][number] {
  switch (s.kind) {
    case 'fact':
      return {
        kind: 'fact',
        ref: bank.facts.findIndex((f) => f.text === s.text.trim()),
      };
    case 'answer':
      return {
        kind: 'answer',
        ref: s.variant === undefined ? s.id : `${s.id}#${s.variant}`,
      };
    case 'story':
      return { kind: 'story', ref: s.id };
    case 'field':
      return { kind: 'field', ref: s.key };
    default:
      return { kind: s.kind };
  }
}

/** A form of the result safe for run reports: ids and counts only, no text. */
export function redactResult(r: AnswerResult, bank: FactBank): RedactedResult {
  const base = {
    questionId: r.questionId,
    required: r.required,
    calls: r.calls,
  };
  if (r.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      reason: r.reason,
      sources: [],
      inferenceCount: 0,
    };
  }
  return {
    ...base,
    status: 'backed',
    derivation: r.derivation,
    sources: r.sources.map((s) => redactSource(s, bank)),
    inferenceCount: r.inferences.length,
    rounds: r.verification.rounds,
  };
}
