import type { Document } from './dom.js';
import { all, blockText, one, textOf, type El } from './el.js';
import {
  ALERT_PREFIX,
  ALERT_SWITCH,
  EASY_APPLY,
  FOLLOW_BUTTON,
  FOLLOW_PREFIXES,
  MORE_BUTTON,
} from './selectors.js';
import type { JobRead } from './types.js';

/** How far above the "About the job" heading its section may start. */
const MAX_SECTION_CLIMB = 6;

/**
 * Reads a job page. Page text is masked in the fixtures, so title and
 * company come from aria-labels that name them: the job-alert switch
 * ("Set alert for similar jobs as <title>") and the company's Follow button.
 * No structural source names the location, so it is null.
 */
export function readJobPage(doc: Document): JobRead {
  const easy = one(doc, EASY_APPLY);
  return {
    title: afterPrefix(one(doc, ALERT_SWITCH), [ALERT_PREFIX]),
    company: afterPrefix(one(doc, FOLLOW_BUTTON), FOLLOW_PREFIXES),
    location: null,
    description: readDescription(doc),
    easyApply: easy ? EASY_APPLY : null,
    applied: !easy && appliedMarks(doc),
  };
}

function afterPrefix(el: El | null, prefixes: string[]): string | null {
  const label = el?.getAttribute('aria-label') ?? '';
  const prefix = prefixes.find((p) => label.startsWith(p));
  const rest = prefix === undefined ? '' : label.slice(prefix.length).trim();
  return rest === '' ? null : rest;
}

function appliedMarks(doc: Document): boolean {
  if (all(doc, 'h2').some((h) => textOf(h) === 'Application status')) {
    return true;
  }
  const body = one(doc, 'body');
  return body !== null && textOf(body).includes('Your application was sent');
}

/**
 * The text of the "About the job" section: the smallest ancestor of the
 * heading that holds more than the heading, without the heading and the
 * "… more" button. Null when the climb reaches another section's heading.
 */
function readDescription(doc: Document): string | null {
  const heading = all(doc, 'h2').find((h) => textOf(h) === 'About the job');
  if (!heading) return null;
  const skip = (e: El) => e === heading || e.matches(MORE_BUTTON);
  let box = heading.parentElement;
  for (let i = 0; box && i < MAX_SECTION_CLIMB; i++, box = box.parentElement) {
    if (all(box, 'h2').length > 1) return null;
    const text = blockText(box, skip);
    if (text !== '') return text;
  }
  return null;
}
