import {
  evaluate,
  expressionNumbers,
  MathError,
  MONTHS,
  numbersIn,
  yearsSince,
} from './math.js';
import { matchOption, sourceText } from './sources.js';
import {
  CHOICE_TYPES,
  TEXT_TYPES,
  type AnswerContext,
  type AnswerValue,
  type Candidate,
  type FormQuestion,
  type Source,
} from './types.js';

type AnswerCandidate = Extract<Candidate, { outcome: 'answer' }>;

/** A failure names the check that failed and never holds a value. */
export type CheckResult =
  { ok: true; value: AnswerValue } | { ok: false; detail: string };

const fail = (detail: string): CheckResult => ({ ok: false, detail });

const NUMBER_ONLY = /^\d+(?:\.\d+)?$/;
const WHOLE_NUMBER = /^\d+$/;

/** Regex source matching any name (full or three-letter) of the month. */
function monthNames(month: number): string {
  return Object.entries(MONTHS)
    .filter(([, n]) => n === month)
    .map(([name]) => name)
    .join('|');
}

const ANY_MONTH = Object.keys(MONTHS).join('|');

/** True when the text holds `<month> <year>` or `<month>, <year>`. */
function hasMonthYear(text: string, names: string, year: number): boolean {
  return new RegExp(String.raw`\b(?:${names})\b,?\s+${year}\b`, 'i').test(text);
}

/** Same source, compared by its identifying keys (fact text and quotes trimmed). */
function sameSource(a: Source, b: Source): boolean {
  switch (a.kind) {
    case 'field':
      return b.kind === 'field' && a.key === b.key;
    case 'fact':
      return b.kind === 'fact' && a.text.trim() === b.text.trim();
    case 'answer':
      return b.kind === 'answer' && a.id === b.id && a.variant === b.variant;
    case 'story':
      return b.kind === 'story' && a.id === b.id;
    case 'job-post':
      return (
        b.kind === 'job-post' &&
        a.quote.replace(/\s+/g, ' ').trim() ===
          b.quote.replace(/\s+/g, ' ').trim()
      );
    case 'run-date':
      return b.kind === 'run-date';
  }
}

function checkMath(
  c: AnswerCandidate,
  authorTexts: string[],
  allowed: Set<number>,
  runDate: string,
  value: string,
): CheckResult | { result: number } {
  const spec = c.math;
  if (!spec) return fail('math missing');
  try {
    let result: number;
    if (spec.kind === 'years-since') {
      // The year must come from the author's own entries, never the job post or the run date.
      if (!authorTexts.some((t) => numbersIn(t).includes(spec.year))) {
        return fail('number not in sources');
      }
      if (spec.month !== undefined) {
        const names = monthNames(spec.month);
        if (
          names === '' ||
          !authorTexts.some((t) => hasMonthYear(t, names, spec.year))
        ) {
          return fail('number not in sources');
        }
      } else if (
        authorTexts.some((t) => hasMonthYear(t, ANY_MONTH, spec.year))
      ) {
        // The source gives a month; dropping it would overstate the years.
        return fail('math does not match');
      }
      result = yearsSince(spec, runDate);
    } else {
      if (!expressionNumbers(spec.expression).every((n) => allowed.has(n))) {
        return fail('number not in sources');
      }
      result = Math.floor(evaluate(spec.expression));
    }
    if (!WHOLE_NUMBER.test(value) || Number(value) !== result) {
      return fail('math does not match');
    }
    return { result };
  } catch (e) {
    if (e instanceof MathError) return fail('math does not match');
    throw e;
  }
}

function checkChoice(
  q: FormQuestion,
  c: AnswerCandidate,
  answerTexts: string[],
): CheckResult {
  const value = c.value;
  const options = q.options ?? [];
  if (q.type === 'checkbox-group') {
    if (!Array.isArray(value)) return fail('wrong value shape');
    if (value.length === 0) {
      return q.required
        ? fail('empty required answer')
        : { ok: true, value: [] };
    }
    const matched: string[] = [];
    for (const item of value) {
      const option =
        typeof item === 'string' ? matchOption(item, options) : null;
      if (option === null || matched.includes(option)) {
        return fail('option not offered');
      }
      matched.push(option);
    }
    return { ok: true, value: matched };
  }
  if (typeof value !== 'string') return fail('wrong value shape');
  const option = matchOption(value, options);
  if (option === null) return fail('option not offered');
  // The value may not contradict the cited answer.
  if (c.derivation === 'as-written') {
    if (answerTexts.length !== 1) return fail('not as written');
    if (matchOption(answerTexts[0], options) !== option) {
      return fail('not as written');
    }
  } else if (c.derivation === 'fitted') {
    for (const text of answerTexts) {
      const cited = matchOption(text, options);
      if (cited !== null && cited !== option) return fail('not as written');
    }
  }
  return { ok: true, value: option };
}

