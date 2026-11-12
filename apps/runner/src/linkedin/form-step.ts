import type { Document } from './dom.js';
import {
  all,
  blockText,
  clean,
  one,
  textOf,
  type El,
  type Root,
} from './el.js';
import {
  FIELD_WRAPPER,
  FOLLOW_CHECKBOX_LABEL,
  FOOTER_BUTTONS,
  FORM_ERRORS,
  FORM_HEADER,
  RESUME_FILE,
  UPLOAD_BUTTON_TEXT,
  attr,
  byComponentKey,
  byId,
} from './selectors.js';
import type { ReadField, StepRead, UnknownField } from './types.js';

type Question = ReadField['question'];

/** Input types read as one line of text. */
const TEXT_INPUTS = new Set(['text', 'email', 'tel', 'url', 'search']);
/** Input types that are not answers (buttons, or nothing shown). */
const NOT_ANSWERS = new Set(['hidden', 'button', 'submit', 'reset', 'image']);
/** Roles that take input on an element that isn't a native control. */
const INPUT_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'switch',
  'checkbox',
  'radio',
]);
/** LinkedIn's live character counter: "7/100" and "7 of 100 characters". */
const COUNTER = /^(\d+\s*\/\s*\d+|\d+ of \d+ characters?)$/i;
const SUBMIT = /submit/i;
const STAR = /\s*\*\s*$/;

/** Reads the Easy Apply form's current step. Never reads a Submit as next. */
export function readStep(doc: Document): StepRead {
  const dialog = all(doc, 'dialog').find((d) => one(d, FORM_HEADER));
  if (!dialog) return { kind: 'none' };
  const { fields, unknown } = readFields(doc, dialog);
  if (all(dialog, 'button, input[type="submit"]').some(isSubmit)) {
    return { kind: 'review', fields, unknown };
  }
  return {
    kind: 'step',
    title: readTitle(dialog),
    progress: readProgress(dialog),
    fields,
    unknown,
    next: readNext(dialog),
    errors: readErrors(dialog),
  };
}

/** Equal keys mean the step did not change. */
export function stepKey(r: StepRead): string {
  if (r.kind === 'none') return 'none';
  const keys = r.fields.map((f) => f.key).sort();
  if (r.kind === 'review') return JSON.stringify(['review', keys]);
  return JSON.stringify([r.title, r.progress, keys]);
}

const label = (el: El) => clean(el.getAttribute('aria-label') ?? '');
const isSubmit = (b: El) => SUBMIT.test(textOf(b)) || SUBMIT.test(label(b));

function readTitle(dialog: El): string | null {
  const parts = [...all(dialog, `${FORM_HEADER} h2`), ...all(dialog, 'h3')].map(
    textOf,
  );
  const title = parts.filter((p) => p !== '').join(' / ');
  return title === '' ? null : title;
}

function readProgress(dialog: El): number | null {
  const bar = one(dialog, '[role="progressbar"], progress');
  const raw = bar?.getAttribute('aria-valuenow') ?? bar?.getAttribute('value');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** "Next" or "Review" in the footer; a Submit button is never next. */
function readNext(dialog: El): Extract<StepRead, { kind: 'step' }>['next'] {
  for (const b of all(dialog, FOOTER_BUTTONS)) {
    if (isSubmit(b)) continue;
    const name = (textOf(b) || label(b)).toLowerCase();
    if (name === 'next' || name === 'review') {
      return { selector: selectorFor(b), label: name };
    }
  }
  return null;
}

function readErrors(dialog: El): string[] {
  const texts = all(dialog, FORM_ERRORS)
    .map(textOf)
    .filter((t) => t !== '');
  return [...new Set(texts)];
}

/**
 * A selector for one element: its id, else its componentkey (kept for the
 * life of the page), else name or aria-label inside the form dialog.
 */
function selectorFor(el: El): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute('id');
  if (id) return byId(id);
  const key = el.getAttribute('componentkey');
  if (key) return byComponentKey(tag, key);
  const form = `dialog:has(${FORM_HEADER})`;
  const name = el.getAttribute('name');
  if (name) return `${form} ${tag}${attr('name', name)}`;
  const aria = el.getAttribute('aria-label');
  if (aria) return `${form} ${tag}${attr('aria-label', aria)}`;
  return `${form} ${tag}`;
}

function byIdIn(root: Root, id: string): El | null {
  return one(root, attr('id', id));
}

/** The label text and whether it ended in `*` (taken off). */
function labelOf(doc: Document, el: El): { text: string; star: boolean } {
  const id = el.getAttribute('id');
  const forLabel = id ? one(doc, `label${attr('for', id)}`) : null;
  let text = forLabel ? textOf(forLabel) : '';
  if (text === '') text = label(el);
  if (text === '') {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/);
    text = clean(
      ids
        .map((i) => (i ? byIdIn(doc, i) : null))
        .map((e) => (e ? textOf(e) : ''))
        .join(' '),
    );
  }
  return { text: text.replace(STAR, ''), star: STAR.test(text) };
}

