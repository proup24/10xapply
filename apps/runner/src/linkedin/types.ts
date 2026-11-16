import type { FieldType, FormQuestion } from '@xapply/answerer';

export interface JobRead {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  /** Selector for the Easy Apply button, or null when the job isn't Easy Apply. */
  easyApply: string | null;
  applied: boolean;
}

export interface ReadField {
  /** Stable within a step across re-reads; used to tell new fields from old. */
  key: string;
  /** CSS selector for a Patchright locator (pierces open shadow roots). */
  selector: string;
  /** FormQuestion minus id; the walker numbers it. */
  question: Omit<FormQuestion, 'id'> & { type: FieldType };
  /** radio, checkbox-group: one selector per option, in `question.options` order. */
  optionSelectors?: string[];
  /**
   * radio, checkbox-group: where to press each option, in the same order.
   * LinkedIn's radio and checkbox inputs are visually hidden; the visible
   * control is the empty `label[for]` after each one. The input itself
   * when no label picks it out alone. State is still read from
   * `optionSelectors`.
   */
  optionPressSelectors?: string[];
  /**
   * checkbox: where to press it (its one `label[for]`, else the input).
   * State is read from `selector`.
   */
  pressSelector?: string;
  /**
   * radio, checkbox-group, checkbox: the inputs by an identity LinkedIn
   * keeps when it re-renders (the shared `aria-label`, else for a radio or
   * checkbox-group the componentkey of the question's field wrapper; not
   * the per-load React ids). `selector` matched exactly `count` inputs at read time, in
   * option order, so option i is its nth(i). State is read through this
   * when present, before and after a press. `ids` are the inputs' ids at
   * read time: before a press, nth(i) must still carry ids[i].
   */
  stableGroup?: { selector: string; count: number; ids: string[] };
  /**
   * select: the page's own option index of each `question.options` entry,
   * so a placeholder left out of `options` doesn't shift picks.
   */
  pageIndexes?: number[];
  /**
   * select: the option texts that appear more than once (trimmed, any
   * case), each once, as the page first spells it. Fill never picks one:
   * two options read the same, so the text can't say which is meant.
   */
  repeatedOptions?: string[];
  /**
   * file: resumes LinkedIn already lists. `selector` is the radio input by
   * its per-load id; `pressSelector` is where to press it (its
   * `label[for]`, else the input). `stateSelector` reads its state by file
   * name (`input[type="radio"][aria-label=…]`), which survives the list's
   * re-render: it matches exactly the choices that share it, in list order
   * (the id selector when the radio has no aria-label). The captures carry
   * no checked state, so none is read here.
   */
  resumeChoices?: {
    fileName: string;
    selector: string;
    pressSelector: string;
    stateSelector: string;
  }[];
  /** typeahead: where suggestions appear once typed. */
  suggestions?: string;
}
export interface UnknownField {
  tag: string;
  role: string | null;
  inputType: string | null;
  /**
   * The cleaned text of its `label[for]`, else its fieldset's legend, else
   * null. Sent to the requirements check; never in a redacted output.
   */
  label: string | null;
}
export type StepRead =
  | {
      kind: 'step';
      title: string | null;
      progress: number | null;
      fields: ReadField[];
      unknown: UnknownField[];
      next: { selector: string; label: 'next' | 'review' } | null;
      errors: string[];
    }
  /**
   * A Submit button is showing. A one-page form still has its question
   * fields here, to fill before stopping; a normal review page has none.
   */
  | {
      kind: 'review';
      fields: ReadField[];
      unknown: UnknownField[];
      /** Selector for the one Submit button in the form, or null. */
      submit: string | null;
      /**
       * LinkedIn's "Follow <company> to stay up to date with their page"
       * checkbox, ticked by default when present; the runner unticks it.
       * `box` is the one checkbox input inside the form dialog (its state
       * is read live: the captures hold none); `press` is where a person
       * clicks it (its `label[for]` inside the form, else the input). Null
       * when absent; 'unclear' when one is seen but no selector picks out
       * exactly one inside the form (the run then stops).
       */
      follow: { box: string; press: string } | 'unclear' | null;
    }
  | { kind: 'none' }; // no Easy Apply dialog on the page
