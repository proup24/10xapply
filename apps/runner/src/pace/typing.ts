import { draw } from './defaults.js';
import type { PaceProfile } from './profile.js';
import type { Rng } from './rng.js';

/** Before a repeated key, its release takes at least this share of the gap. */
const REPEAT_RELEASE_SHARE = 0.2;

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
  // The same key twice: a finger lets go before it presses again. The hold
  // stays as drawn and the next press waits (holds clipped to the gap were
  // far shorter than any of the author's); the release takes the gap's last
  // REPEAT_RELEASE_SHARE.
  for (let i = 0; i + 1 < keys.length; i++) {
    const next = keys[i + 1];
    if (next.ch.toLowerCase() === keys[i].ch.toLowerCase()) {
      next.gapBefore = Math.max(
        next.gapBefore,
        keys[i].hold / (1 - REPEAT_RELEASE_SHARE),
      );
    }
  }
  return keys;
}