/**
 * The deterministic checks. These are the main guard against an invented or
 * wrong answer, so any doubt fails the check.
 */
export function checkCandidate(
  q: FormQuestion,
  c: AnswerCandidate,
  ctx: AnswerContext,
): CheckResult {
  const isChoice = (CHOICE_TYPES as readonly string[]).includes(q.type);
  const isText = (TEXT_TYPES as readonly string[]).includes(q.type);
  const isNumber = q.type === 'number';
  const isFile = q.type === 'file';
  if (!isChoice && !isText && !isNumber && !isFile)
    return fail('wrong value shape');

  const wantsArray = q.type === 'checkbox-group';
  if (Array.isArray(c.value) !== wantsArray) return fail('wrong value shape');

  // Every source exists.
  const texts: string[] = [];
  for (const source of c.sources) {
    const text = sourceText(source, ctx);
    if (text === null) return fail('unknown source');
    texts.push(text);
  }
  // Every inference rests on a source that exists and is cited.
  for (const inference of c.inferences) {
    if (
      sourceText(inference.source, ctx) === null ||
      !c.sources.some((s) => sameSource(s, inference.source))
    ) {
      return fail('unknown source');
    }
  }
  // A job post or the run date never backs a claim about the author.
  if (c.sources.every((s) => s.kind === 'job-post' || s.kind === 'run-date')) {
    return fail('no source about the author');
  }

  if (isFile) {
    const hasResume = c.sources.some(
      (s) => s.kind === 'field' && s.key === 'resume',
    );
    return c.value === ctx.bank.fields.resume && hasResume
      ? { ok: true, value: c.value }
      : fail('not the resume');
  }

  const answerTexts = c.sources.flatMap((s, i) =>
    s.kind === 'answer' ? [texts[i]] : [],
  );
  if (isChoice) return checkChoice(q, c, answerTexts);

  // Text and number values.
  const raw = c.value as string;
  const value = raw.trim();
  if (/[{}]/.test(value)) return fail('unfilled placeholder');
  if (value === '')
    return q.required ? fail('empty required answer') : { ok: true, value };
  if (q.maxLength !== undefined && value.length > q.maxLength)
    return fail('too long');
  if (isNumber && !NUMBER_ONLY.test(value)) return fail('not a number');

  if (c.derivation === 'as-written') {
    const answers = c.sources.filter((s: Source) => s.kind === 'answer');
    if (answers.length !== 1) return fail('not as written');
    const expected = sourceText(answers[0], ctx);
    if (expected === null || value !== expected.trim())
      return fail('not as written');
  }

  // Numbers: each must be in a cited source (a cited answer, for fitted), or be
  // the result of checked math. The run date is never a free number in a value.
  const free = c.sources.flatMap((s, i) =>
    s.kind === 'run-date' || (c.derivation === 'fitted' && s.kind !== 'answer')
      ? []
      : [texts[i]],
  );
  const allowed = new Set(free.flatMap(numbersIn));
  if (c.derivation === 'math') {
    // Arithmetic never uses the run date's numbers: a span of time up to now
    // is years-since, which counts months correctly.
    const inExpression = new Set(allowed);
    const authorTexts = c.sources.flatMap((s, i) =>
      s.kind === 'fact' || s.kind === 'answer' || s.kind === 'story'
        ? [texts[i]]
        : [],
    );
    const math = checkMath(c, authorTexts, inExpression, ctx.runDate, value);
    if ('ok' in math) return math;
    allowed.add(math.result);
  }
  if (!numbersIn(value).every((n) => allowed.has(n)))
    return fail('number not in sources');

  return { ok: true, value };
}
