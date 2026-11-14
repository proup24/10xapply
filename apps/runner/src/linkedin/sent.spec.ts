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
  it('job-applied.html: the sent dialog with its Dismiss', () => {
    const doc = load('job-applied.html');
    const s = readSent(doc);
    expect(s?.close).not.toBeNull();
    const els = all(doc, s!.close!);
    expect(els).toHaveLength(1);
    expect(els[0]!.getAttribute('aria-label')).toBe('Dismiss');
    expect(els[0]!.getAttribute('aria-label')).not.toMatch(/premium/i);
  });

  it('SENT_DIALOG matches exactly one element on job-applied.html', () => {
    expect(all(load('job-applied.html'), SENT_DIALOG)).toHaveLength(1);
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
