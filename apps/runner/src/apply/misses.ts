import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify, YAMLError } from 'yaml';
import { z } from 'zod';
import {
  normalizeLabel,
  TEXT_TYPES,
  type AnswerValue,
  type BlockReason,
  type FormQuestion,
  type GoldenCase,
  type GoldenFile,
  type Job,
  type Source,
} from '@xapply/answerer';
import { REPO_ROOT, writeAtomic } from './record.js';
import type { ApplyRun, QuestionRecord } from './types.js';

export const DEFAULT_MISSES_PATH = join(
  REPO_ROOT,
  'private',
  'answer-misses.yaml',
);

export type MissAnswer =
  | { kind: 'typed'; value: AnswerValue; via: 'terminal' | 'chat' }
  | { kind: 'blank' }
  | { kind: 'stopped' };

/** A question the bank didn't answer with a backed answer in a run. */
export interface Miss {
  /** `${jobId}-${slug(normalizedLabel)}-${type}`: the same question in a later run merges. */
  id: string;
  jobId: string;
  /** The first run's startedAt. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** YYYY-MM-DD (local) of firstSeenAt, as the answerer had it. */
  runDate: string;
  question: Omit<FormQuestion, 'id' | 'stepLabels'>;
  answer: MissAnswer;
  reason: BlockReason | 'not-reached';
  detail: string;
  sources: Source[];
  savedAs: string | null;
}

export interface MissesFile {
  version: 1;
  jobs: Record<string, Job>;
  misses: Miss[];
}

/** The misses file is unreadable or fails its schema. The message never holds a value. */
export class MissesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissesError';
  }
}

// ------------------------------------------------------------------ schema

const REASONS = [
  'bank-silent',
  'no-story-fits',
  'boundary',
  'check-failed',
  'verifier-rejected',
  'unsupported-field',
  'model-error',
  'not-reached',
] as const satisfies readonly Miss['reason'][];

const value = z.union([z.string(), z.array(z.string())]);

const answerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('typed'),
    value,
    via: z.enum(['terminal', 'chat']),
  }),
  z.strictObject({ kind: z.literal('blank') }),
  z.strictObject({ kind: z.literal('stopped') }),
]);

const sourceSchema = z.discriminatedUnion('kind', [
  // The answerer's FieldKey; its list isn't exported, and a source is kept, not used.
  z.strictObject({ kind: z.literal('field'), key: z.string().min(1) }),
  z.strictObject({ kind: z.literal('fact'), text: z.string() }),
  z.strictObject({
    kind: z.literal('answer'),
    id: z.string().min(1),
    variant: z.number().int().min(0).optional(),
  }),
  z.strictObject({ kind: z.literal('story'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('job-post'), quote: z.string() }),
  z.strictObject({ kind: z.literal('run-date') }),
]);

const questionSchema = z.strictObject({
  label: z.string(),
  type: z.string().min(1),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
  helpText: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
  stepTitle: z.string().optional(),
});

const jobSchema = z.strictObject({
  title: z.string(),
  company: z.string(),
  location: z.string().optional(),
  description: z.string(),
  source: z.string(),
});

const missSchema = z.strictObject({
  id: z.string().min(1),
  jobId: z.string().regex(/^\d+$/, 'must be a job id'),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  question: questionSchema,
  answer: answerSchema,
  reason: z.enum(REASONS),
  detail: z.string(),
  sources: z.array(sourceSchema),
  savedAs: z.string().min(1).nullable(),
});

const missesFileSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.record(z.string().regex(/^\d+$/, 'must be a job id'), jobSchema),
  misses: z.array(missSchema),
});

// -------------------------------------------------------------- derivation

/** The local date, as the run gave the answerer. */
function localDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const slug = (label: string): string =>
  normalizeLabel(label).replaceAll(' ', '-');

const missId = (jobId: string, q: { label: string; type: string }) =>
  `${jobId}-${slug(q.label)}-${q.type}`;

function answerOf(r: QuestionRecord): MissAnswer {
  if (r.by === 'author' && r.filled !== null) {
    return { kind: 'typed', value: r.filled, via: 'terminal' };
  }
  if (r.by === 'blank') return { kind: 'blank' };
  // needs-author, or a prompt left by Ctrl+C before `by` was set.
  return { kind: 'stopped' };
}

function questionOf(q: FormQuestion): Miss['question'] {
  const out: Miss['question'] = {
    label: q.label,
    type: q.type,
    required: q.required,
  };
  if (q.options !== undefined) out.options = [...q.options];
  if (q.helpText !== undefined) out.helpText = q.helpText;
  if (q.maxLength !== undefined) out.maxLength = q.maxLength;
  if (q.stepTitle !== undefined) out.stepTitle = q.stepTitle;
  return out;
}

/**
 * Every question in the run the bank didn't back: blocked, or never
 * answered. A backed answer that didn't fill is a form problem, not a miss.
 */
