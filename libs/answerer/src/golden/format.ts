import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse, YAMLError } from 'yaml';
import { z } from 'zod';
import { FIELD_PATTERNS } from '../fields.js';
import {
  TEXT_TYPES,
  type BlockReason,
  type Derivation,
  type FieldKey,
  type FormQuestion,
  type Job,
} from '../types.js';

/** A golden file that cannot be used. The message names paths and case ids, never a value. */
export class GoldenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenError';
  }
}

/** The placeholder for a value only the author knows. The eval refuses to run while one is left. */
export const TODO_AUTHOR = 'TODO-author';

const BLOCK_REASONS = [
  'bank-silent',
  'no-story-fits',
  'boundary',
  'check-failed',
  'verifier-rejected',
  'unsupported-field',
  'model-error',
] as const satisfies readonly BlockReason[];

const DERIVATIONS = [
  'field',
  'as-written',
  'fitted',
  'math',
  'bucket',
  'composed',
] as const satisfies readonly Derivation[];

const FIELD_KEYS = Object.keys(FIELD_PATTERNS) as [FieldKey, ...FieldKey[]];

/** A source the result must hold. Facts are given by bank index, so the case file never quotes one. */
export type ExpectSource =
  | { fact: number }
  | { answer: string }
  | { story: string }
  | { field: FieldKey }
  | { jobPost: true };

export interface Expect {
  status: 'backed' | 'blocked';
  reason?: BlockReason;
  value?: string | string[];
  valueFrom?: { answer: string } | { field: FieldKey };
  sources?: ExpectSource[];
  derivation?: Derivation;
  mustNotClaim?: string[];
}

export interface GoldenCase {
  id: string;
  /** Its id defaults to the case id. */
  question: FormQuestion;
  /** A key of `jobs`; 'default' when not given. */
  job?: string;
  expect: Expect;
}

export interface GoldenFile {
  /** The bank to run against, resolved from the golden file's folder. */
  bank?: string;
  /** YYYY-MM-DD */
  runDate: string;
  jobs: Record<string, Job>;
  cases: GoldenCase[];
}

const id = z.string().min(1);

const expectSource = z.union([
  z.strictObject({ fact: z.number().int().min(0) }),
  z.strictObject({ answer: id }),
  z.strictObject({ story: id }),
  z.strictObject({ field: z.enum(FIELD_KEYS) }),
  z.strictObject({ jobPost: z.literal(true) }),
]);

const expectSchema = z
  .strictObject({
    status: z.enum(['backed', 'blocked']),
    reason: z.enum(BLOCK_REASONS).optional(),
    value: z.union([z.string(), z.array(z.string())]).optional(),
    valueFrom: z
      .union([
        z.strictObject({ answer: id }),
        z.strictObject({ field: z.enum(FIELD_KEYS) }),
      ])
      .optional(),
    sources: z.array(expectSource).optional(),
    derivation: z.enum(DERIVATIONS).optional(),
    mustNotClaim: z.array(z.string().min(1)).optional(),
  })
  .superRefine((e, issue) => {
    const add = (message: string) =>
      issue.addIssue({ code: 'custom', message });
    if (e.value !== undefined && e.valueFrom !== undefined) {
      add('give value or valueFrom, not both');
    }
    if (e.status === 'backed' && e.reason !== undefined) {
      add('reason is only for a blocked expectation');
    }
    if (
      e.status === 'blocked' &&
      (e.value !== undefined ||
        e.valueFrom !== undefined ||
        e.sources !== undefined ||
        e.derivation !== undefined ||
        e.mustNotClaim !== undefined)
    ) {
      add('a blocked expectation has only status and reason');
    }
  });

const questionSchema = z.strictObject({
  id: id.optional(),
  label: z.string().min(1),
  type: z.string().min(1),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  helpText: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  stepTitle: z.string().optional(),
});

const jobSchema = z.strictObject({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  description: z.string().min(1),
  source: z.string().min(1).default('LinkedIn'),
});

