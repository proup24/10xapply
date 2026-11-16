import type { Locator } from 'patchright-core';
import type { AnswerValue } from '@xapply/answerer';
import type { Pace, TargetOptions } from '../pace/pace.js';
import type { ReadField } from '../linkedin/types.js';
import { toTypeable } from './typeable.js';

/** Reads through Patchright locators; no scripts in the page. */
export interface FillPage {
  locator(selector: string): Locator;
  value(selector: string): Promise<string>; // Patchright inputValue
  checked(selector: string): Promise<boolean>;
  selectedText(selector: string): Promise<string | null>; // <select>'s chosen option text
  /**
   * Waits for the typeahead list to show an option `suggestionMatches`
   * accepts for `pick` (the first, in list order), or null after 5 s. The
   * string is that option's selector, for `pace.click`.
   */
  suggestion(
    listSelector: string,
    pick: SuggestionPick,
  ): Promise<string | null>;
  /** True when any input `selector` matches is checked; throws when none matches. */
  anyChecked(selector: string): Promise<boolean>;
  /**
   * The checked state of the `index`th input `selector` matches; throws
   * unless it still matches exactly `count` (the page changed under it).
   */
  checkedAt(selector: string, index: number, count: number): Promise<boolean>;
  /**
   * The id of the `index`th input `selector` matches; throws unless it
   * still matches exactly `count`.
   */
  idAt(selector: string, index: number, count: number): Promise<string | null>;
}

/**
 * Which typeahead suggestion to click: the one reading `text`, or, with a
 * `country` (the bank's city typed), the first that starts with the city
 * and holds the country as one of its comma-separated parts.
 */
