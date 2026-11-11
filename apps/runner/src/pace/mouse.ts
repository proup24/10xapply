import { draw, rate } from './defaults.js';
import { OVERSHOOT_PX } from './measures.js';
import { sampleKde, type PaceProfile } from './profile.js';
import type { Rng } from './rng.js';

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A path point; `at` is ms from the start of the move. */
export interface TimedPt extends Pt {
  at: number;
}

/** No move travels faster than this, whatever the fit says (it is unconstrained). */
export const MIN_TRAVEL_MS = 80;
/** The click point stays this far inside the box, as a share of half-size. */
const CLICK_OFFSET_MAX = 0.8;
/** Every path bulges at least this much (share of its length): never a ruler line. */
const MIN_DEVIATION = 0.005;
/** A cubic Bézier with both control points offset by h bulges by 0.75 h. */
const BULGE = 0.75;
/** Arc-length lookup resolution per segment. */
const ARC_STEPS = 64;

/** Movement start → last move point: a + b·log2(D/W + 1) + a residual draw. */
function travelTime(
  d: number,
  w: number,
  profile: PaceProfile,
  rng: Rng,
): number {
  const { a, b, residuals } = profile.fitts;
  const residual =
    residuals.length >= 2
      ? sampleKde(residuals, rng, {
          min: Math.min(...residuals),
          max: Math.max(...residuals),
        })
      : (residuals[0] ?? 0);
  const t = a + b * Math.log2(d / Math.max(1, w) + 1) + residual;
  return Number.isFinite(t) ? Math.max(MIN_TRAVEL_MS, t) : MIN_TRAVEL_MS;
}

/** Minimum-jerk progress: s(τ) = 10τ³ − 15τ⁴ + 6τ⁵. */
const minJerk = (tau: number) => tau ** 3 * (10 - 15 * tau + 6 * tau ** 2);

/** A whole pixel in [lo, hi), or the nearest one when the span holds none. */
function pixelIn(v: number, lo: number, hi: number): number {
  const first = Math.ceil(lo);
  const last = Math.ceil(hi) - 1;
  if (first > last) return Math.round((lo + hi) / 2);
  return Math.min(last, Math.max(first, Math.round(v)));
}

/** One curved stroke from `from` to `to`, as position-at-progress. */
function stroke(
  from: Pt,
  to: Pt,
  profile: PaceProfile,
  rng: Rng,
): (s: number) => Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return () => ({ ...from });
  const dev = draw(profile, 'pathDeviation', rng, { min: MIN_DEVIATION });
  const side = rng.next() < 0.5 ? -1 : 1;
  const h = (side * dev * d) / BULGE;
  // Slightly different offsets give asymmetric, less regular curves.
  const h1 = h * (0.7 + 0.6 * rng.next());
  const h2 = h * (0.7 + 0.6 * rng.next());
  const nx = -dy / d;
  const ny = dx / d;
  const c1 = { x: from.x + dx / 3 + nx * h1, y: from.y + dy / 3 + ny * h1 };
  const c2 = {
    x: from.x + (2 * dx) / 3 + nx * h2,
    y: from.y + (2 * dy) / 3 + ny * h2,
  };
  const at = (u: number): Pt => {
    const v = 1 - u;
    const k0 = v * v * v;
    const k1 = 3 * v * v * u;
    const k2 = 3 * v * u * u;
    const k3 = u * u * u;
    return {
      x: k0 * from.x + k1 * c1.x + k2 * c2.x + k3 * to.x,
      y: k0 * from.y + k1 * c1.y + k2 * c2.y + k3 * to.y,
    };
  };
  // Cumulative arc length, so progress s is a share of distance travelled.
  const lens = [0];
  let prev = at(0);
  for (let i = 1; i <= ARC_STEPS; i++) {
    const p = at(i / ARC_STEPS);
    lens.push(lens[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const total = lens[ARC_STEPS];
  return (s) => {
    const target = Math.min(1, Math.max(0, s)) * total;
    let i = 1;
    while (i < ARC_STEPS && lens[i] < target) i++;
    const span = lens[i] - lens[i - 1];
    const f = span > 0 ? (target - lens[i - 1]) / span : 0;
    return at((i - 1 + f) / ARC_STEPS);
  };
}

/**
 * A human-looking move from `from` to a point inside `box`: a curved stroke
 * timed by the author's Fitts fit with a minimum-jerk speed profile,
 * sometimes passing the end and correcting back. Points are whole CSS
 * pixels, spaced by `sampleInterval` draws; the last point is `end`.
 */
export function planPath(
  from: Pt,
  box: Box,
  profile: PaceProfile,
  rng: Rng,
): { points: TimedPt[]; end: Pt } {
  const offset = (name: 'clickOffsetX' | 'clickOffsetY') =>
    draw(profile, name, rng, {
      min: -CLICK_OFFSET_MAX,
      max: CLICK_OFFSET_MAX,
    });
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const end = {
    x: pixelIn(
      cx + (offset('clickOffsetX') * box.width) / 2,
      box.x,
      box.x + box.width,
    ),
    y: pixelIn(
      cy + (offset('clickOffsetY') * box.height) / 2,
      box.y,
      box.y + box.height,
    ),
  };
  const d = Math.hypot(end.x - from.x, end.y - from.y);
  if (d < 1) return { points: [{ ...end, at: 0 }], end };
  const w = profile.fitts.wFixed ?? Math.min(box.width, box.height);

  // Strokes: straight to the end, or past it and back.
  const strokes: { run: (s: number) => Pt; duration: number }[] = [];
  if (rng.next() < rate(profile, 'overshootRate')) {
    const dist = draw(profile, 'overshootDist', rng, {
      min: OVERSHOOT_PX + 2,
    });
    const over = {
      x: end.x + ((end.x - from.x) / d) * dist,
      y: end.y + ((end.y - from.y) / d) * dist,
    };
    strokes.push({
      run: stroke(from, over, profile, rng),
      duration: travelTime(d + dist, w, profile, rng),
    });
    strokes.push({
      run: stroke(over, end, profile, rng),
      duration: travelTime(dist, w, profile, rng),
    });
  } else {
    strokes.push({
      run: stroke(from, end, profile, rng),
      duration: travelTime(d, w, profile, rng),
    });
  }

  const points: TimedPt[] = [];
  const total = strokes.reduce((s, k) => s + k.duration, 0);
  let t = draw(profile, 'sampleInterval', rng, { min: 1 });
  let t0 = 0;
  for (const { run, duration } of strokes) {
    while (t < t0 + duration && t < total) {
      const p = run(minJerk((t - t0) / duration));
      points.push({ x: Math.round(p.x), y: Math.round(p.y), at: t });
      t += draw(profile, 'sampleInterval', rng, { min: 1 });
    }
    t0 += duration;
  }
  points.push({ ...end, at: total });
  return { points, end };
}