const caseSchema = z.strictObject({
  id,
  question: questionSchema,
  job: id.optional(),
  expect: expectSchema,
});

export const goldenFileSchema = z.strictObject({
  bank: z.string().min(1).optional(),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  jobs: z.record(z.string(), jobSchema),
  cases: z.array(caseSchema),
});

/** The case id at a path into the raw file, when the case has one. */
function caseLabel(raw: unknown, path: PropertyKey[]): string | null {
  if (path[0] !== 'cases' || typeof path[1] !== 'number') return null;
  const cases = (raw as { cases?: unknown })?.cases;
  const c = Array.isArray(cases) ? (cases[path[1]] as unknown) : undefined;
  const caseId = (c as { id?: unknown } | undefined)?.id;
  return typeof caseId === 'string' ? `case ${caseId}` : `case #${path[1]}`;
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

const hasTodo = (e: Expect): boolean =>
  Array.isArray(e.value)
    ? e.value.some((v) => v.trim() === TODO_AUTHOR)
    : e.value?.trim() === TODO_AUTHOR;

/**
 * Loads a golden file. Throws a GoldenError on a syntax or shape error, an
 * unknown key, a duplicated case id, a case whose job is not defined, a
 * backed text case that pins no value and is not `derivation: composed`, or
 * any `TODO-author` value left in it. `bank`, when given, is resolved from the
 * golden file's folder.
 */
export function loadGolden(path: string): GoldenFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new GoldenError(`cannot read golden file ${path}`);
  }
  let raw: unknown;
  try {
    // logLevel 'error': a warning would print the source line to the console.
    raw = parse(text, { logLevel: 'error' });
  } catch (e) {
    // The YAML library's message quotes the source line, so only the line number is kept.
    const line = e instanceof YAMLError ? e.linePos?.[0]?.line : undefined;
    throw new GoldenError(
      `golden file ${path}: YAML syntax error${line ? ` at line ${line}` : ''}`,
    );
  }

  const parsed = goldenFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoldenError(
      `golden file ${path}:\n${describeIssues(raw, parsed.error.issues).join('\n')}`,
    );
  }
  const data = parsed.data;

  const problems: string[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const c of data.cases) {
    if (seen.has(c.id)) duplicated.add(c.id);
    seen.add(c.id);
  }
  if (duplicated.size > 0)
    problems.push(`duplicated case ids: ${[...duplicated].join(', ')}`);

  const noJob = data.cases.filter(
    (c) => !Object.hasOwn(data.jobs, c.job ?? 'default'),
  );
  if (noJob.length > 0) {
    problems.push(
      `cases whose job is not defined: ${noJob.map((c) => c.id).join(', ')}`,
    );
  }

  // The judge scores only composed text, so a backed text case must pin its
  // value or be composed. Otherwise an as-written or fitted answer would be
  // checked by nothing.
  const unpinned = data.cases.filter(
    (c) =>
      c.expect.status === 'backed' &&
      (TEXT_TYPES as readonly string[]).includes(c.question.type) &&
      c.expect.value === undefined &&
      c.expect.valueFrom === undefined &&
      c.expect.derivation !== 'composed',
  );
  if (unpinned.length > 0) {
    problems.push(
      `backed text cases with no value or valueFrom that are not derivation composed: ${unpinned.map((c) => c.id).join(', ')}`,
    );
  }

  const todo = data.cases.filter((c) => hasTodo(c.expect));
  if (todo.length > 0) {
    problems.push(
      `cases with a ${TODO_AUTHOR} value left: ${todo.map((c) => c.id).join(', ')}`,
    );
  }
  if (problems.length > 0) {
    throw new GoldenError(`golden file ${path}:\n${problems.join('\n')}`);
  }

  return {
    ...(data.bank !== undefined && {
      bank: resolve(dirname(path), data.bank),
    }),
    runDate: data.runDate,
    jobs: data.jobs,
    cases: data.cases.map((c) => ({
      ...c,
      question: { ...c.question, id: c.question.id ?? c.id },
    })),
  };
}
