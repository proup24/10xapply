import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDiscard, readDismiss } from './close.js';
import { parsePage } from './dom.js';
import { all } from './el.js';
import { DISMISS, FORM_DIALOG, FORM_HEADER } from './selectors.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apply',
  'fixtures',
);
const page = (name: string) =>
  parsePage(readFileSync(join(FIXTURES, name), 'utf8'));

describe('close-out readers', () => {
  it('finds the form Dismiss, not the save prompt one', () => {
    expect(readDismiss(page('review.html'))).toBe(DISMISS);
    expect(readDismiss(page('review-save-prompt.html'))).toBe(DISMISS);
    expect(readDismiss(page('job-page.html'))).toBeNull();
  });

  it('finds Discard only on the save prompt', () => {
    expect(readDiscard(page('review-save-prompt.html'))).toBe(
      'button[componentkey="0b8ffbda-ce8d-4452-bf6a-5d96b318ac9e"]',
    );
    expect(readDiscard(page('review.html'))).toBeNull();
  });

  it('FORM_DIALOG is the one dialog holding the form header, not the save prompt', () => {
    for (const name of [
      'step-contact.html',
      'step-resume.html',
      'review.html',
      'review-save-prompt.html',
    ]) {
      const dialogs = all(page(name), FORM_DIALOG);
      expect(dialogs).toHaveLength(1);
      expect(all(dialogs[0], FORM_HEADER)).toHaveLength(1);
      expect(all(dialogs[0], 'h2').map((h) => h.textContent)).not.toContain(
        'Save this application?',
      );
    }
  });
});