export interface SuggestionPick {
  text: string;
  country?: string;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** True when the option's text fits the pick. Spaces and case are ignored. */
export function suggestionMatches(
  option: string,
  pick: SuggestionPick,
): boolean {
  const text = squash(option);
  const want = squash(pick.text);
  if (pick.country === undefined) return text === want;
  const country = squash(pick.country);
  if (want === '' || country === '') return false;
  // The city is the whole first comma-separated part ("Tangier", not
  // "Tangier Med"), and the country one whole part ("Morocco", not
  // "Morocco Street").
  const parts = text.split(',').map((part) => part.trim());
  if (parts[0] !== want) return false;
  return parts.some((part) => part === country);
}

/**
 * The page no longer matches what a read expects: nothing matches, or the
 * count of matches changed. Thrown by the page adapter; a soft failure.
 */
export class ReadMismatchError extends Error {
  constructor(message: string) {
    super(`fill read: ${message}`);
    this.name = 'ReadMismatchError';
  }
}

/** A page read that timed out or found nothing: the field did not take. */
class ReadFailed extends Error {
  constructor() {
    super('a page read failed');
    this.name = 'ReadFailed';
  }
}

/** A Patchright timeout or the adapter's own mismatch: a soft read failure. */
const isSoft = (e: unknown) =>
  e instanceof ReadMismatchError ||
  (e instanceof Error && e.name === 'TimeoutError');

/**
 * `page` with soft read failures turned into ReadFailed. Anything else (a
 * closed target, the bridge going away) is thrown as it is, so the run
 * ends on it.
 */
function guardReads(page: FillPage): FillPage {
  const guard =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> =>
      f(...a).catch((e: unknown) => {
        throw isSoft(e) ? new ReadFailed() : e;
      });
  return {
    locator: (sel) => page.locator(sel),
    value: guard((sel) => page.value(sel)),
    checked: guard((sel) => page.checked(sel)),
    selectedText: guard((sel) => page.selectedText(sel)),
    suggestion: guard((list, pick) => page.suggestion(list, pick)),
    anyChecked: guard((sel) => page.anyChecked(sel)),
    checkedAt: guard((sel, i, n) => page.checkedAt(sel, i, n)),
    idAt: guard((sel, i, n) => page.idAt(sel, i, n)),
  };
}

/** `pace` that notes when an action that can change the page has run. */
function trackActs(pace: Pace, acted: { yes: boolean }): Pace {
  const mark =
    <A extends unknown[]>(f: (...a: A) => Promise<void>) =>
    (...a: A): Promise<void> => {
      acted.yes = true;
      return f(...a);
    };
  return {
    ...pace,
    click: mark((t, o) => pace.click(t, o)),
    type: mark((f, text, o) => pace.type(f, text, o)),
    clear: mark((f, o) => pace.clear(f, o)),
    pick: mark((c, i, o) => pace.pick(c, i, o)),
    upload: mark((b, p, o) => pace.upload(b, p, o)),
  };
}

const TEXT_LIKE = new Set(['text', 'number', 'textarea', 'typeahead']);
export interface Resume {
  fileName: string;
  windowsPath: string;
}
/**
 * Why a fill failed. `not-taken`: after a clear the field was not empty,
 * after typing it did not hold the typed text, or a page read timed out or
 * found nothing before anything was done. `unverified`: something was
 * pressed, typed or uploaded, and then a read failed or the check after it
 * did not hold, so the field may be partly answered: never left blank.
 */
export type FillProblem =
  | 'not-typeable'
  | 'not-taken'
  | 'no-option'
  | 'no-suggestion'
  | 'no-resume'
  | 'unverified';
export type FillResult =
  | { ok: true; changedFromLinkedIn: boolean }
  | { ok: false; reason: FillProblem };

interface Ctx {
  pace: Pace;
  page: FillPage;
  resume: Resume;
  /**
   * The selector of the visible box that clips the fields (the form's
   * `<dialog>`), passed to every pace call as `within`.
   */
  within?: string;
  /**
   * The bank's city and country. A typeahead answered with the city picks
   * a suggestion that starts with it and holds the country.
   */
  place?: { city: string; country: string };
}

/** The pace options for a call: `within` as a locator, when the ctx has one. */
const opts = ({ page, within }: Ctx): TargetOptions =>
  within === undefined ? {} : { within: page.locator(within) };

const done = (changedFromLinkedIn: boolean): FillResult => ({
  ok: true,
  changedFromLinkedIn,
});
const fail = (reason: FillProblem): FillResult => ({ ok: false, reason });

/** Clears the field, then reads it back: true when it is empty. */
async function clearAndCheck(ctx: Ctx, selector: string): Promise<boolean> {
  const { pace, page } = ctx;
  await pace.clear(page.locator(selector), opts(ctx));
  return (await page.value(selector)) === '';
}

/**
 * Types the text, then reads it back: true when the field holds it. When it
 * doesn't, the field is cleared, so no part-typed text is left behind.
 */
async function typeAndCheck(
  ctx: Ctx,
  selector: string,
  text: string,
): Promise<boolean> {
  const { pace, page } = ctx;
  const field = page.locator(selector);
  await pace.type(field, text, opts(ctx));
  if (sameValue(await page.value(selector), text)) return true;
  await pace.clear(field, opts(ctx));
  return false;
}

const PHONE_LIKE = /^[\d\s().+-]+$/;

/**
 * Equal as typed, or both phone-shaped (at least 7 digits, with spaces, brackets,
 * dots, dashes, plus) and equal once spaces, brackets, dots and dashes are removed. The
 * digits and the plus stay strict. Anything else must match exactly.
 */
function sameValue(a: string, b: string): boolean {
  if (a === b) return true;
  // At least 7 digits each: shorter values (1.5, 3-5) stay exact.
  const phoneLike = (v: string) =>
    PHONE_LIKE.test(v) && (v.match(/\d/g)?.length ?? 0) >= 7;
  if (!phoneLike(a) || !phoneLike(b)) return false;
  const strip = (v: string) => v.replace(/[\s().-]/g, '');
  return strip(a) === strip(b);
}

/** Several picks for a text field read as the bank saves them. */
const asText = (v: AnswerValue) => (Array.isArray(v) ? v.join('; ') : v);
/** One option's text, or null when the answer names several. */
const asOne = (v: AnswerValue) =>
  Array.isArray(v) ? (v.length === 1 ? (v[0] ?? null) : null) : v;
const asMany = (v: AnswerValue) => (Array.isArray(v) ? v : [v]);

/**
 * Fills one field with its answer through pace, at human speed. A field
 * already holding the answer gets a glance (never a typeahead). Every
 * refusal comes before any pace call, except a typeahead with no suggestion
 * (found after typing, and the field cleared again), a radio the click did
 * not check, and text the field did not take (`not-taken`, read back after
 * each clear and each typing).
 */
export async function fillField(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const acted = { yes: false };
  const inner: Ctx = {
    ...ctx,
    page: guardReads(ctx.page),
    pace: trackActs(ctx.pace, acted),
  };
  let result: FillResult;
  let readFailed = false;
  try {
    result = await fillGuarded(f, value, inner);
  } catch (e) {
    // A read that timed out or found nothing is a failed fill, never an
    // error stop; pace refusals and other errors still propagate.
    if (!(e instanceof ReadFailed)) throw e;
    readFailed = true;
    result = fail('not-taken');
  }
  if (result.ok || !acted.yes) return result;
  if (!readFailed && result.reason !== 'no-option') return result;
  // Typed text that can't be read back is cleared, best effort.
  if (readFailed && TEXT_LIKE.has(f.question.type)) {
    try {
      await ctx.pace.clear(ctx.page.locator(f.selector), opts(ctx));
    } catch {
      // The field stays unverified either way.
    }
  }
  return fail('unverified');
}

/**
 * True while nth(i) of the stable group still carries the id read with the
 * step: the position route is only trusted while the ids are valid.
 */
async function positionHolds(
  f: ReadField,
  page: FillPage,
  i: number,
): Promise<boolean> {
  const g = f.stableGroup;
  if (!g) return true;
  return (await page.idAt(g.selector, i, g.count)) === g.ids[i];
}

async function fillGuarded(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  switch (f.question.type) {
    case 'text':
    case 'number':
    case 'textarea':
    case 'typeahead':
      return fillText(f, value, ctx);
    case 'select':
      return fillSelect(f, value, ctx);
    case 'radio':
      return fillRadio(f, value, ctx);
    case 'checkbox-group':
      return fillGroup(f, value, ctx);
    case 'checkbox':
      return fillCheckbox(f, value, ctx);
    case 'file':
      return fillResume(f, ctx);
    case 'date':
      // No date filler yet: a date is refused before anything is done.
      return fail('not-typeable');
  }
}

async function fillText(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const text = toTypeable(asText(value));
  // Only a textarea takes a line break; elsewhere Enter could send the form.
  if (text === null || (f.question.type !== 'textarea' && text.includes('\n')))
    return fail('not-typeable');
  if (f.question.type === 'typeahead') return fillTypeahead(f, text, ctx);
  const current = await page.value(f.selector);
  if (sameValue(current, text)) {
    await pace.glance(page.locator(f.selector), opts(ctx));
    return done(false);
  }
  const changed = current !== '';
  if (changed && !(await clearAndCheck(ctx, f.selector)))
    return fail('not-taken');
  if (text !== '' && !(await typeAndCheck(ctx, f.selector, text)))
    return fail('not-taken');
  return done(changed);
}

/**
 * A typeahead's committed value can't be confirmed from the input's text,
 * so it is never glanced at: any text in it is cleared, the answer typed and
 * the suggestion clicked. With no suggestion the field is cleared again, so
 * no uncommitted text is left behind.
 */
async function fillTypeahead(
  f: ReadField,
  text: string,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  // Nothing to click once typed: refuse before touching the field.
  if (!f.suggestions || text === '') return fail('no-suggestion');
  const field = page.locator(f.selector);
  const current = await page.value(f.selector);
  if (current !== '' && !(await clearAndCheck(ctx, f.selector)))
    return fail('not-taken');
  if (!(await typeAndCheck(ctx, f.selector, text))) return fail('not-taken');
  const place = ctx.place;
  const isCity =
    place !== undefined &&
    squash(place.city) !== '' &&
    squash(text) === squash(place.city);
  const option = await page.suggestion(
    f.suggestions,
    isCity ? { text, country: place.country } : { text },
  );
  if (option === null) {
    await pace.clear(field, opts(ctx));
    return fail('no-suggestion');
  }
  await pace.click(page.locator(option), opts(ctx));
  return done(current !== '' && current !== text);
}

async function fillSelect(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const options = f.question.options ?? [];
  const answer = asOne(value);
  // Two options read the same: the text can't say which one is meant.
  const repeated = new Set((f.repeatedOptions ?? []).map(squash));
  if (answer !== null && repeated.has(squash(answer))) return fail('no-option');
  const index = answer === null ? -1 : options.indexOf(answer);
  if (index < 0) return fail('no-option');
  const field = page.locator(f.selector);
  const current = await page.selectedText(f.selector);
  if (current === answer) {
    await pace.glance(field, opts(ctx));
    return done(false);
  }
  await pace.pick(field, f.pageIndexes?.[index] ?? index, opts(ctx));
  // A placeholder ("Select an option") is not one of the options, so it is
  // not LinkedIn's choice.
  return done(current !== null && options.includes(current));
}

/** The checked state of each option, or null when the selectors don't match. */
async function optionStates(
  f: ReadField,
  page: FillPage,
): Promise<boolean[] | null> {
  const options = f.question.options ?? [];
  const sels = f.optionSelectors;
  if (!sels || sels.length !== options.length) return null;
  const states: boolean[] = [];
  for (let i = 0; i < sels.length; i++) {
    states.push(await stateOf(f, page, i));
  }
  return states;
}

/**
 * Option `i`'s (or a checkbox's) checked state, read live. Through the
 * reader's stable identity (shared aria-label and position) when it found
 * one, since LinkedIn's per-load ids change when it re-renders; else
 * through the id selector.
 */
function stateOf(f: ReadField, page: FillPage, i: number): Promise<boolean> {
  const g = f.stableGroup;
  if (g) return page.checkedAt(g.selector, i, g.count);
  return page.checked(f.optionSelectors?.[i] ?? f.selector);
}

async function fillRadio(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const answer = asOne(value);
  const index =
    answer === null ? -1 : (f.question.options ?? []).indexOf(answer);
  if (index < 0) return fail('no-option');
  const states = await optionStates(f, page);
  if (states === null) return fail('no-option');
  // The answer's own radio, not the nth one in page order. It is pressed
  // (or glanced at) on its label, and its state read from the input.
  const sel = f.optionSelectors?.[index];
  if (sel === undefined) return fail('no-option');
  const press = f.optionPressSelectors?.[index] ?? sel;
  if (states[index]) {
    await pace.glance(page.locator(press), opts(ctx));
    return done(false);
  }
  if (!(await positionHolds(f, page, index))) return fail('no-option');
  await pace.click(page.locator(press), opts(ctx));
  if (!(await stateOf(f, page, index))) return fail('no-option');
  return done(states.some(Boolean));
}

async function fillGroup(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const options = f.question.options ?? [];
  // An empty answer ticks nothing, which only an optional group allows.
  const wanted = asMany(value).filter((w) => w.trim() !== '');
  if (wanted.length === 0 && f.question.required) return fail('no-option');
  if (wanted.some((w) => !options.includes(w))) return fail('no-option');
  const states = await optionStates(f, page);
  if (states === null) return fail('no-option');
  const sels = f.optionSelectors ?? [];
  const want = options.map((o) => wanted.includes(o));
  const differs = want.map((w, i) => w !== states[i]);
  if (!differs.some(Boolean)) {
    await pace.glance(page.locator(f.selector), opts(ctx));
    return done(false);
  }
  // Pressed on each option's label, and each read back from its input.
  for (const [i, sel] of sels.entries()) {
    if (!differs[i]) continue;
    const press = f.optionPressSelectors?.[i] ?? sel;
    if (!(await positionHolds(f, page, i))) return fail('no-option');
    await pace.click(page.locator(press), opts(ctx));
    if ((await stateOf(f, page, i)) !== want[i]) return fail('no-option');
  }
  // Read every box back: exactly the answer's options are ticked.
  const after = await optionStates(f, page);
  if (after === null || after.some((t, i) => t !== want[i])) {
    return fail('no-option');
  }
  return done(states.some(Boolean));
}

async function fillCheckbox(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const answer = asOne(value)?.trim().toLowerCase();
  const want =
    answer === 'yes' || answer === 'true'
      ? true
      : answer === 'no' || answer === 'false'
        ? false
        : null;
  if (want === null) return fail('no-option');
  // Pressed on its label; state read from the input, live.
  const press = page.locator(f.pressSelector ?? f.selector);
  const ticked = await stateOf(f, page, 0);
  if (ticked === want) {
    await pace.glance(press, opts(ctx));
    return done(false);
  }
  if (!(await positionHolds(f, page, 0))) return fail('no-option');
  await pace.click(press, opts(ctx));
  if ((await stateOf(f, page, 0)) !== want) return fail('no-option');
  return done(ticked);
}

/**
 * A resume LinkedIn lists under the bank's file name is picked from the
 * list; otherwise the bank's file is uploaded. State is read live by file
 * name (`stateSelector`), never by the per-load ids, which change when
 * LinkedIn re-renders the list on a selection. Among same-name entries the
 * checked one is glanced at; with none checked, the first is pressed and
 * must read checked after. Another file checked means LinkedIn's choice
 * changed.
 */
async function fillResume(f: ReadField, ctx: Ctx): Promise<FillResult> {
  const { pace, page, resume } = ctx;
  const choices = f.resumeChoices ?? [];
  /** A choice's position among the choices sharing its state selector. */
  const slot = (c: (typeof choices)[number]) => {
    const peers = choices.filter((o) => o.stateSelector === c.stateSelector);
    return { index: peers.indexOf(c), count: peers.length };
  };
  const checkedOf = (c: (typeof choices)[number]) => {
    const { index, count } = slot(c);
    return page.checkedAt(c.stateSelector, index, count);
  };
  const mine = choices.filter((c) => c.fileName === resume.fileName);
  const mineStates = new Set(mine.map((c) => c.stateSelector));
  let otherChecked = false;
  for (const sel of new Set(choices.map((c) => c.stateSelector))) {
    if (mineStates.has(sel)) continue;
    if (await page.anyChecked(sel)) {
      otherChecked = true;
      break;
    }
  }
  for (const c of mine) {
    if (await checkedOf(c)) {
      await pace.glance(page.locator(c.pressSelector), opts(ctx));
      return done(false);
    }
  }
  const [first] = mine;
  if (first) {
    await pace.click(page.locator(first.pressSelector), opts(ctx));
    if (!(await checkedOf(first))) return fail('no-option');
    return done(otherChecked);
  }
  if (!resume.windowsPath) return fail('no-resume');
  await pace.upload(page.locator(f.selector), resume.windowsPath, opts(ctx));
  return done(otherChecked);
}
