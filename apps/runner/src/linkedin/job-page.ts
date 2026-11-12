import type { Document } from './dom.js';
import { all, blockText, one, textOf, type El } from './el.js';
import {
  ALERT_PREFIX,
  ALERT_SWITCH,
  EASY_APPLY,
  FOLLOW_BUTTON,
  FOLLOW_PREFIXES,
  FORM_COMPANY_PREFIX,
  FORM_HEADER,
  MORE_BUTTON,
} from './selectors.js';
import type { JobRead } from './types.js';

/** How far above the "About the job" heading its section may start. */
const MAX_SECTION_CLIMB = 6;

/**
 * Reads a job page. Page text is masked in the fixtures, so title and
 * company come from aria-labels that name them: the job-alert switch
 * ("Set alert for similar jobs as <title>") and the company's Follow button.
 * When the form is open, its "Apply to <company>" heading names the company
 * instead. No structural source names the location, so it is null.
 */
export function readJobPage(doc: Document): JobRead {
  const easy = one(doc, EASY_APPLY);
  return {
    title: afterPrefix(one(doc, ALERT_SWITCH), [ALERT_PREFIX]),
    company: readFormCompany(doc) ?? followCompany(doc),
    location: null,
    description: readDescription(doc),
    easyApply: easy ? EASY_APPLY : null,
    applied: !easy && appliedMarks(doc),
  };
}

/**
 * The company the Follow buttons name, or null when there is none or they
 * name different companies (a page showing other jobs' companies too).
 */
function followCompany(doc: Document): string | null {
  const names = new Set(
    all(doc, FOLLOW_BUTTON).map((b) => afterPrefix(b, FOLLOW_PREFIXES)),
  );
  const [only] = [...names];
  return names.size === 1 && only !== undefined ? only : null;
}

/**
 * The company in the open Easy Apply form's heading ("Apply to <company>"),
 * or null when the form is not open or its heading reads otherwise.
 */
export function readFormCompany(doc: Document): string | null {
  for (const h of all(doc, `dialog ${FORM_HEADER} h2`)) {
    const text = textOf(h);
    if (!text.startsWith(FORM_COMPANY_PREFIX)) continue;
    const rest = text.slice(FORM_COMPANY_PREFIX.length).trim();
    if (rest !== '') return rest;
  }
  return null;
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
