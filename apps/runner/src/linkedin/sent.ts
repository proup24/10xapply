import type { Document } from './dom.js';
import { all, textOf } from './el.js';
import { selectorFor } from './form-step.js';
import { SENT_DIALOG, SENT_DISMISS, SENT_HEADING } from './selectors.js';

/**
 * LinkedIn's "Your application was sent" dialog. Null when it isn't up.
 * Otherwise `close` is the selector for its own Dismiss, or null when the
 * dialog can't be pinned to one element or holds no single Dismiss. Other
 * Dismiss buttons on the page (the Premium banner's) never count.
 */
export function readSent(doc: Document): { close: string | null } | null {
  const dialog = all(doc, '[role="dialog"], dialog').find((d) =>
    all(d, 'h1, h2, h3').some((h) => SENT_HEADING.test(textOf(h))),
  );
  if (!dialog) return null;
  if (all(doc, SENT_DIALOG).length === 1 && all(doc, SENT_DISMISS).length === 1)
    return { close: SENT_DISMISS };
  const own = all(dialog, 'button[aria-label="Dismiss"]');
  const [only] = own;
  return { close: own.length === 1 && only ? selectorFor(doc, only) : null };
}
