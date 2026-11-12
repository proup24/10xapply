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
  /** file: resumes LinkedIn already lists. */
  resumeChoices?: { fileName: string; selector: string; selected: boolean }[];
  /** typeahead: where suggestions appear once typed. */
  suggestions?: string;
}
export interface UnknownField {
  tag: string;
  role: string | null;
  inputType: string | null;
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
  | { kind: 'review' }
  | { kind: 'none' }; // no Easy Apply dialog on the page