export function missesFromRun(run: ApplyRun): Miss[] {
  const out: Miss[] = [];
  for (const r of run.questions) {
    if (r.result?.status === 'backed') continue;
    out.push({
      id: missId(run.jobId, r.question),
      jobId: run.jobId,
      firstSeenAt: run.startedAt,
      lastSeenAt: run.startedAt,
      runDate: localDate(run.startedAt),
      question: questionOf(r.question),
      answer: answerOf(r),
      reason: r.result === null ? 'not-reached' : r.result.reason,
      detail: r.result === null ? '' : r.result.detail,
      // A blocked result cites no sources yet; kept for when one does.
      sources: [],
      savedAs: r.savedAs ?? null,
    });
  }
  return out;
}

const RANK: Record<MissAnswer['kind'], number> = {
  stopped: 0,
  blank: 1,
  typed: 2,
};

/** A new terminal answer always wins; otherwise the better-informed answer stays. */
function keepAnswer(old: MissAnswer, fresh: MissAnswer): MissAnswer {
  if (fresh.kind === 'typed') return fresh;
  return RANK[fresh.kind] > RANK[old.kind] ? fresh : old;
}

function merged(old: Miss, fresh: Miss): Miss {
  return {
    ...old,
    lastSeenAt:
      fresh.lastSeenAt > old.lastSeenAt ? fresh.lastSeenAt : old.lastSeenAt,
    question: fresh.question,
    answer: keepAnswer(old.answer, fresh.answer),
    reason: fresh.reason,
    detail: fresh.detail,
    sources: fresh.sources,
    savedAs: fresh.savedAs ?? old.savedAs,
  };
}

/**
 * The file with a run's misses added. A miss already in the file (same id)
 * is updated in place: its first sighting, run date and an answer given in
 * chat are kept. The run's job is added once, when the run has a miss.
 */
export function mergeMisses(
  file: MissesFile,
  run: ApplyRun,
  fresh: Miss[],
): MissesFile {
  const misses = [...file.misses];
  const at = new Map(misses.map((m, i) => [m.id, i]));
  for (const m of fresh) {
    const i = at.get(m.id);
    if (i === undefined) {
      at.set(m.id, misses.length);
      misses.push(m);
    } else {
      misses[i] = merged(misses[i] as Miss, m);
    }
  }
  const jobs = { ...file.jobs };
  if (fresh.length > 0 && run.job !== null) jobs[run.jobId] = { ...run.job };
  return { version: 1, jobs, misses };
}

// ------------------------------------------------------------- load / save

const pathOf = (path: PropertyKey[]) => path.map(String).join('.') || 'file';

/** Loads the misses file; a missing file is an empty one. */
export function loadMisses(path: string): MissesFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, jobs: {}, misses: [] };
    }
    throw new MissesError(`cannot read misses file ${path}`);
  }
  let raw: unknown;
  try {
    // logLevel 'error': a warning would print the source line to the console.
    raw = parse(text, { logLevel: 'error' });
  } catch (e) {
    // The YAML library's message quotes the source line, so only the line number is kept.
    const line = e instanceof YAMLError ? e.linePos?.[0]?.line : undefined;
    throw new MissesError(
      `misses file ${path}: YAML syntax error${line ? ` at line ${line}` : ''}`,
    );
  }
  const parsed = missesFileSchema.safeParse(raw);
  if (!parsed.success) {
    // Zod's messages name the expected shape and unknown keys, never the input value.
    const issues = parsed.error.issues.map(
      (i) => `${pathOf(i.path)}: ${i.message}`,
    );
    throw new MissesError(`misses file ${path}:\n${issues.join('\n')}`);
  }
  return parsed.data as MissesFile;
}

export function saveMisses(path: string, file: MissesFile): void {
  writeAtomic(path, stringify(file));
}

// -------------------------------------------------------------- conversion

const isText = (type: string) =>
  (TEXT_TYPES as readonly string[]).includes(type);

/**
 * The misses as a golden file, one case per typed miss. Blank and stopped
 * misses have no expectation and are left out, as is a miss whose job isn't
 * in the file. A text answer is not scored: the case expects only `backed`,
 * and the typed answer stays in the misses file. No `bank`: the command
 * supplies it.
 */
export function missesToGolden(file: MissesFile): GoldenFile {
  const cases: GoldenCase[] = [];
  const jobs: Record<string, Job> = {};
  for (const m of file.misses) {
    if (m.answer.kind !== 'typed') continue;
    const job = file.jobs[m.jobId];
    if (job === undefined) continue;
    jobs[m.jobId] = job;
    cases.push({
      id: m.id,
      question: { id: m.id, ...m.question },
      job: m.jobId,
      runDate: m.runDate,
      expect: isText(m.question.type)
        ? { status: 'backed' }
        : { status: 'backed', value: m.answer.value },
    });
  }
  const dates = (cases.length > 0 ? cases : file.misses)
    .map((c) => c.runDate as string)
    .sort();
  return {
    // Every case carries its own date; this is only the file's required one.
    runDate: dates[0] ?? localDate(new Date().toISOString()),
    jobs,
    cases,
  };
}
