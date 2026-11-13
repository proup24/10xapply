import { readFileSync } from 'node:fs';
import { parse, YAMLError } from 'yaml';
import { z } from 'zod';
import { isCountryToken } from '../countries.js';
import { parseRules, type Rules } from '../rules.js';
import { RULE_KINDS, type CheckJob, type CheckQuestion } from '../types.js';
import type { RuleKind } from '../types.js';

/** A golden file that cannot be used. The message names paths and case ids, never a value. */
export class DisqualifyGoldenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisqualifyGoldenError';
  }
}

export const GROUPS = [
  'authorization',
  'sponsorship',
  'job-page',
  'near-miss',
  'location',
  'language',
] as const;
export type Group = (typeof GROUPS)[number];

export interface ExpectedClaim {
  kind: RuleKind;
  /** Codes or region names; compared by expansion, so UK equals GB and [] equals []. */
  countries: string[];
}

export interface DisqCase {
  id: string;
  group: Group;
  /** Defaults to the file's `defaultJob`. */
  job?: CheckJob;
  /** Run the job-page check. Defaults to true when the case gives its own `job`. */
  checkJob: boolean;
  /** Ids are assigned s1-q1, s1-q2, ... when the case runs. */
  questions?: Array<Omit<CheckQuestion, 'id'>>;
  expect: { verdict: 'pass' | 'disqualified'; claims: ExpectedClaim[] };
}

export interface DisqualifyGolden {
  rules: Rules;
  defaultJob: CheckJob;
  cases: DisqCase[];
}

const text = z.string().min(1);
const jobSchema = z.strictObject({
  title: text,
  company: text,
  description: text,
});
const questionSchema = z.strictObject({
  label: text,
  type: text.optional(),
  options: z.array(z.string()).optional(),
  helpText: z.string().optional(),
  stepTitle: z.string().optional(),
});
const countries = z.array(
  z.string().refine(isCountryToken, { message: 'not a country code' }),
);
const caseSchema = z.strictObject({
  id: text,
  group: z.enum(GROUPS),
  job: jobSchema.optional(),
  checkJob: z.boolean().optional(),
  questions: z.array(questionSchema).optional(),
  expect: z.strictObject({
    verdict: z.enum(['pass', 'disqualified']),
    claims: z.array(z.strictObject({ kind: z.enum(RULE_KINDS), countries })),
  }),
});
const fileSchema = z.strictObject({
  rules: z.unknown(),
  defaultJob: jobSchema,
  cases: z.array(caseSchema),
});

function caseLabel(raw: unknown, path: PropertyKey[]): string | null {
  if (path[0] !== 'cases' || typeof path[1] !== 'number') return null;
  const cases = (raw as { cases?: unknown })?.cases;
  const c = Array.isArray(cases) ? (cases[path[1]] as unknown) : undefined;
  const id = (c as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? `case ${id}` : `case #${path[1]}`;
}

/** Zod's messages name the expected shape and unknown keys, never the input value. */
function describeIssues(raw: unknown, issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const where = caseLabel(raw, i.path);
    const rest = (where === null ? i.path : i.path.slice(2))
      .map(String)
      .join('.');
    const at = [where, rest].filter((s) => s !== null && s !== '').join(': ');
    return `${at || 'file'}: ${i.message}`;
  });
}

/**
 * Loads the golden set. Throws a DisqualifyGoldenError on a syntax or shape
 * error, an unknown key or group, a bad country, bad rules, a duplicated case
 * id, or a case with neither `job` nor `questions`.
 */
export function loadDisqualifyGolden(path: string): DisqualifyGolden {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw new DisqualifyGoldenError(`cannot read golden file ${path}`);
  }
  let raw: unknown;
  try {
    raw = parse(source, { logLevel: 'error' });
  } catch (e) {
    const line = e instanceof YAMLError ? e.linePos?.[0]?.line : undefined;
    throw new DisqualifyGoldenError(
      `golden file ${path}: YAML syntax error${line ? ` at line ${line}` : ''}`,
    );
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DisqualifyGoldenError(
      `golden file ${path}:\n${describeIssues(raw, parsed.error.issues).join('\n')}`,
    );
  }
  const data = parsed.data;

  const problems: string[] = [];
  const rules = parseRules(data.rules);
  if (!rules.ok) problems.push(...rules.problems.map((p) => `rules ${p}`));

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const c of data.cases) {
    if (seen.has(c.id)) duplicated.add(c.id);
    seen.add(c.id);
  }
  if (duplicated.size > 0)
    problems.push(`duplicated case ids: ${[...duplicated].join(', ')}`);
  for (const c of data.cases) {
    if (c.job === undefined && (c.questions?.length ?? 0) === 0)
      problems.push(`case ${c.id}: needs a job or questions`);
  }
  if (problems.length > 0 || !rules.ok) {
    throw new DisqualifyGoldenError(
      `golden file ${path}:\n${problems.join('\n')}`,
    );
  }

  return {
    rules: rules.rules,
    defaultJob: data.defaultJob,
    cases: data.cases.map((c) => ({
      ...c,
      checkJob: c.checkJob ?? c.job !== undefined,
    })),
  };
}
