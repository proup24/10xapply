import type { MeasureName } from './measures.js';
import { sampleKde, type PaceProfile } from './profile.js';
import type { Rng } from './rng.js';

/**
 * Fallback samples for a measure the profile has fewer than 2 samples of.
 * Each is a small spread of ordinary human values, so draws still vary.
 * Times are in ms, rates are per opportunity (0..1), distances in CSS px.
 */
export const DEFAULTS: Partial<Record<MeasureName, readonly number[]>> = {
  // Reading a job description before acting: about 4–9 s.
  readDwell: [4000, 5000, 6000, 7500, 9000],
  // Share of applications where "more" is clicked / the description scrolled.
  expandRate: [0.3, 0.5, 0.7],
  scrollRate: [0.3, 0.5, 0.7],
  // Gap between wheel notches inside one burst: a finger rolling the wheel.
  wheelGap: [40, 60, 80, 110, 150],
  // Notches per scroll burst.
  wheelBurst: [2, 3, 4, 5],
  // Largest sideways bulge of a path, as a share of its length.
  pathDeviation: [0.02, 0.04, 0.06, 0.09, 0.12],
  // Share of moves that pass their end point and come back.
  overshootRate: [0.1, 0.15, 0.2],
  // How far an overshoot passes the end point.
  overshootDist: [5, 8, 12, 18],
  // Time between pointermoves: one per frame at 60–125 Hz, with jitter.
  sampleInterval: [8, 12, 16, 16, 17, 20],
  // Resting on the target before pressing.
  hoverToPress: [60, 100, 140, 200, 280],
  // Holding the mouse button down.
  pressRelease: [60, 80, 95, 110, 130],
  // Click point offset from the box centre, normalised by half-size.
  clickOffsetX: [-0.4, -0.2, 0, 0.15, 0.35],
  clickOffsetY: [-0.3, -0.1, 0, 0.1, 0.3],
  // Holding a key down.
  keyHold: [60, 75, 90, 105, 120],
  // Keydown to keydown inside a word, and after a space.
  keyGapInWord: [110, 140, 170, 210, 260],
  keyGapAfterSpace: [180, 230, 280, 350, 450],
  // Looking at a prefilled field before moving on.
  fieldDwellPrefilled: [400, 600, 900, 1300],
  // Focusing a field before the first key.
  fieldDwellBeforeTyping: [250, 400, 600, 900],
  // Last key to the next mouse move; also the gap between actions.
  afterTypingToMove: [250, 400, 600, 900],
  // A select popup open before the choice lands.
  pickDwell: [500, 800, 1100, 1500],
  // Time in the OS file dialog, from the press to the file landing: about 4 s
  // (the author's practice uploads took 4.6–6.2 s).
  fileChooserDwell: [3000, 4000, 5000],
  // Share of presses followed by a long pause, and how long it lasts.
  longPauseRate: [0.03, 0.05, 0.08],
  longPause: [3500, 5000, 8000, 12000],
  // One application's pace against the typical one.
  appSpeedFactor: [0.85, 0.95, 1, 1.05, 1.2],
};

/** True when the profile has too few samples of `name` to draw from. */
export function isDefaulted(profile: PaceProfile, name: MeasureName): boolean {
  return (profile.samples[name]?.length ?? 0) < 2;
}

/** The profile's samples of `name`, or the DEFAULTS when it has fewer than 2. */
export function samplesOf(profile: PaceProfile, name: MeasureName): number[] {
  const own = profile.samples[name];
  if (own && own.length >= 2) return own;
  const fallback = DEFAULTS[name];
  if (!fallback) throw new Error(`no samples or default for ${name}`);
  return [...fallback];
}

/** One smoothed draw of `name` (see `sampleKde`). */
export function draw(
  profile: PaceProfile,
  name: MeasureName,
  rng: Rng,
  opts: { min?: number; max?: number } = {},
): number {
  return sampleKde(samplesOf(profile, name), rng, opts);
}

/** The mean of a rate measure, clamped to [0, 1]. */
export function rate(profile: PaceProfile, name: MeasureName): number {
  const xs = samplesOf(profile, name);
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.min(1, Math.max(0, m));
}
