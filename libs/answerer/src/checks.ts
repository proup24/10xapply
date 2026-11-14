import {
  addOffset,
  evaluate,
  expressionNumbers,
  hasAmount,
  MathError,
  MONTHS,
  numbersIn,
  optionContains,
  parseDate,
  statesOffset,
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

/** A job-post quote shorter than this is too loose to trace: it fails as unknown. */
const MIN_QUOTE_WORDS = 3;

/** The author's own entries: the only sources whose numbers may appear in a value. */
const isAuthorSource = (s: Source): boolean =>
  s.kind === 'field' ||
  s.kind === 'fact' ||
  s.kind === 'answer' ||
  s.kind === 'story';

/** Regex source matching any name (full or three-letter) of the month. */
function monthNames(month: number): string {
  return Object.entries(MONTHS)
    .filter(([, n]) => n === month)
    .map(([name]) => name)
    .join('|');
}

const ANY_MONTH = Object.keys(MONTHS).join('|');

/** Regex source matching the month as a number, with or without a leading 0. */
const monthDigits = (month: number): string => `0?${month}`;

const ANY_MONTH_DIGITS = '0?[1-9]|1[0-2]';

/**
 * True when the text holds the year with one of the months next to it: by
 * name (`<month> <year>`, `<month>, <year>`) or by number (`03/2021`,
 * `3/2021`, `2021-03`, `2021/03`).
 */
function hasMonthYear(
  text: string,
  names: string,
  digits: string,
  year: number,
): boolean {
  return [
    String.raw`\b(?:${names})\b,?\s+${year}\b`,
    String.raw`\b(?:${digits})/${year}\b`,
    String.raw`\b${year}[-/](?:${digits})\b`,
  ].some((form) => new RegExp(form, 'i').test(text));
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

/** Validates the candidate's math and computes its result. The caller compares the value. */
function checkMath(
  c: AnswerCandidate,
  authorTexts: string[],
  allowed: Set<number>,
  runDate: string,
): CheckResult | { result: number } {
  const spec = c.math;
  if (!spec) return fail('math missing');
  // A date offset gives a date, so it only answers a date question.
  if (spec.kind === 'date-offset') return fail('math does not match');
  try {
    let result: number;
    if (spec.kind === 'years-since') {
      // The year must come from the author's own entries, never the job post or the run date.
      if (!authorTexts.some((t) => numbersIn(t).includes(spec.year))) {
        return fail('number not in sources');
      }
      if (spec.month !== undefined) {
        const names = monthNames(spec.month);
        const digits = monthDigits(spec.month);
        if (
          names === '' ||
          !authorTexts.some((t) => hasMonthYear(t, names, digits, spec.year))
        ) {
          return fail('number not in sources');
        }
      } else if (
        authorTexts.some((t) =>
          hasMonthYear(t, ANY_MONTH, ANY_MONTH_DIGITS, spec.year),
        )
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
    return { result };
  } catch (e) {
    if (e instanceof MathError) return fail('math does not match');
    throw e;
  }
}

/**
 * A date question's math: the run date plus an amount and unit that one cited
 * entry of the author's states together ("one week"). The value must be the
 * computed date.
 */
function checkDateOffset(
  c: AnswerCandidate,
  authorTexts: string[],
  runDate: string,
  value: string,
): CheckResult {
  const spec = c.math;
  if (!spec) return fail('math missing');
  if (spec.kind !== 'date-offset') return fail('math does not match');
  if (!authorTexts.some((t) => hasAmount(t, spec.amount))) {
    return fail('number not in sources');
  }
  if (!authorTexts.some((t) => statesOffset(t, spec.amount, spec.unit))) {
    return fail('math does not match');
  }
  try {
    if (value !== addOffset(runDate, spec.amount, spec.unit)) {
      return fail('math does not match');
    }
  } catch (e) {
    if (e instanceof MathError) return fail('math does not match');
    throw e;
  }
  return { ok: true, value };
}

function checkChoice(
  q: FormQuestion,
  c: AnswerCandidate,
  answerTexts: string[],
  math: () => CheckResult | { result: number },
): CheckResult {
  const computed = c.math ? math() : null;
  if (computed !== null && 'ok' in computed) return computed;
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
  // A bucket from math: the option's range must hold the computed number. An
  // option that is not a plain range is left to the verifier.
  if (computed !== null && optionContains(option, computed.result) === false) {
    return fail('math does not match');
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
  const isDate = q.type === 'date';
  if (!isChoice && !isText && !isNumber && !isFile && !isDate)
    return fail('wrong value shape');

  const wantsArray = q.type === 'checkbox-group';
  if (Array.isArray(c.value) !== wantsArray) return fail('wrong value shape');

  // Every source exists.
  const texts: string[] = [];
  for (const source of c.sources) {
    const text = sourceText(source, ctx);
    if (text === null) return fail('unknown source');
    if (
      source.kind === 'job-post' &&
      text.split(' ').length < MIN_QUOTE_WORDS
    ) {
      return fail('unknown source');
    }
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
  const authorTexts = c.sources.flatMap((s, i) =>
    s.kind === 'fact' || s.kind === 'answer' || s.kind === 'story'
      ? [texts[i]]
      : [],
  );
  // Numbers from the author's own entries, the only ones math may use.
  const authorNumbers = new Set(
    c.sources.flatMap((s, i) => (isAuthorSource(s) ? numbersIn(texts[i]) : [])),
  );
  const math = () => checkMath(c, authorTexts, authorNumbers, ctx.runDate);
  if (isChoice) return checkChoice(q, c, answerTexts, math);

  // Text and number values.
  const raw = c.value as string;
  const value = raw.trim();
  if (/[{}]/.test(value)) return fail('unfilled placeholder');
  if (value === '')
    return q.required ? fail('empty required answer') : { ok: true, value };
  if (q.maxLength !== undefined && value.length > q.maxLength)
    return fail('too long');
  if (isNumber && !NUMBER_ONLY.test(value)) return fail('not a number');
  // A date's canonical value is YYYY-MM-DD; the runner formats it for the field.
  if (isDate && parseDate(value) === null) return fail('not a date');
  if (isDate && c.derivation === 'math') {
    return checkDateOffset(c, authorTexts, ctx.runDate, value);
  }

  if (c.derivation === 'as-written') {
    const answers = c.sources.filter((s: Source) => s.kind === 'answer');
    if (answers.length !== 1) return fail('not as written');
    const expected = sourceText(answers[0], ctx);
    if (expected === null || value !== expected.trim())
      return fail('not as written');
  }
  // Fitted text is only a known answer's number with its unit stripped. Any
  // other text from an answer is as-written or composed.
  if (isText && c.derivation === 'fitted') {
    if (
      answerTexts.length !== 1 ||
      !NUMBER_ONLY.test(value) ||
      !numbersIn(answerTexts[0]).includes(Number(value))
    ) {
      return fail('not as written');
    }
  }

  // Numbers: each must be in a cited author source (a cited answer, for
  // fitted), or be the result of checked math. The job post never backs a
  // number about the author, and the run date is never a free number.
  const free = c.sources.flatMap((s, i) =>
    isAuthorSource(s) && (c.derivation !== 'fitted' || s.kind === 'answer')
      ? [texts[i]]
      : [],
  );
  const allowed = new Set(free.flatMap(numbersIn));
  if (c.derivation === 'math') {
    // Arithmetic uses author numbers only. Never the job post's, and never the
    // run date's: a span of time up to now is years-since, which counts months.
    const computed = math();
    if ('ok' in computed) return computed;
    if (!WHOLE_NUMBER.test(value) || Number(value) !== computed.result) {
      return fail('math does not match');
    }
    allowed.add(computed.result);
  }
  if (!numbersIn(value).every((n) => allowed.has(n)))
    return fail('number not in sources');

  return { ok: true, value };
}
