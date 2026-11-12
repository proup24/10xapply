import type { FactBank } from '@xapply/fact-bank';
import { FIELD_PATTERNS } from '../fields.js';
import { fieldValue, fillPlaceholders } from '../sources.js';
import type {
  AnswerContext,
  AnswerValue,
  FieldKey,
  FormQuestion,
  Source,
} from '../types.js';

/** What every prompt is built from: the bank, the job post and the run date. */
export type PromptContext = Pick<AnswerContext, 'bank' | 'job' | 'runDate'>;

const FIELD_KEYS = Object.keys(FIELD_PATTERNS) as FieldKey[];

const clean = (text: string): string => text.trim();

const section = (title: string, lines: string[]): string =>
  [title, ...(lines.length > 0 ? lines : ['(none)'])].join('\n');

/**
 * The whole bank as text. Facts are numbered from 0 in bank order, the same
 * index the eval and the redacted report use. Variants are numbered from 0,
 * the same index a source's `variant` holds. Placeholders are left unfilled.
 */
export function renderBank(bank: FactBank): string {
  const fields = FIELD_KEYS.flatMap((key) => {
    const value = fieldValue(key, bank);
    return value === null || value.trim() === '' ? [] : [`${key}: ${value}`];
  });
  const facts = bank.facts.map((f, i) => `[fact ${i}] ${clean(f.text)}`);
  const answers = bank.answers.flatMap((a) => {
    if (a.variants === undefined) {
      return [`[answer ${a.id}] Q: ${clean(a.question)} A: ${clean(a.answer)}`];
    }
    return [
      `[answer ${a.id}] Q: ${clean(a.question)} (variants below; cite the one whose "when" fits)`,
      ...a.variants.map(
        (v, i) =>
          `[answer ${a.id} variant ${i}] when: ${clean(v.when)} A: ${clean(v.answer)}`,
      ),
    ];
  });
  const stories = bank.stories.map(
    (s) =>
      `[story ${s.id}] ${clean(s.title)} (${s.tags.join(', ')}): ${clean(s.story)}`,
  );
  return [
    section('FIELDS', fields),
    section('FACTS', facts),
    section('KNOWN ANSWERS', answers),
    section('STORIES', stories),
  ].join('\n\n');
}

/**
 * The shared prefix of every prompt for one form: the bank, the job post and
 * the run date. It stays the same for every question of the form.
 */
export function renderContext(ctx: PromptContext): string {
  const { job } = ctx;
  return [
    `<fact_bank>\n${renderBank(ctx.bank)}\n</fact_bank>`,
    [
      '<job_post>',
      `Title: ${job.title}`,
      `Company: ${job.company}`,
      ...(job.location ? [`Location: ${job.location}`] : []),
      `Found through: ${job.source}`,
      'Description:',
      clean(job.description),
      '</job_post>',
    ].join('\n'),
    [
      '<run_date>',
      ctx.runDate,
      'Today\'s date, YYYY-MM-DD. It is a citable source: cite it as a source of kind "run-date" for years-since math.',
      '</run_date>',
    ].join('\n'),
  ].join('\n\n');
}

/** The question, always the last part of a prompt. */
export function renderQuestion(q: FormQuestion): string {
  const lines = ['<question>', `Label: ${q.label}`, `Type: ${q.type}`];
  if (q.options !== undefined && q.options.length > 0) {
    lines.push(
      'Options, as offered and in order:',
      ...q.options.map((o) => `- ${o}`),
    );
  }
  lines.push(`Required: ${q.required ? 'yes' : 'no'}`);
  if (q.helpText) lines.push(`Help text: ${q.helpText}`);
  if (q.maxLength !== undefined) {
    lines.push(`maxLength: ${q.maxLength} characters`);
  }
  if (q.stepTitle) lines.push(`Form step: ${q.stepTitle}`);
  lines.push('</question>');
  return lines.join('\n');
}

/**
 * One cited source as text, with the same labels as the bank text. A cited
 * answer shows its original question, its variant and `when`, and its text with
 * placeholders filled.
 */
export function renderSource(source: Source, ctx: PromptContext): string {
  switch (source.kind) {
    case 'field':
      return `[field ${source.key}] ${fieldValue(source.key, ctx.bank) ?? '(not in the bank)'}`;
    case 'fact': {
      const i = ctx.bank.facts.findIndex((f) => f.text === source.text.trim());
      return i === -1
        ? `[fact not in the bank] ${source.text}`
        : `[fact ${i}] ${clean(ctx.bank.facts[i].text)}`;
    }
    case 'answer': {
      const a = ctx.bank.answers.find((x) => x.id === source.id);
      if (!a) return `[answer ${source.id}] (not in the bank)`;
      const q = `Q: ${clean(a.question)}`;
      if (a.variants === undefined) {
        return `[answer ${a.id}] ${q} A: ${clean(fillPlaceholders(a.answer, ctx.job))}`;
      }
      const v =
        source.variant === undefined ? undefined : a.variants[source.variant];
      if (!v) return `[answer ${a.id}] ${q} (no such variant)`;
      return `[answer ${a.id} variant ${source.variant}] ${q} when: ${clean(v.when)} A: ${clean(fillPlaceholders(v.answer, ctx.job))}`;
    }
    case 'story': {
      const s = ctx.bank.stories.find((x) => x.id === source.id);
      return s
        ? `[story ${s.id}] ${clean(s.title)}: ${clean(s.story)}`
        : `[story ${source.id}] (not in the bank)`;
    }
    case 'job-post':
      return `[job post] "${source.quote}"`;
    case 'run-date':
      return `[run date] ${ctx.runDate}`;
  }
}

/** A value as text: a multi-select is one option per line. */
export function renderValue(value: AnswerValue): string {
  return Array.isArray(value)
    ? value.length === 0
      ? '(no option ticked)'
      : value.map((v) => `- ${v}`).join('\n')
    : value;
}
