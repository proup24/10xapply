import { samplesOf } from './defaults.js';
import { kdeSampler, type PaceProfile } from './profile.js';
import type { Rng } from './rng.js';

/**
 * Key-hold calibration (Ruling R37).
 *
 * The recorder keeps only a key's class, never the key, so a keyup can't be
 * matched to its own keydown. Measures pair them oldest-first: the k-th keyup
 * in a field goes with the k-th keydown. When keys overlap (a hold longer
 * than the gap to the next press, which is normal for the author: median
 * hold 144 ms against a median in-word gap of 120 ms) and a short hold
 * follows a long one, the later key comes up first and the pairing swaps the
 * two. So the profile's keyHold samples are paired values, not true holds.
 *
 * Drawing those paired values as true holds and pairing the runner's events
 * the same way distorts them a second time: the median read about 20 ms
 * long and compare's KS test failed (d 0.18). Forcing keys up in press order
 * doesn't help: one long hold then pushes every later one past it.
 *
 * Instead, find true holds whose paired result matches the author's. A short
 * simulation types runs of CALIBRATION_RUN keys with the author's in-word
 * gaps, pairs them oldest-first, and moves every sample by the difference
 * between the author's and the simulated quantile at its rank (quantile
 * correction), CALIBRATION_ROUNDS times. With the author's profile the true
 * holds come out near a 104 ms median, a plausible key hold, and the paired
 * result matches the author's within KS noise.
 *
 * Assumptions: typing comes in runs of about CALIBRATION_RUN keys (a field's
 * worth) with in-word gaps; spaces and Shift are not modelled.
 */
export const CALIBRATION_ROUNDS = 2;
export const CALIBRATION_KEYS = 12_000;
export const CALIBRATION_RUN = 12;

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

/** Linear-interpolated quantile of a sorted array at share `p` (0..1). */
function quantile(s: number[], p: number): number {
  const i = p * (s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}

/**
 * The holds the recorder's oldest-first pairing reads when `keys` keys are
 * typed in runs of `run`, holds drawn from `holds`, gaps from `gaps`.
 */
export function pairedHolds(
  holds: number[],
  gaps: number[],
  rng: Rng,
  keys = CALIBRATION_KEYS,
  run = CALIBRATION_RUN,
): number[] {
  const gap = kdeSampler(gaps);
  const hold = kdeSampler(holds);
  const out: number[] = [];
  while (out.length < keys) {
    const downs: number[] = [];
    const ups: number[] = [];
    let at = 0;
    for (let i = 0; i < run; i++) {
      if (i > 0) at += gap(rng, { min: 1 });
      downs.push(at);
      ups.push(at + hold(rng, { min: 1 }));
    }
    out.push(...pairOldestFirst(downs, ups));
  }
  return out;
}

/**
 * The holds the measures read for keys pressed at `downs` (in order) and
 * released at `ups`: the k-th release goes with the k-th press.
 */
export function pairOldestFirst(downs: number[], ups: number[]): number[] {
  const inOrder = sorted(ups);
  return downs.map((d, i) => inOrder[i] - d);
}

/**
 * True-hold samples for this profile: drawn as holds and paired oldest-first
 * by the recorder, they read like the author's keyHold. See the comment at
 * the top of this file.
 */
export function calibrateHolds(profile: PaceProfile, rng: Rng): number[] {
  const target = sorted(samplesOf(profile, 'keyHold'));
  const gaps = samplesOf(profile, 'keyGapInWord');
  let cur = [...target];
  for (let round = 0; round < CALIBRATION_ROUNDS; round++) {
    const seen = sorted(pairedHolds(cur, gaps, rng));
    // Each sample's rank among the current samples (ties keep their order).
    const order = cur
      .map((v, i) => [v, i] as const)
      .sort((a, b) => a[0] - b[0]);
    const next = [...cur];
    order.forEach(([v, i], rank) => {
      const p = cur.length > 1 ? rank / (cur.length - 1) : 0.5;
      next[i] = Math.max(1, v + quantile(target, p) - quantile(seen, p));
    });
    cur = next;
  }
  return cur;
}
