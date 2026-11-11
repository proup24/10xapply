import { draw } from './defaults.js';
import { physicalKey } from './keys.js';
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
 * `hold` (pace passes calibrated holds, see holds.ts; default `keyHold`).
 * Never a backspace or a fake typo.
 */
export function planKeys(
  text: string,
  profile: PaceProfile,
  rng: Rng,
  hold: (rng: Rng) => number = (r) => draw(profile, 'keyHold', r, { min: 1 }),
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
    hold: hold(rng),
  }));
  // The same key twice (`a`/`A` and `1`/`!` are one key): a finger lets go
  // before it presses again. The hold
  // stays as drawn and the next press waits (holds clipped to the gap were
  // far shorter than any of the author's); the release takes the gap's last
  // REPEAT_RELEASE_SHARE.
  for (let i = 0; i + 1 < keys.length; i++) {
    const next = keys[i + 1];
    if (physicalKey(next.ch) === physicalKey(keys[i].ch)) {
      next.gapBefore = Math.max(
        next.gapBefore,
        keys[i].hold / (1 - REPEAT_RELEASE_SHARE),
      );
    }
  }
  return keys;
}
