import type { AnswerContext, Job, Source } from './types.js';

type SourceContext = Pick<AnswerContext, 'bank' | 'job' | 'runDate'>;

/** Replaces {source}, {company} and {jobTitle} with the job's values. */
export function fillPlaceholders(text: string, job: Job): string {
  return text
    .replaceAll('{source}', job.source)
    .replaceAll('{company}', job.company)
    .replaceAll('{jobTitle}', job.title);
}

/** Trims and compares case-insensitively. Returns the option exactly as offered. */
export function matchOption(value: string, options: string[]): string | null {
  const wanted = value.trim().toLowerCase();
  return options.find((o) => o.trim().toLowerCase() === wanted) ?? null;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function fieldValue(
  key: Extract<Source, { kind: 'field' }>['key'],
  bank: SourceContext['bank'],
): string | null {
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
      return f.links.github ?? null;
    case 'portfolio':
      return f.links.portfolio ?? null;
    case 'website':
      return f.links.website ?? null;
    case 'resume':
      return f.resume;
    default:
      return null;
  }
}

/**
 * The text a source points to, with placeholders filled. Null when the source
 * does not exist: a missing id, a variant index that does not fit the answer,
 * a fact that is not an exact fact sentence, or a quote not in the description.
 */
export function sourceText(source: Source, ctx: SourceContext): string | null {
  switch (source.kind) {
    case 'field':
      return fieldValue(source.key, ctx.bank);
    case 'fact':
      return (
        ctx.bank.facts.find((f) => f.text === source.text.trim())?.text ?? null
      );
    case 'answer': {
      const a = ctx.bank.answers.find((x) => x.id === source.id);
      if (!a) return null;
      if (a.variants !== undefined) {
        const v = source.variant;
        if (v === undefined || !Number.isInteger(v)) return null;
        const variant = a.variants[v];
        return variant ? fillPlaceholders(variant.answer, ctx.job) : null;
      }
      if (source.variant !== undefined) return null;
      return fillPlaceholders(a.answer, ctx.job);
    }
    case 'story':
      return ctx.bank.stories.find((s) => s.id === source.id)?.story ?? null;
    case 'job-post': {
      const quote = squash(source.quote);
      if (quote === '') return null;
      return squash(ctx.job.description).includes(quote) ? quote : null;
    }
    case 'run-date':
      return ctx.runDate;
    default:
      return null;
  }
}
