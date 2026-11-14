import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePage } from './dom.js';
import { all } from './el.js';
import { SENT_DIALOG } from './selectors.js';
import { readSent } from './sent.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../apply/fixtures');
const load = (f: string) => parsePage(readFileSync(join(dir, f), 'utf8'));

describe('readSent', () => {
  it.each(['job-applied.html', 'sent-dialog-2.html'])(
    '%s: the sent dialog with its one Dismiss, never the Premium one',
    (f) => {
      const doc = load(f);
      const s = readSent(doc);
      expect(s?.close).not.toBeNull();
      const els = all(doc, s!.close!);
      expect(els).toHaveLength(1);
      expect(els[0]!.getAttribute('aria-label')).toBe('Dismiss');
      expect(els[0]!.getAttribute('aria-label')).not.toMatch(/premium/i);
      expect(els[0]!.closest(SENT_DIALOG)).not.toBeNull();
    },
  );

  it.each(['job-applied.html', 'sent-dialog-2.html'])(
    'SENT_DIALOG matches exactly one element on %s',
    (f) => {
      expect(all(load(f), SENT_DIALOG)).toHaveLength(1);
    },
  );

  it('sent-dialog-2.html also has a Premium Dismiss, outside the dialog', () => {
    const doc = load('sent-dialog-2.html');
    const premium = all(doc, 'button[aria-label^="Dismiss "]');
    expect(premium.length).toBeGreaterThan(0);
    expect(premium.every((b) => b.closest(SENT_DIALOG) === null)).toBe(true);
  });

  it('a Premium-style Dismiss and no sent dialog gives null', () => {
    const doc = parsePage(
      '<body><section><button aria-label="Dismiss Job search smarter with Premium"></button><button aria-label="Dismiss"></button></section><h3>Your application was sent to Acme!</h3></body>',
    );
    expect(readSent(doc)).toBeNull();
  });

  it("SENT_DIALOG on another element than the heading's dialog: falls back", () => {
    // The stable selector would name the empty dialog first; the reader
    // pins the heading's own Dismiss instead.
    const doc = parsePage(
      '<body><div role="dialog" aria-labelledby="post-apply-modal"><button aria-label="Dismiss" id="other"></button></div>' +
        '<div role="dialog" id="sent"><button aria-label="Dismiss" id="own"></button><h3>Your application was sent to Acme!</h3></div></body>',
    );
    const s = readSent(doc);
    expect(s).toEqual({ close: '#own' });
  });

  it.each(['job-page.html', 'review.html', 'step-contact.html'])(
    '%s: no sent dialog',
    (f) => {
      expect(readSent(load(f))).toBeNull();
    },
  );

  it('a sent dialog with two Dismiss buttons gives close null', () => {
    const doc = parsePage(
      '<body><div role="dialog" aria-labelledby="post-apply-modal"><button aria-label="Dismiss"></button><button aria-label="Dismiss"></button><h3>Your application was sent to Acme!</h3></div></body>',
    );
    expect(readSent(doc)).toEqual({ close: null });
  });
});
