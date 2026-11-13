import { describe, expect, it } from 'vitest';
import { parsePage } from './dom.js';

describe('parsePage', () => {
  it('reaches an input inside a shadow root', () => {
    const doc = parsePage(
      '<div><template shadowrootmode="open"><input id="a"></template></div>',
    );
    expect(doc.querySelector('#a')).not.toBeNull();
  });

  it('handles nested shadow roots', () => {
    const doc = parsePage(
      '<div><template shadowrootmode="open"><section><template shadowrootmode="open"><input id="deep"></template></section></template></div>',
    );
    expect(doc.querySelector('#deep')).not.toBeNull();
    expect(doc.querySelector('template')).toBeNull();
  });

  it('leaves ordinary templates alone', () => {
    const doc = parsePage('<div><template id="t"><b>x</b></template></div>');
    expect(doc.querySelector('template#t')).not.toBeNull();
  });
});
