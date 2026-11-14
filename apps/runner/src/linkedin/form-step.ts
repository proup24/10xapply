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
  FOLLOW_CHECKBOX,
  FOLLOW_CHECKBOX_LABEL,
  FOOTER_BUTTONS,
  FORM_ERRORS,
  FORM_HEADER,
  RESUME_FILE,
  UPLOAD_RESUME_TEXT,
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
/** The counter's total is the field's limit. */
const COUNTER_LIMIT = /(\d+)\s+of\s+(\d+)\s+characters?/i;
/** Attributes a selector may use after the id, in order of preference. */
const SELECTOR_ATTRS = [
  'componentkey',
  'data-testid',
  'name',
  'aria-label',
  'aria-describedby',
];
const SUBMIT = /submit/i;
const STAR = /\s*\*\s*$/;

/** Reads the Easy Apply form's current step. Never reads a Submit as next. */
export function readStep(doc: Document): StepRead {
  const dialog = all(doc, 'dialog').find((d) => one(d, FORM_HEADER));
  if (!dialog) return { kind: 'none' };
  const { fields, unknown } = readFields(doc, dialog);
  const submits = all(dialog, 'button, input[type="submit"]').filter(isSubmit);
  if (submits.length > 0) {
    const [only] = submits;
    return {
      kind: 'review',
      fields,
      unknown,
      submit: submits.length === 1 && only ? selectorFor(doc, only) : null,
      follow: readFollow(doc, dialog),
    };
  }
  return {
    kind: 'step',
    title: readTitle(dialog),
    progress: readProgress(dialog),
    fields,
    unknown,
    next: readNext(doc, dialog),
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
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Next" or "Review" in the footer; a Submit button is never next. A button
 * no selector picks out alone is no next either.
 */
function readNext(
  doc: Document,
  dialog: El,
): Extract<StepRead, { kind: 'step' }>['next'] {
  for (const b of all(dialog, FOOTER_BUTTONS)) {
    if (isSubmit(b)) continue;
    const name = (textOf(b) || label(b)).toLowerCase();
    if (name === 'next' || name === 'review') {
      const selector = selectorFor(doc, b);
      return selector === null ? null : { selector, label: name };
    }
  }
  return null;
}

/**
 * The review page's "Follow <company>" checkbox: `box` reads its state,
 * `press` is where a person clicks (its one `label[for]`, else the box).
 * Null when the form has none, or when the selector doesn't pick out
 * exactly one box inside this form, so nothing is pressed on a guess.
 */
function readFollow(
  doc: Document,
  dialog: El,
): Extract<StepRead, { kind: 'review' }>['follow'] {
  const boxes = all(doc, FOLLOW_CHECKBOX);
  const [box] = boxes;
  if (boxes.length !== 1 || !box || box.closest('dialog') !== dialog) {
    return null;
  }
  return {
    box: FOLLOW_CHECKBOX,
    press: pressSelectorFor(doc, box, FOLLOW_CHECKBOX),
  };
}

function readErrors(dialog: El): string[] {
  const texts = all(dialog, FORM_ERRORS)
    .map(textOf)
    .filter((t) => t !== '');
  return [...new Set(texts)];
}

/**
 * Where to press a radio or checkbox: its `label[for="<id>"]` when exactly one matches
 * on the page, else `fallback` (the input's own selector).
 */
export function pressSelectorFor(
  doc: Document,
  el: El,
  fallback: string,
): string {
  const id = el.getAttribute('id');
  if (!id) return fallback;
  const sel = `label${attr('for', id)}`;
  return all(doc, sel).length === 1 ? sel : fallback;
}

/**
 * The inputs by their shared `aria-label` (which LinkedIn keeps when it
 * re-renders, unlike the React ids): only when every input has the same
 * one, each has an id, and the selector matches exactly these inputs, in
 * this order.
 */
export function stableGroupFor(
  doc: Document,
  inputs: El[],
): { selector: string; count: number; ids: string[] } | undefined {
  const [first] = inputs;
  const aria = first?.getAttribute('aria-label') ?? '';
  const type = first?.getAttribute('type') ?? '';
  if (!first || aria === '' || type === '') return undefined;
  if (inputs.some((i) => i.getAttribute('aria-label') !== aria)) {
    return undefined;
  }
  // Each input's id at read time, for the position check before a press.
  const ids = inputs.map((i) => i.getAttribute('id') ?? '');
  if (ids.includes('')) return undefined;
  const selector = `input${attr('type', type)}${attr('aria-label', aria)}`;
  const found = all(doc, selector);
  const same =
    found.length === inputs.length && found.every((f, i) => f === inputs[i]);
  return same ? { selector, count: inputs.length, ids } : undefined;
}

/**
 * A selector that matches `el` and nothing else on the page: its id, else
 * its componentkey (kept for the life of the page), else a data-testid,
 * name, aria-label or aria-describedby. Null when none is unique, so the
 * control is never aimed at through an ambiguous selector.
 */
export function selectorFor(doc: Document, el: El): string | null {
  const tag = el.tagName.toLowerCase();
  const candidates: string[] = [];
  const id = el.getAttribute('id');
  if (id) candidates.push(byId(id));
  for (const name of SELECTOR_ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    candidates.push(
      name === 'componentkey'
        ? byComponentKey(tag, value)
        : `${tag}${attr(name, value)}`,
    );
  }
  return candidates.find((s) => all(doc, s).length === 1) ?? null;
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

/** The elements named by aria-describedby, leaving out error placeholders. */
function describedBy(doc: Document, el: El): El[] {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((i) => i !== '' && !i.startsWith('error-message'))
    .map((i) => byIdIn(doc, i))
    .filter((e): e is El => e !== null);
}

/** Text of the elements named by aria-describedby, without counters or errors. */
function helpOf(doc: Document, el: El): string | undefined {
  const skip = (e: El) =>
    COUNTER.test(textOf(e)) ||
    e.getAttribute('role') === 'alert' ||
    (e.getAttribute('id') ?? '').startsWith('error-message');
  const text = describedBy(doc, el)
    .map((e) => (skip(e) ? '' : blockText(e, skip)))
    .filter((t) => t !== '')
    .join('\n');
  return text === '' ? undefined : text;
}

/** The maxlength attribute, else the total of LinkedIn's live counter. */
function maxLengthOf(doc: Document, el: El): number | undefined {
  const n = Number(el.getAttribute('maxlength'));
  if (Number.isInteger(n) && n > 0) return n;
  for (const e of describedBy(doc, el)) {
    const m = COUNTER_LIMIT.exec(textOf(e));
    if (m) return Number(m[2]);
  }
  return undefined;
}

/**
 * A radio or checkbox's option text: its label, else the first `<p>` in its
 * own option wrapper (an ancestor holding no other input). Never the
 * aria-label, which on LinkedIn's radios is the question. '' when not found.
 */
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
  return '';
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

/** The ancestors of `el`, nearest first, up to and including `top`. */
function ancestors(el: El, top: El): El[] {
  const out: El[] = [];
  for (let a = el.parentElement; a; a = a.parentElement) {
    out.push(a);
    if (a === top) break;
  }
  return out;
}

/** True when the inputs of `type` under `box` are exactly `members`. */
function holdsOnly(box: El, type: string, members: El[]): boolean {
  const inside = all(box, `input[type="${type}"]`).filter((i) => !ignored(i));
  return (
    inside.length === members.length && members.every((m) => inside.includes(m))
  );
}

const nameOf = (el: El) => el.getAttribute('name') ?? '';

/**
 * The resume group's own section: the nearest ancestor of its radio group
 * that also holds an "Upload resume" button, with that button. Without one,
 * the section is the group and there is no button.
 */
function resumeSection(group: El, dialog: El): { box: El; upload: El | null } {
  for (const box of [group, ...ancestors(group, dialog)]) {
    const upload = all(box, 'button').find((b) =>
      UPLOAD_RESUME_TEXT.test(textOf(b) || label(b)),
    );
    if (upload) return { box, upload };
    if (box === dialog) break;
  }
  return { box: group, upload: null };
}

/**
 * The file inputs that belong to a resume section: inside it, and with no
 * label of their own other than one naming a resume or CV.
 */
function resumeFiles(doc: Document, box: El): El[] {
  return all(box, 'input[type="file"]').filter((f) => {
    const { text } = labelOf(doc, f);
    return text === '' || /resume|\bcv\b/i.test(text);
  });
}

function readFields(
  doc: Document,
  dialog: El,
): { fields: ReadField[]; unknown: UnknownField[] } {
  const fields: ReadField[] = [];
  const unknown: UnknownField[] = [];
  const seen = new Set<El>();
  const keys = new Set<string>();
  // Listboxes a combobox points at are its suggestions, not fields.
  const lists = new Set(
    all(dialog, '[aria-controls], [aria-owns]').flatMap((c) =>
      [c.getAttribute('aria-controls'), c.getAttribute('aria-owns')]
        .join(' ')
        .split(/\s+/)
        .filter((i) => i !== '' && i !== 'null'),
    ),
  );
  // File inputs of a resume section belong to the resume field, wherever
  // they come in page order.
  const ownedFiles = new Set<El>();
  const resumeGroups = new Set<El>();
  for (const r of all(dialog, 'input[type="radio"]')) {
    if (!RESUME_FILE.test(label(r))) continue;
    const group = radioContainer(r) ?? r;
    if (resumeGroups.has(group)) continue;
    resumeGroups.add(group);
    for (const f of resumeFiles(doc, resumeSection(group, dialog).box)) {
      ownedFiles.add(f);
    }
  }

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
  /**
   * Adds a field aimed at `target`, or sends `el` to unknown when the field
   * can't be answered or acted on safely: no label, an empty option, two
   * options that read the same, or a control (or option) no selector picks
   * out alone.
   */
  const push = (
    el: El,
    target: El | null,
    q: Question,
    extra: Omit<Partial<ReadField>, 'optionSelectors'> & {
      anchor?: El;
      options?: El[];
    } = {},
  ) => {
    const { anchor, options, ...rest } = extra;
    const selector = target ? selectorFor(doc, target) : null;
    const optionSelectors = options?.map((o) => selectorFor(doc, o));
    if (
      q.label === '' ||
      selector === null ||
      (q.options?.includes('') ?? false) ||
      repeats(q.options ?? []) ||
      (optionSelectors?.includes(null) ?? false)
    ) {
      unknown.push(unknownOf(doc, el));
      return;
    }
    const field: ReadField = {
      key: keyOf(el, anchor ?? el),
      selector,
      question: q,
      ...rest,
    };
    if (optionSelectors) {
      const sels = optionSelectors as string[];
      field.optionSelectors = sels;
      if ((q.type === 'radio' || q.type === 'checkbox-group') && options) {
        field.optionPressSelectors = options.map((o, i) =>
          pressSelectorFor(doc, o, sels[i] ?? ''),
        );
      }
    }
    if (q.type === 'checkbox' && target) {
      field.pressSelector = pressSelectorFor(doc, target, selector);
      const stable = stableGroupFor(doc, [target]);
      if (stable) field.stableGroup = stable;
    }
    if ((q.type === 'radio' || q.type === 'checkbox-group') && options) {
      const stable = stableGroupFor(doc, options);
      if (stable) field.stableGroup = stable;
    }
    fields.push(field);
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
    const max = maxLengthOf(doc, el);
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
      push(el, el, simple(el, 'textarea'));
    } else if (tag === 'input') {
      if (NOT_ANSWERS.has(type)) continue;
      if (type === 'radio') readRadios(el);
      else if (type === 'checkbox') readCheckboxes(el);
      else if (type === 'file') {
        if (!ownedFiles.has(el)) push(el, el, simple(el, 'file'));
      } else if (type === 'number') push(el, el, simple(el, 'number'));
      else if (TEXT_INPUTS.has(type)) readText(el);
      else unknown.push(unknownOf(doc, el));
    } else if (
      (role !== null && INPUT_ROLES.has(role)) ||
      (el.hasAttribute('contenteditable') &&
        el.getAttribute('contenteditable') !== 'false')
    ) {
      if (role === 'listbox' && lists.has(el.getAttribute('id') ?? ''))
        continue;
      unknown.push(unknownOf(doc, el));
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
        el,
        simple(el, 'typeahead'),
        list ? { suggestions: byId(list) } : {},
      );
      return;
    }
    const mode = el.getAttribute('inputmode');
    const numeric = mode === 'numeric' || mode === 'decimal';
    push(el, el, simple(el, numeric ? 'number' : 'text'));
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
    push(el, el, simple(el, 'select', { options }), { pageIndexes });
  }

  /**
   * The smallest box holding exactly `members` that a selector picks out:
   * the field wrapper, the container, or their nearest common ancestor. Null
   * when none does.
   */
  function groupBox(members: El[], container: El | null, type: string) {
    const first = members[0];
    if (!first) return null;
    const boxes = [
      first.closest(FIELD_WRAPPER),
      container,
      ...ancestors(first, dialog).filter((a) =>
        members.every((m) => a === m || ancestors(m, dialog).includes(a)),
      ),
    ];
    return (
      boxes.find(
        (b): b is El =>
          b !== null &&
          holdsOnly(b, type, members) &&
          selectorFor(doc, b) !== null,
      ) ?? null
    );
  }

  /**
   * One radio question. Radios group by name inside their fieldset or
   * radiogroup. A container with several names splits into one group per
   * name only when each name has its own shared aria-label; otherwise its
   * groups go to unknown. LinkedIn's radio questions carry no required mark
   * and are always required.
   */
  function readRadios(el: El) {
    const container = radioContainer(el);
    const name = nameOf(el);
    const inContainer = container
      ? all(container, 'input[type="radio"]')
      : null;
    const names = new Set(inContainer?.map(nameOf));
    let radios: El[];
    let text = '';
    if (inContainer && names.size <= 1) {
      radios = inContainer;
    } else if (inContainer) {
      radios = inContainer.filter((r) => nameOf(r) === name);
      const own = sharedLabel(radios);
      const others = [...names]
        .filter((n) => n !== name)
        .map((n) => sharedLabel(inContainer.filter((r) => nameOf(r) === n)));
      text = name !== '' && own !== '' && !others.includes(own) ? own : '';
      for (const r of radios) seen.add(r);
      if (text === '') {
        unknown.push(unknownOf(doc, el));
        return;
      }
    } else {
      radios = name
        ? all(dialog, `input[type="radio"]${attr('name', name)}`)
        : [el];
    }
    for (const r of radios) seen.add(r);
    if (radios.some((r) => RESUME_FILE.test(label(r)))) {
      readResume(el, container ?? el, radios);
      return;
    }
    if (text === '') text = sharedLabel(radios);
    if (text === '' && container) text = groupLabel(container);
    push(
      el,
      groupBox(radios, container, 'radio'),
      {
        label: text.replace(STAR, ''),
        type: 'radio',
        required: true,
        options: radios.map((r) => optionText(doc, r, container)),
      },
      { anchor: container ?? el, options: radios },
    );
  }

  /**
   * LinkedIn's resume list: radios named by file. The field aims at the
   * "Upload resume" button of the group's own section, because pace.upload
   * clicks the button that opens the chooser; a resume file input in that
   * section is the fallback. Without either it goes to unknown.
   */
  function readResume(el: El, group: El, radios: El[]) {
    const { box, upload } = resumeSection(group, dialog);
    const target = upload ?? resumeFiles(doc, box)[0] ?? null;
    const resumeChoices = radios.map((r) => ({
      fileName: label(r),
      selector: selectorFor(doc, r),
      el: r,
    }));
    const selector = target ? selectorFor(doc, target) : null;
    if (selector === null || resumeChoices.some((c) => c.selector === null)) {
      unknown.push(unknownOf(doc, el));
      return;
    }
    fields.push({
      key: keyOf(radios[0] ?? el, group),
      selector,
      question: { label: 'Resume', type: 'file', required: true },
      resumeChoices: resumeChoices.map((c) => {
        const selector = c.selector as string;
        const aria = c.el.getAttribute('aria-label');
        const sameName = radios.filter(
          (r) => r.getAttribute('aria-label') === aria,
        );
        return {
          fileName: c.fileName,
          selector,
          pressSelector: pressSelectorFor(doc, c.el, selector),
          stateSelector: stableGroupFor(doc, sameName)?.selector ?? selector,
        };
      }),
    });
  }

  /**
   * Checkboxes in a fieldset are one checkbox-group. A fieldset whose boxes
   * share names across more than one name mixes groups it can't label apart,
   * so each of its boxes goes to unknown.
   */
  function readCheckboxes(el: El) {
    const group = el.closest('fieldset');
    const boxes = group
      ? all(group, 'input[type="checkbox"]').filter((b) => !ignored(b))
      : [el];
    if (boxes.length < 2) {
      push(el, el, simple(el, 'checkbox'));
      return;
    }
    for (const b of boxes) seen.add(b);
    const names = boxes.map(nameOf);
    const distinct = new Set(names);
    const shared = names.length !== distinct.size;
    if (distinct.size > 1 && shared) {
      unknown.push(unknownOf(doc, el));
      return;
    }
    const text = group ? groupLabel(group) : '';
    push(
      el,
      groupBox(boxes, group, 'checkbox'),
      {
        label: text.replace(STAR, ''),
        type: 'checkbox-group',
        required:
          STAR.test(text) ||
          boxes.some(requiredAttr) ||
          (group !== null && requiredAttr(group)),
        // Never the aria-label: an empty option text sends it to unknown.
        options: boxes.map((b) => optionText(doc, b, group)),
      },
      { anchor: group ?? el, options: boxes },
    );
  }

  function groupLabel(group: El): string {
    const legend = one(group, 'legend');
    return (legend ? textOf(legend) : '') || label(group);
  }
}

/** True when two options read the same, trimmed and in any case. */
function repeats(options: string[]): boolean {
  const seen = new Set(options.map((o) => o.trim().toLowerCase()));
  return seen.size !== options.length;
}

/** The fieldset or radiogroup around a radio. */
function radioContainer(el: El): El | null {
  return el.closest('fieldset') ?? el.closest('[role="radiogroup"]');
}

/** The one aria-label all of `els` share, else ''. */
function sharedLabel(els: El[]): string {
  const labels = new Set(els.map(label));
  return labels.size === 1 ? ([...labels][0] ?? '') : '';
}

/**
 * An unknown field, with its label for the requirements check: the cleaned
 * text of its `label[for]`, else its fieldset's legend, else null. A radio
 * or checkbox's own `label[for]` is an option's text, so its legend (the
 * question) comes first.
 */
function unknownOf(doc: Document, el: El): UnknownField {
  const tag = el.tagName.toLowerCase();
  const inputType =
    tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : null;
  const id = el.getAttribute('id');
  const forLabel = id ? one(doc, `label${attr('for', id)}`) : null;
  const fieldset = el.closest('fieldset');
  const legend = fieldset ? one(fieldset, 'legend') : null;
  const own = forLabel ? textOf(forLabel) : '';
  const group = legend ? textOf(legend) : '';
  const text =
    inputType === 'radio' || inputType === 'checkbox'
      ? group || own
      : own || group;
  const label = text.replace(STAR, '');
  return {
    tag,
    role: el.getAttribute('role'),
    inputType,
    label: label === '' ? null : label,
  };
}
