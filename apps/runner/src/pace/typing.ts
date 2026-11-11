import { draw } from './defaults.js';
import type { PaceProfile } from './profile.js';
import type { Rng } from './rng.js';

/** One keystroke: `gapBefore` is keydown to keydown, `hold` keydown to keyup, in ms. */
export interface PlannedKey {
  ch: string;
  gapBefore: number;
  hold: number;
}

/**
 * The keystrokes for `text`, one per character, in order. Gaps come from
 * `keyGapAfterSpace` after a space and `keyGapInWord` otherwise; holds from
 * `keyHold`. Never a backspace or a fake typo.
 */
export function planKeys(
  text: string,
  profile: PaceProfile,
  rng: Rng,
): PlannedKey[] {
  const chars = [...text];
  const keys = chars.map((ch, i) => ({
    ch,
    gapBefore:
      i === 0
        ? 0
        : draw(
            profile,
            chars[i - 1] === ' ' ? 'keyGapAfterSpace' : 'keyGapInWord',
            rng,
            { min: 1 },
          ),
    hold: draw(profile, 'keyHold', rng, { min: 1 }),
  }));
  // The same key twice: a finger lets go before it presses again.
  for (let i = 0; i + 1 < keys.length; i++) {
    const next = keys[i + 1];
    if (next.ch.toLowerCase() === keys[i].ch.toLowerCase()) {
      keys[i].hold = Math.min(keys[i].hold, next.gapBefore * 0.8);
    }
  }
  return keys;
}
