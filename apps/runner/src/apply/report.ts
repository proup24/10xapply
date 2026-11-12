import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  redactResult,
  type AnswerResult,
  type AnswerValue,
  type FieldKey,
  type RedactedResult,
  type Source,
} from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import { REPORTS_DIR } from '../reports/write-report.js';
import type { UnknownField } from '../linkedin/types.js';
import type {
  ApplyOutcome,
  ApplyRun,
  QuestionRecord,
  StopKind,
} from './types.js';

/** <workspace>/private/runs, resolved from this file, not the cwd. */
export const PRIVATE_RUNS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'private',
  'runs',
);

export interface RedactedQuestion {
  id: string;
  step: number;
  type: string;
  by: QuestionRecord['by'];
  changedFromLinkedIn: boolean;
  savedAs: string | null;
  fillProblem: string | null;
  result: RedactedResult | null;
}

export interface RedactedApplyRun {
  jobId: string;
  startedAt: string;
  outcome: ApplyOutcome;
  stop: {
    kind: StopKind;
    step: number | null;
    pathPrefix: string | null;
  } | null;
  questions: RedactedQuestion[];
  unknownFields: UnknownField[];
  timings: ApplyRun['timings'];
}

/** The copy for Claude: ids, counts, kinds and timings; no text of any kind. */
export function redactApplyRun(
  run: ApplyRun,
  bank: FactBank,
): RedactedApplyRun {
  return {
    jobId: run.jobId,
    startedAt: run.startedAt,
    outcome: run.outcome,
    stop: run.stop
      ? {
          kind: run.stop.kind,
          step: run.stop.step,
          pathPrefix: run.stop.pathPrefix,
        }
      : null,
    questions: run.questions.map((q) => ({
      id: q.question.id,
      step: q.step,
      type: q.question.type,
      by: q.by,
      changedFromLinkedIn: q.changedFromLinkedIn,
      savedAs: q.savedAs ?? null,
      fillProblem: q.fillProblem ?? null,
      result: q.result ? redactResult(q.result, bank) : null,
    })),
    unknownFields: run.unknownFields.map((u) => ({
      tag: u.tag,
      role: u.role,
      inputType: u.inputType,
    })),
    timings: run.timings,
  };
}

