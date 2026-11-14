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
  const own = all(dialog, 'button[aria-label="Dismiss"]');
  // The stable selector only when it resolves to this very dialog and to
  // the Dismiss inside it; otherwise pin the element as found.
  const dialogs = all(doc, SENT_DIALOG);
  const dismisses = all(doc, SENT_DISMISS);
  if (
    dialogs.length === 1 &&
    dialogs[0] === dialog &&
    dismisses.length === 1 &&
    own.length === 1 &&
    dismisses[0] === own[0]
  ) {
    return { close: SENT_DISMISS };
  }
  const [only] = own;
  return { close: own.length === 1 && only ? selectorFor(doc, only) : null };
}
