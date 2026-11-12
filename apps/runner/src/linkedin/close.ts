import type { Document } from './dom.js';
import { all, textOf } from './el.js';
import { selectorFor } from './form-step.js';
import {
  DISCARD_TEXT,
  DISMISS,
  SAVE_PROMPT_DIALOG,
  SAVE_PROMPT_TITLE,
} from './selectors.js';

/**
 * The form's own Dismiss button, or null unless exactly one is on the page.
 * The selector is scoped to the form's dialog, so the save prompt's own
 * Dismiss never counts (review-backdrop-prompt.html has both).
 */
export function readDismiss(doc: Document): string | null {
  return all(doc, DISMISS).length === 1 ? DISMISS : null;
}

/**
 * The Discard button of LinkedIn's "Save this application?" prompt, or null
 * when the prompt isn't showing or no selector picks the button out alone.
 */
export function readDiscard(doc: Document): string | null {
  const prompt = all(doc, 'dialog').find((d) =>
    all(d, 'h2').some((h) => textOf(h) === SAVE_PROMPT_TITLE),
  );
  const button = prompt
    ? all(prompt, 'button').find((b) => textOf(b) === DISCARD_TEXT)
    : undefined;
  return button ? selectorFor(doc, button) : null;
}

/**
 * The save prompt's own dialog, for `within` on its Discard: the selector
 * when it matches exactly one dialog and that dialog holds the prompt's
 * title, else null.
 */
export function readPromptDialog(doc: Document): string | null {
  const found = all(doc, SAVE_PROMPT_DIALOG);
  const [prompt] = found;
  if (found.length !== 1 || !prompt) return null;
  return all(prompt, 'h2').some((h) => textOf(h) === SAVE_PROMPT_TITLE)
    ? SAVE_PROMPT_DIALOG
    : null;
}
