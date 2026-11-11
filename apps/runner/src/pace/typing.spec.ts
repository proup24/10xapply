import { seededRng } from './rng.js';
import { testProfile } from './testing/profiles.js';
import { planKeys } from './typing.js';

describe('planKeys', () => {
  it('gap after a space comes from keyGapAfterSpace', () => {
    const keys = planKeys('ab cd', testProfile(), seededRng(1));
    expect(keys.map((k) => k.gapBefore)).toEqual([0, 100, 100, 300, 100]);
    expect(keys.map((k) => k.hold)).toEqual([70, 70, 70, 70, 70]);
  });

  it('no backspaces are ever produced', () => {
    const rng = seededRng(2);
    const p = testProfile({
      keyGapInWord: [80, 120, 200],
      keyHold: [50, 90, 140],
    });
    for (let i = 0; i < 50; i++) {
      const keys = planKeys('the quick brown fox, 42 times!', p, rng);
      expect(keys.some((k) => k.ch === '\b' || k.ch === 'Backspace')).toBe(
        false,
      );
    }
  });

  it('every character of the text appears once, in order', () => {
    const text = 'Hello, wörld!\nNew line';
    const keys = planKeys(text, testProfile(), seededRng(3));
    expect(keys.map((k) => k.ch).join('')).toBe(text);
  });

  it('a repeated key is released before it is pressed again', () => {
    const p = testProfile({ keyHold: [400, 400, 400] });
    const keys = planKeys('aab', p, seededRng(4));
    expect(keys[0].hold).toBeLessThan(keys[1].gapBefore);
    expect(keys[1].hold).toBe(400);
  });
});
