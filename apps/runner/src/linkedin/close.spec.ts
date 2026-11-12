import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDiscard, readDismiss, readPromptDialog } from './close.js';
import { parsePage } from './dom.js';
import { all } from './el.js';
import {
  DISMISS,
  FORM_DIALOG,
  FORM_HEADER,
  SAVE_PROMPT_DIALOG,
} from './selectors.js';

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

  describe('the save prompt open over a step (review-backdrop-prompt.html)', () => {
    const doc = () => page('review-backdrop-prompt.html');

    it('has two Dismiss buttons, and the form Dismiss selector matches one, in the form', () => {
      const d = doc();
      expect(all(d, 'button[aria-label="Dismiss"]')).toHaveLength(2);
      const mine = all(d, DISMISS);
      expect(mine).toHaveLength(1);
      const inForm = all(
        all(d, FORM_DIALOG)[0],
        'button[aria-label="Dismiss"]',
      );
      expect(inForm.some((b) => b === mine[0])).toBe(true);
      expect(readDismiss(d)).toBe(DISMISS);
    });

    it("finds the prompt's Discard", () => {
      const d = doc();
      const sel = readDiscard(d);
      expect(sel).toBe(
        'button[componentkey="b5c808de-27d8-46a8-88e2-a0d7ced09d23"]',
      );
      const found = all(d, sel ?? '');
      expect(found).toHaveLength(1);
      expect(found[0]?.textContent?.trim()).toBe('Discard');
    });

    it("finds the prompt's own dialog, which holds Discard and not the form", () => {
      const d = doc();
      expect(readPromptDialog(d)).toBe(SAVE_PROMPT_DIALOG);
      const dialogs = all(d, SAVE_PROMPT_DIALOG);
      expect(dialogs).toHaveLength(1);
      expect(all(dialogs[0], readDiscard(d) ?? '')).toHaveLength(1);
      expect(all(dialogs[0], FORM_HEADER)).toHaveLength(0);
    });
  });

  it('finds the prompt dialog only when the prompt shows', () => {
    expect(readPromptDialog(page('review-save-prompt.html'))).toBe(
      SAVE_PROMPT_DIALOG,
    );
    expect(readPromptDialog(page('review.html'))).toBeNull();
    expect(readPromptDialog(page('step-contact.html'))).toBeNull();
  });
});