const requiredAttr = (el: El) =>
  el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';

/** Text of the elements named by aria-describedby, without counters or errors. */
function helpOf(doc: Document, el: El): string | undefined {
  const ids = (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((i) => i !== '' && !i.startsWith('error-message'));
  const skip = (e: El) =>
    COUNTER.test(textOf(e)) ||
    e.getAttribute('role') === 'alert' ||
    (e.getAttribute('id') ?? '').startsWith('error-message');
  const text = ids
    .map((i) => byIdIn(doc, i))
    .map((e) => (e && !skip(e) ? blockText(e, skip) : ''))
    .filter((t) => t !== '')
    .join('\n');
  return text === '' ? undefined : text;
}

function maxLengthOf(el: El): number | undefined {
  const n = Number(el.getAttribute('maxlength'));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A radio or checkbox's option text: its label, else the `<p>` in its own wrapper. */
function optionText(doc: Document, input: El, group: El | null): string {
  const id = input.getAttribute('id');
  const forLabel = id ? one(doc, `label${attr('for', id)}`) : null;
  if (forLabel && textOf(forLabel) !== '') return textOf(forLabel);
  for (let box = input.parentElement; box && box !== group;) {
    if (all(box, 'input').length > 1) break;
    const p = one(box, 'p');
    if (p && textOf(p) !== '') return textOf(p);
    box = box.parentElement;
  }
  return input.getAttribute('value') ?? label(input);
}

/** Leaves out hidden inputs and the "Follow <company>…" checkbox. */
function ignored(el: El): boolean {
  if (el.tagName.toLowerCase() === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden') return true;
    if (type === 'checkbox' && FOLLOW_CHECKBOX_LABEL.test(label(el))) {
      return true;
    }
  }
  return el.closest('[hidden]') !== null;
}

function readFields(
  doc: Document,
  dialog: El,
): { fields: ReadField[]; unknown: UnknownField[] } {
  const fields: ReadField[] = [];
  const unknown: UnknownField[] = [];
  const seen = new Set<El>();
  const keys = new Set<string>();
  const hasResume = all(dialog, 'input[type="radio"]').some((r) =>
    RESUME_FILE.test(label(r)),
  );
  // Listboxes a combobox points at are its suggestions, not fields.
  const lists = new Set(
    all(dialog, '[aria-controls], [aria-owns]').flatMap((c) =>
      [c.getAttribute('aria-controls'), c.getAttribute('aria-owns')]
        .join(' ')
        .split(/\s+/)
        .filter((i) => i !== '' && i !== 'null'),
    ),
  );

  const keyOf = (el: El, anchor: El) => {
    const wrapper = anchor.closest(FIELD_WRAPPER);
    let key =
      wrapper?.getAttribute('componentkey') ??
      el.getAttribute('id') ??
      el.getAttribute('name') ??
      `field-${fields.length + 1}`;
    if (keys.has(key)) key = `${key}#${fields.length + 1}`;
    keys.add(key);
    return key;
  };
  const push = (
    el: El,
    q: Omit<Question, 'required'> & { required: boolean },
    extra: Partial<ReadField> & { anchor?: El } = {},
  ) => {
    const { anchor, ...rest } = extra;
    if (q.label === '') {
      unknown.push(unknownOf(el));
      return;
    }
    fields.push({
      key: keyOf(el, anchor ?? el),
      selector: selectorFor(el),
      question: q,
      ...rest,
    });
  };
  const simple = (
    el: El,
    type: Question['type'],
    more: Partial<Question> = {},
  ) => {
    const { text, star } = labelOf(doc, el);
    const q: Question = {
      label: text,
      type,
      required: star || requiredAttr(el),
      ...more,
    };
    const help = helpOf(doc, el);
    if (help !== undefined) q.helpText = help;
    const max = maxLengthOf(el);
    if (max !== undefined) q.maxLength = max;
    return q;
  };

  const controls = all(
    dialog,
    'input, select, textarea, [contenteditable], [role]',
  );
  for (const el of controls) {
    if (seen.has(el) || ignored(el)) continue;
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (tag === 'select') {
      readSelect(el);
    } else if (tag === 'textarea') {
      push(el, simple(el, 'textarea'));
    } else if (tag === 'input') {
      if (NOT_ANSWERS.has(type)) continue;
      if (type === 'radio') readRadios(el);
      else if (type === 'checkbox') readCheckboxes(el);
      else if (type === 'file') {
        if (!hasResume) push(el, simple(el, 'file'));
      } else if (type === 'number') push(el, simple(el, 'number'));
      else if (TEXT_INPUTS.has(type)) readText(el);
      else unknown.push(unknownOf(el));
    } else if (
      (role !== null && INPUT_ROLES.has(role)) ||
      (el.hasAttribute('contenteditable') &&
        el.getAttribute('contenteditable') !== 'false')
    ) {
      if (role === 'listbox' && lists.has(el.getAttribute('id') ?? ''))
        continue;
      unknown.push(unknownOf(el));
    }
  }
  return { fields, unknown };

  function readText(el: El) {
    const role = el.getAttribute('role');
    const auto = el.getAttribute('aria-autocomplete');
    if (role === 'combobox' || auto === 'list' || auto === 'both') {
      const list = [
        el.getAttribute('aria-controls'),
        el.getAttribute('aria-owns'),
      ]
        .join(' ')
        .split(/\s+/)
        .find((i) => i !== '' && i !== 'null');
      push(
        el,
        simple(el, 'typeahead'),
        list ? { suggestions: byId(list) } : {},
      );
      return;
    }
    const mode = el.getAttribute('inputmode');
    const numeric = mode === 'numeric' || mode === 'decimal';
    push(el, simple(el, numeric ? 'number' : 'text'));
  }

  function readSelect(el: El) {
    const options: string[] = [];
    const pageIndexes: number[] = [];
    all(el, 'option').forEach((o, i) => {
      const text = textOf(o);
      const value = o.getAttribute('value');
      if (value === '' || text === '' || /^select an option$/i.test(text))
        return;
      options.push(text);
      pageIndexes.push(i);
    });
    push(el, simple(el, 'select', { options }), { pageIndexes });
  }

  function readRadios(el: El) {
    const group = el.closest('fieldset') ?? el.closest('[role="radiogroup"]');
    const name = el.getAttribute('name');
    const radios = group
      ? all(group, 'input[type="radio"]')
      : name
        ? all(dialog, `input[type="radio"]${attr('name', name)}`)
        : [el];
    for (const r of radios) seen.add(r);
    const labels = [...new Set(radios.map(label))];
    const required =
      radios.some(requiredAttr) || (group !== null && requiredAttr(group));
    if (radios.some((r) => RESUME_FILE.test(label(r)))) {
      readResume(el, group, radios, required);
      return;
    }
    let text = labels.length === 1 ? (labels[0] ?? '') : '';
    if (text === '' && group) text = groupLabel(group);
    const wrapper = (group ?? el).closest(FIELD_WRAPPER);
    const optionSelectors = radios.map(selectorFor);
    push(
      wrapper ?? el,
      {
        label: text.replace(STAR, ''),
        type: 'radio',
        required: required || STAR.test(text),
        options: radios.map((r) => optionText(doc, r, group)),
      },
      { anchor: group ?? el, optionSelectors },
    );
  }

  /**
   * LinkedIn's resume list: radios named by file. The field aims at the
   * "Upload resume" button, because pace.upload clicks the button that opens
   * the chooser; a file input is the fallback, then the first resume.
   */
  function readResume(
    el: El,
    group: El | null,
    radios: El[],
    required: boolean,
  ) {
    const files = all(dialog, 'input[type="file"]');
    for (const f of files) seen.add(f);
    const resumeChoices = radios.map((r) => ({
      fileName: label(r),
      selector: selectorFor(r),
      selected: false,
    }));
    const upload = all(dialog, 'button').find((b) =>
      UPLOAD_BUTTON_TEXT.test(textOf(b) || label(b)),
    );
    const target = upload ?? files[0] ?? el;
    fields.push({
      key: keyOf(radios[0] ?? el, group ?? el),
      selector: selectorFor(target),
      question: { label: 'Resume', type: 'file', required },
      resumeChoices,
    });
  }

  function readCheckboxes(el: El) {
    const group = el.closest('fieldset');
    const boxes = group
      ? all(group, 'input[type="checkbox"]').filter((b) => !ignored(b))
      : [el];
    if (boxes.length < 2) {
      push(el, simple(el, 'checkbox'));
      return;
    }
    for (const b of boxes) seen.add(b);
    const text = group ? groupLabel(group) : '';
    const optionSelectors = boxes.map(selectorFor);
    push(
      group?.closest(FIELD_WRAPPER) ?? el,
      {
        label: text.replace(STAR, ''),
        type: 'checkbox-group',
        required:
          STAR.test(text) ||
          boxes.some(requiredAttr) ||
          (group !== null && requiredAttr(group)),
        options: boxes.map((b) => optionText(doc, b, group)),
      },
      { anchor: group ?? el, optionSelectors },
    );
  }

  function groupLabel(group: El): string {
    const legend = one(group, 'legend');
    return (legend ? textOf(legend) : '') || label(group);
  }
}

function unknownOf(el: El): UnknownField {
  const tag = el.tagName.toLowerCase();
  return {
    tag,
    role: el.getAttribute('role'),
    inputType:
      tag === 'input'
        ? (el.getAttribute('type') ?? 'text').toLowerCase()
        : null,
  };
}
