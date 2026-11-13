import { z } from 'zod';
import { FIELD_PATTERNS } from '../fields.js';
import { ModelCallError } from '../model/caller.js';
import type {
  Candidate,
  FieldKey,
  Inference,
  MathSpec,
  Source,
} from '../types.js';

// Flat shapes only: a JSON schema with unions is less reliable for structured
// output. Every key is present; a key that does not apply is null.

const FIELD_KEYS = Object.keys(FIELD_PATTERNS) as [FieldKey, ...FieldKey[]];

const CANNOT_ANSWER_REASONS = [
  'bank-silent',
  'no-story-fits',
  'boundary',
] as const;
const ANSWER_DERIVATIONS = [
  'as-written',
  'fitted',
  'math',
  'bucket',
  'composed',
] as const;

const sourceOutput = z.object({
  kind: z.enum(['field', 'fact', 'answer', 'story', 'job-post', 'run-date']),
  key: z.enum(FIELD_KEYS).nullable(),
  text: z.string().nullable(),
  id: z.string().nullable(),
  variant: z.number().int().nullable(),
  quote: z.string().nullable(),
});

export const generatorOutput = z.object({
  outcome: z.enum(['answer', 'cannot-answer']),
  reason: z.enum(CANNOT_ANSWER_REASONS).nullable(),
  value: z.union([z.string(), z.array(z.string())]).nullable(),
  sources: z.array(sourceOutput),
  derivation: z.enum(ANSWER_DERIVATIONS).nullable(),
  inferences: z.array(z.object({ claim: z.string(), source: sourceOutput })),
  math: z
    .object({
      kind: z.enum(['years-since', 'arithmetic']),
      year: z.number().int().nullable(),
      month: z.number().int().min(1).max(12).nullable(),
      expression: z.string().nullable(),
    })
    .nullable(),
});
export type GeneratorOutput = z.infer<typeof generatorOutput>;

export const fitOutput = z.object({ fits: z.boolean(), why: z.string() });
export type FitOutput = z.infer<typeof fitOutput>;

export const CLAIM_MARKS = [
  'backed',
  'inferred',
  'unsupported',
  'company-not-in-post',
] as const;

export const claimsOutput = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      mark: z.enum(CLAIM_MARKS),
      source: z.string().nullable(),
    }),
  ),
  storyDetailAdded: z.boolean(),
});
export type ClaimsOutput = z.infer<typeof claimsOutput>;

// Fixed messages: a bad combination never echoes the model's output.
const bad = (message: string): never => {
  throw new ModelCallError(`model output: ${message}`);
};

const present = (s: string | null): s is string =>
  s !== null && s.trim() !== '';

function toSource(s: z.infer<typeof sourceOutput>): Source {
  switch (s.kind) {
    case 'field':
      return s.key !== null
        ? { kind: 'field', key: s.key }
        : bad('field source without a key');
    case 'fact':
      return present(s.text)
        ? { kind: 'fact', text: s.text }
        : bad('fact source without text');
    case 'answer':
      if (!present(s.id)) return bad('answer source without an id');
      return s.variant === null
        ? { kind: 'answer', id: s.id }
        : { kind: 'answer', id: s.id, variant: s.variant };
    case 'story':
      return present(s.id)
        ? { kind: 'story', id: s.id }
        : bad('story source without an id');
    case 'job-post':
      return present(s.quote)
        ? { kind: 'job-post', quote: s.quote }
        : bad('job-post source without a quote');
    case 'run-date':
      return { kind: 'run-date' };
    default:
      return bad('unknown source kind');
  }
}

function toMath(m: GeneratorOutput['math']): MathSpec {
  if (m === null) return bad('math derivation without math');
  if (m.kind === 'years-since') {
    if (m.year === null) return bad('years-since without a year');
    return m.month === null
      ? { kind: 'years-since', year: m.year }
      : { kind: 'years-since', year: m.year, month: m.month };
  }
  if (m.kind === 'arithmetic') {
    return present(m.expression)
      ? { kind: 'arithmetic', expression: m.expression }
      : bad('arithmetic without an expression');
  }
  return bad('unknown math kind');
}

/**
 * Turns the flat model output into a Candidate. Throws a ModelCallError with a
 * fixed message (never a value) on a combination the shape cannot rule out.
 */
export function toCandidate(o: GeneratorOutput): Candidate {
  if (o.outcome === 'cannot-answer') {
    if (o.reason === null || !CANNOT_ANSWER_REASONS.includes(o.reason)) {
      return bad('cannot-answer without a valid reason');
    }
    return { outcome: 'cannot-answer', reason: o.reason };
  }
  if (o.outcome !== 'answer') return bad('unknown outcome');
  if (o.value === null) return bad('answer without a value');
  const derivation = o.derivation;
  if (derivation === null || !ANSWER_DERIVATIONS.includes(derivation)) {
    return bad('answer without a valid derivation');
  }
  const sources = o.sources.map(toSource);
  const inferences: Inference[] = o.inferences.map((i) => ({
    claim: i.claim,
    source: toSource(i.source),
  }));
  const candidate: Candidate = {
    outcome: 'answer',
    value: o.value,
    sources,
    derivation,
    inferences,
  };
  // Math is required for a math derivation. On a bucket it is kept when given:
  // on a choice, code checks it against the picked option's range. On any
  // other derivation it is never checked, so it is dropped.
  if (derivation === 'math') candidate.math = toMath(o.math);
  else if (derivation === 'bucket' && o.math !== null)
    candidate.math = toMath(o.math);
  return candidate;
}