/** The non-author terminal output: counts, the outcome and the stop kind. */
export function formatRedactedSummary(r: RedactedApplyRun): string {
  const counts = new Map<string, number>();
  for (const q of r.questions) counts.set(q.by, (counts.get(q.by) ?? 0) + 1);
  const by = [...counts].map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const lines = [
    `apply: ${r.outcome}`,
    `questions: ${r.questions.length} (${by})`,
  ];
  if (r.stop) {
    lines.push(
      `stop: ${r.stop.kind}${r.stop.step === null ? '' : ` at step ${r.stop.step}`}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const cell = (s: string): string =>
  s.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
const quote = (s: string): string => `"${cell(s)}"`;
const valueText = (v: AnswerValue | null): string =>
  v === null ? '' : Array.isArray(v) ? v.join('; ') : v;

function fieldValue(bank: FactBank, key: FieldKey): string {
  const f = bank.fields;
  switch (key) {
    case 'firstName':
      return f.firstName;
    case 'lastName':
      return f.lastName;
    case 'fullName':
      return f.fullName;
    case 'email':
      return f.email;
    case 'phone':
      return f.phone.full;
    case 'phoneCountryCode':
      return f.phone.countryCode;
    case 'phoneCountry':
      return f.phone.country;
    case 'city':
      return f.city;
    case 'location':
      return f.location;
    case 'country':
      return f.country;
    case 'linkedin':
      return f.links.linkedin;
    case 'github':
      return f.links.github ?? '';
    case 'portfolio':
      return f.links.portfolio ?? '';
    case 'website':
      return f.links.website ?? '';
    case 'resume':
      return f.resume;
  }
}

/** One source as quoted bank text (or job text), found by its id. */
function quoteSource(s: Source, bank: FactBank): string {
  switch (s.kind) {
    case 'field':
      return `field ${s.key}: ${quote(fieldValue(bank, s.key))}`;
    case 'fact':
      return `fact: ${quote(s.text)}`;
    case 'answer': {
      const a = bank.answers.find((x) => x.id === s.id);
      if (!a) return `answer ${s.id}: (not in the bank)`;
      const text =
        a.variants === undefined
          ? a.answer
          : (a.variants[s.variant ?? 0]?.answer ?? '(no such variant)');
      return `answer ${s.id}${s.variant === undefined ? '' : `#${s.variant}`}: ${quote(`${a.question} -> ${text}`)}`;
    }
    case 'story': {
      const st = bank.stories.find((x) => x.id === s.id);
      return st
        ? `story ${s.id}: ${quote(st.story)}`
        : `story ${s.id}: (not in the bank)`;
    }
    case 'job-post':
      return `job post: ${quote(s.quote)}`;
    case 'run-date':
      return 'run date';
  }
}

function derivation(r: AnswerResult | null): string {
  if (!r) return 'not reached';
  return r.status === 'backed'
    ? r.derivation
    : `blocked: ${r.reason} (${r.detail})`;
}

function row(q: QuestionRecord, bank: FactBank): string {
  const r = q.result;
  const rests =
    r && r.status === 'backed'
      ? r.sources.map((s) => quoteSource(s, bank)).join('; ')
      : '';
  const inferences =
    r && r.status === 'backed'
      ? r.inferences
          .map((i) => `${i.claim} [${quoteSource(i.source, bank)}]`)
          .join('; ')
      : '';
  const notes = [
    q.changedFromLinkedIn ? "changed from LinkedIn's value" : '',
    q.savedAs ? `saved as ${q.savedAs}` : '',
    q.fillProblem ? `fill problem: ${q.fillProblem}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const label = `${q.question.label}${q.question.options ? ` [${q.question.options.join(' / ')}]` : ''}`;
  return `| ${[
    label,
    q.question.type,
    valueText(q.filled),
    `${q.by} (${derivation(r)})`,
    rests,
    inferences,
    notes,
  ]
    .map(cell)
    .join(' | ')} |`;
}

/** The author's report: every label, answer and the bank text it rests on. */
export function formatRunMarkdown(run: ApplyRun, bank: FactBank): string {
  const out: string[] = [`# Apply run ${run.jobId}`, ''];
  out.push(`Started: ${run.startedAt}`);
  if (run.job) {
    out.push(
      `Job: ${run.job.title} at ${run.job.company}${run.job.location ? `, ${run.job.location}` : ''}`,
    );
  }
  out.push('');
  const steps = [...new Set(run.questions.map((q) => q.step))].sort(
    (a, b) => a - b,
  );
  for (const step of steps) {
    const qs = run.questions.filter((q) => q.step === step);
    const title = qs[0]?.question.stepTitle;
    out.push(`## Step ${step}${title ? `: ${title}` : ''}`, '');
    out.push(
      '| Label | Type | Answer | By | Rests on | Inferences | Note |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const q of qs) out.push(row(q, bank));
    out.push('');
  }
  out.push('## Outcome', '', `Outcome: ${run.outcome}`);
  if (run.stop) {
    out.push(
      `Stop: ${run.stop.kind}${run.stop.step === null ? '' : ` at step ${run.stop.step}`}`,
      `Detail: ${run.stop.detail}`,
    );
    if (run.stop.error) out.push(`Error: ${run.stop.error}`);
    if (run.stop.pathPrefix) out.push(`Page path: ${run.stop.pathPrefix}`);
    for (const e of run.stop.pageErrors ?? []) out.push(`Page error: ${e}`);
  }
  if (run.unknownFields.length > 0) {
    out.push(
      `Unknown fields: ${run.unknownFields.map((u) => `${u.tag}/${u.role ?? '-'}/${u.inputType ?? '-'}`).join(', ')}`,
    );
  }
  out.push(
    '',
    '## Timings',
    '',
    `Total: ${run.timings.totalMs} ms`,
    `Per step: ${run.timings.perStepMs.join(', ')} ms`,
    '',
  );
  return out.join('\n');
}

/** Writes the author's .md and .json and the redacted .json. */
export function writeApplyReports(
  run: ApplyRun,
  bank: FactBank,
  dirs: { privateRuns: string; reports: string } = {
    privateRuns: PRIVATE_RUNS_DIR,
    reports: REPORTS_DIR,
  },
): { full: string; redacted: string } {
  mkdirSync(dirs.privateRuns, { recursive: true });
  mkdirSync(dirs.reports, { recursive: true });
  const stamp = run.startedAt.replaceAll(':', '-');
  const base = join(dirs.privateRuns, `${stamp}-${run.jobId}`);
  writeFileSync(`${base}.md`, formatRunMarkdown(run, bank));
  writeFileSync(`${base}.json`, `${JSON.stringify(run, null, 2)}\n`);
  const redacted = join(dirs.reports, `apply-${stamp}.json`);
  writeFileSync(
    redacted,
    `${JSON.stringify(redactApplyRun(run, bank), null, 2)}\n`,
  );
  return { full: `${base}.md`, redacted };
}
