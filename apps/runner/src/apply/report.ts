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
import { RULE_KINDS, type Claim } from '@xapply/disqualify';
import type { FactBank } from '@xapply/fact-bank';
import { REPORTS_DIR } from '../reports/write-report.js';
import type { UnknownField } from '../linkedin/types.js';
import type { FillProblem } from './fill.js';
import type {
  ApplyOutcome,
  ApplyRun,
  CheckRecord,
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
  /** One of a fixed set of our own words (see `FillProblem`). */
  fillProblem: FillProblem | null;
  result: RedactedResult | null;
}

/** A claim with no text: only our own words, codes and ids. */
export type RedactedClaim = Pick<
  Claim,
  'kind' | 'countries' | 'countryFrom' | 'source'
>;

export interface RedactedCheck {
  at: CheckRecord['at'];
  step: number | null;
  ok: boolean;
  claims: RedactedClaim[];
  calls: CheckRecord['calls'];
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
  /** Never the label. */
  unknownFields: Omit<UnknownField, 'label'>[];
  checks: RedactedCheck[];
  disqualification: RedactedClaim[] | null;
  via: ApplyRun['via'];
  record: ApplyRun['record'];
  timings: ApplyRun['timings'];
}

/** An allow-list copy: a field added to `Claim` later is not copied. */
const redactClaim = (c: Claim): RedactedClaim => ({
  kind: c.kind,
  countries: [...c.countries],
  countryFrom: c.countryFrom,
  source: c.source,
});

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
    checks: run.checks.map((c) => ({
      at: c.at,
      step: c.step,
      ok: c.ok,
      claims: c.claims.map(redactClaim),
      calls: c.calls.map((x) => ({ ...x })),
    })),
    disqualification: run.disqualification
      ? run.disqualification.map(redactClaim)
      : null,
    via: run.via,
    record: {
      before: run.record.before,
      beforeAt: run.record.beforeAt,
      after: run.record.after,
    },
    timings: {
      totalMs: run.timings.totalMs,
      perStepMs: [...run.timings.perStepMs],
      submit: run.timings.submit ? { ...run.timings.submit } : null,
    },
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
  const [head, ...rest] = r.disqualification ?? [];
  if (head) {
    lines.push(
      `${headline(head)}${rest.length > 0 ? ` (+${rest.length} more)` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const dateOf = (iso: string | null): string =>
  iso === null ? 'unknown date' : iso.slice(0, 10);

/**
 * The run's last line: fixed words and a date, never a label, a value or a
 * quote. After a Submit click that ended in a stop, it never implies that
 * nothing was sent.
 */
export function closingLine(run: ApplyRun): string {
  switch (run.outcome) {
    case 'submitted':
      return run.record.after === 'applied'
        ? 'submitted; LinkedIn shows Applied'
        : 'submitted; LinkedIn shows Applied, but the record was not updated; the next run settles it';
    case 'already-applied':
      return run.via === 'record'
        ? `already applied (record, ${dateOf(run.record.beforeAt)}); not opened`
        : run.record.after === 'applied'
          ? 'LinkedIn shows Applied; recorded'
          : 'LinkedIn shows Applied; not recorded';
    case 'disqualified':
      return run.via === 'record'
        ? `disqualified earlier (record, ${dateOf(run.record.beforeAt)}); not retried`
        : 'disqualified; not applied';
    case 'submit-unconfirmed':
      if (run.record.after === 'failed') {
        return run.record.before === 'submitting'
          ? 'previous submit unconfirmed; marked failed; run again to apply'
          : 'Submit clicked but LinkedIn does not show Applied; marked failed. Check the job on LinkedIn before running again';
      }
      return run.record.before === 'submitting'
        ? 'previous submit unconfirmed; the record was not updated; the next run settles it'
        : 'Submit clicked but LinkedIn does not show Applied; the record was not updated. Check the job on LinkedIn before running again';
    case 'reached-review':
      return 'reached the review page; not submitted';
    case 'not-easy-apply':
      return 'not an Easy Apply job; nothing submitted';
    case 'needs-author':
      return 'a question needs you; nothing submitted';
    case 'bridge-unavailable':
      return 'bridge unavailable; nothing submitted';
    case 'stopped':
    case 'safety-stop':
      return run.record.after === 'submitting' && run.timings.submit !== null
        ? 'stopped after the Submit click; Submit may have gone through; the next run settles it'
        : 'stopped; nothing submitted';
  }
}

/** `disqualified: <kind> <countries|unclear> at <source>`. */
function headline(c: RedactedClaim): string {
  const where = c.countries.length > 0 ? c.countries.join(',') : 'unclear';
  return `disqualified: ${c.kind} ${where} at ${c.source}`;
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

const RULE_KIND_SET: ReadonlySet<string> = new Set(RULE_KINDS);
/** A rule kind's `[]` is unclear; a log kind's is none. */
const isRuleKind = (k: Claim['kind']): boolean => RULE_KIND_SET.has(k);

/**
 * `pass` only when the run reached the review page with every check made;
 * any other outcome was never decided.
 */
function verdict(run: ApplyRun): string {
  const [head] = run.disqualification ?? [];
  if (run.outcome === 'disqualified' && head)
    return headline(redactClaim(head));
  if (run.outcome === 'reached-review' || run.outcome === 'submitted')
    return 'pass';
  return `not decided (${run.outcome}${run.stop ? `/${run.stop.kind}` : ''})`;
}

/** Every claim from every check, with its quote, and the verdict. */
function requirements(run: ApplyRun): string[] {
  const claims = run.checks.flatMap((c) => c.claims);
  const failed = run.checks.filter((c) => !c.ok).length;
  const failedLine = `Requirements not fully known: ${failed} check${failed === 1 ? '' : 's'} failed.`;
  const out = ['## Requirements', ''];
  if (claims.length === 0) {
    out.push(
      run.checks.length === 0
        ? 'No checks ran.'
        : failed > 0
          ? failedLine
          : 'No requirements found.',
    );
  } else {
    out.push(
      '| Where | Kind | Countries | Country from | Quote | Place quote | Detail |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const c of claims) {
      const countries =
        c.countries.length > 0
          ? c.countries.join(', ')
          : isRuleKind(c.kind)
            ? 'unclear'
            : '-';
      out.push(
        `| ${[
          c.source,
          c.kind,
          countries,
          c.countryFrom,
          `"${c.quote}"`,
          c.placeQuote === null ? '-' : `"${c.placeQuote}"`,
          c.detail ?? '-',
        ]
          .map(cell)
          .join(' | ')} |`,
      );
    }
    if (failed > 0) out.push('', failedLine);
  }
  out.push('', `Verdict: ${verdict(run)}`, '');
  return out;
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
    `Via: ${run.via ?? '-'}`,
    `Record: ${run.record.before ?? '-'} -> ${run.record.after ?? '-'}`,
  );
  out.push('', ...requirements(run));
  out.push(
    '## Timings',
    '',
    `Total: ${run.timings.totalMs} ms`,
    `Per step: ${run.timings.perStepMs.join(', ')} ms`,
    ...(run.timings.submit
      ? [
          `Submit: click to sent ${run.timings.submit.clickToSentMs ?? '-'} ms, sent to marker ${run.timings.submit.sentToMarkerMs ?? '-'} ms`,
        ]
      : []),
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
  if (!/^\d+$/.test(run.jobId))
    throw new Error('apply report: job id is not all digits');
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
