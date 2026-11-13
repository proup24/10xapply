/**
 * Every CSS selector the LinkedIn readers use or hand out. They are plain
 * CSS (no Patchright text engines), so the same strings work in linkedom and
 * in a Patchright locator, which pierces open shadow roots. The fixtures
 * named are in `src/apply/fixtures/`.
 */

/** The job page's Easy Apply button (job-page.html, job-page-2.html). */
export const EASY_APPLY = 'button[aria-label="Easy Apply to this job"]';
/** The "… more" toggle beside the job description (job-page.html). */
export const MORE_BUTTON = '[data-testid="expandable-text-button"]';
/**
 * The job-alert switch, whose aria-label ends in the job title
 * ("Set alert for similar jobs as <title>"; job-page.html).
 */
export const ALERT_SWITCH = '[aria-label^="Set alert for similar jobs as "]';
export const ALERT_PREFIX = 'Set alert for similar jobs as ';
/**
 * The company's Follow button: "Follow <company>" (job-page.html) or
 * "Following, click to unfollow <company>" (job-applied.html). Buttons only:
 * the form's "Follow <company> to stay up to date…" is a checkbox.
 */
export const FOLLOW_BUTTON =
  'button[aria-label^="Follow "], button[aria-label^="Following, click to unfollow "]';
export const FOLLOW_PREFIXES = ['Following, click to unfollow ', 'Follow '];

/**
 * The Easy Apply form is the `<dialog>` holding this header, with an `h2`
 * "Apply to <company>" (step-contact.html and every step and review fixture).
 * It has no role="dialog".
 */
export const FORM_HEADER = '#dialog-header';
/**
 * The Easy Apply form's `<dialog>`: the one that holds `#dialog-header`
 * (step-contact.html, step-resume.html, review.html and every step and
 * review fixture). Its content scrolls on its own, so it is the visible box
 * (`within`) for every pace action inside the form. The "Save this
 * application?" prompt is a second `<dialog>` without this label
 * (review-save-prompt.html).
 */
export const FORM_DIALOG = 'dialog[aria-labelledby="dialog-header"]';
/**
 * The form's scrolling content: it holds the fields and the footer with
 * Next, Review and Submit (step-contact.html, step-resume.html, review.html
 * and every step and review fixture), so it is the visible box (`within`)
 * for fills and the Next/Review click. The header's Dismiss is outside it.
 */
export const FORM_CONTENT = `${FORM_DIALOG} [data-testid="dialog-content"]`;
/** The form header's `h2` reads "Apply to <company>" (step-contact.html). */
export const FORM_COMPANY_PREFIX = 'Apply to ';
/** The step buttons: Back, Next, Review, Submit application (step-resume.html). */
export const FOOTER_BUTTONS = 'footer button';
/**
 * The wrapper around one question; its componentkey is the field key
 * (step-contact.html, step-questions.html).
 */
export const FIELD_WRAPPER = '[componentkey^="easyApplyFieldFocus_"]';
/** The "Follow <company> to stay up to date with their page" checkbox (review.html). */
export const FOLLOW_CHECKBOX_LABEL = /^Follow .+ to stay up to date/i;
/** Resume radios are labelled with their file name (step-resume.html). */
export const RESUME_FILE = /\.(pdf|docx?)$/i;
/**
 * The resume section's button that opens the file chooser (step-resume.html,
 * review-one-page.html). Other upload buttons (a cover letter) don't match.
 */
export const UPLOAD_RESUME_TEXT = /^upload resume/i;
/** Error messages inside the form (synthetic; none in the captures). */
export const FORM_ERRORS = '[role="alert"], [id^="error-message"]';

/**
 * The form's own Dismiss (X) button, scoped to the dialog labelled by the
 * form header: the "Save this application?" prompt has a Dismiss of its own
 * (review.html, review-save-prompt.html).
 */
export const DISMISS = `${FORM_DIALOG} button[aria-label="Dismiss"]`;
/**
 * After Dismiss, LinkedIn asks "Save this application?" in a second
 * `<dialog>` with "Discard" and "Save" buttons that carry no aria-label, so
 * Discard is found by its text (review-save-prompt.html).
 */
export const SAVE_PROMPT_TITLE = 'Save this application?';
/**
 * The save prompt's own `<dialog>`: the open dialog that is not the form's
 * (review-save-prompt.html, review-backdrop-prompt.html). It has the same
 * class and data-testid as the form and no label, so it is told apart by
 * lacking the form's `aria-labelledby`. Readers hand it out only when it
 * matches exactly one dialog and that dialog holds the prompt's title.
 */
export const SAVE_PROMPT_DIALOG =
  'dialog[data-testid="dialog"]:not([aria-labelledby="dialog-header"])';
export const DISCARD_TEXT = 'Discard';

/** `[attr="value"]` with the value quoted for CSS. */
export function attr(name: string, value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Line breaks can't stand in a CSS string: hex escapes, each ended by a space.
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
  return `[${name}="${escaped}"]`;
}

/**
 * `#id` for an element id. React ids like `_r_1d_` are plain CSS idents
 * (step-contact.html); anything else falls back to `[id="…"]`.
 */
export function byId(id: string): string {
  return /^-?[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : attr('id', id);
}

/**
 * A button by its componentkey, which LinkedIn keeps for the life of the
 * page (the Next button's key is the same on step-contact-email-phone.html
 * and step-resume.html, both from one page load).
 */
export function byComponentKey(tag: string, key: string): string {
  return `${tag}${attr('componentkey', key)}`;
}
