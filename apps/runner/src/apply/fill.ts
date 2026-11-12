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
   * Waits for the typeahead list to show an option matching `text`, or null
   * after 5 s. The string is that option's selector, for `pace.click`.
   */
  suggestion(listSelector: string, text: string): Promise<string | null>;
}
export interface Resume {
  fileName: string;
  windowsPath: string;
}
/**
 * Why a fill failed. `not-taken`: after a clear the field was not empty, or
 * after typing it did not hold the typed text.
 */
export type FillProblem =
  'not-typeable' | 'not-taken' | 'no-option' | 'no-suggestion' | 'no-resume';
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
  const option = await page.suggestion(f.suggestions, text);
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
  for (const sel of sels) states.push(await page.checked(sel));
  return states;
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
  if (states[index]) {
    await pace.glance(page.locator(f.selector), opts(ctx));
    return done(false);
  }
  // Click the answer's own radio, not the nth one in page order, and check
  // that it took.
  const sel = f.optionSelectors?.[index];
  if (sel === undefined) return fail('no-option');
  await pace.click(page.locator(sel), opts(ctx));
  if (!(await page.checked(sel))) return fail('no-option');
  return done(states.some(Boolean));
}

async function fillGroup(
  f: ReadField,
  value: AnswerValue,
  ctx: Ctx,
): Promise<FillResult> {
  const { pace, page } = ctx;
  const options = f.question.options ?? [];
  const wanted = asMany(value);
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
  for (const [i, sel] of sels.entries()) {
    if (differs[i]) await pace.click(page.locator(sel), opts(ctx));
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
  const field = page.locator(f.selector);
  const ticked = await page.checked(f.selector);
  if (ticked === want) {
    await pace.glance(field, opts(ctx));
    return done(false);
  }
  await pace.click(field, opts(ctx));
  return done(ticked);
}

async function fillResume(f: ReadField, ctx: Ctx): Promise<FillResult> {
  const { pace, page, resume } = ctx;
  const choices = f.resumeChoices ?? [];
  const otherSelected = (skip?: string) =>
    choices.some((c) => c.selected && c.selector !== skip);
  const same = choices.find((c) => c.fileName === resume.fileName);
  if (same) {
    const target = page.locator(same.selector);
    if (same.selected) {
      await pace.glance(target, opts(ctx));
      return done(false);
    }
    await pace.click(target, opts(ctx));
    return done(otherSelected(same.selector));
  }
  if (!resume.windowsPath) return fail('no-resume');
  await pace.upload(page.locator(f.selector), resume.windowsPath, opts(ctx));
  return done(otherSelected());
}
