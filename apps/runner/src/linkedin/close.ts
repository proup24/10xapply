import type { Document } from './dom.js';
import { all, textOf } from './el.js';
import { selectorFor } from './form-step.js';
import { DISCARD_TEXT, DISMISS, SAVE_PROMPT_TITLE } from './selectors.js';

/** The form's Dismiss button, or null unless exactly one is on the page. */
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
