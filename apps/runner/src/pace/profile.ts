import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../config.js';
import {
  extractMeasures,
  MEASURE_NAMES,
  type MeasureName,
  type Models,
} from './measures.js';
import { PACE_DIR } from './paths.js';
import { isApplication } from './phases.js';
import type { Recording } from './recording.js';
import type { Rng } from './rng.js';

export interface PaceProfile {
  version: 1;
  builtAt: string;
  sources: { applications: number; practice: number };
  samples: Partial<Record<MeasureName, number[]>>;
  /** travel = a + b*log2(D/W + 1) + residual. `wFixed` is set when W was not recorded. */
  fitts: { a: number; b: number; residuals: number[]; wFixed?: number };
  reading: { base: number; perChar: number; residuals: number[] } | null;
  /** The author's notch: the most common deltaY and its deltaMode. */
  wheel: { deltaY: number; deltaMode: number };
  /** Compare baseline only; never sampled from. */
  practice: { stepTime: number[]; appTime: number[] };
}

/** Fewer moves than this with a recorded target size: fit with a fixed W. */
export const MIN_FITTS_MOVES_WITH_SIZE = 10;
/** The W used for every move when target sizes are missing, in CSS px. */
export const FITTS_FIXED_W = 40;
/** Used when no wheel event was recorded: one typical mouse notch. */
export const DEFAULT_WHEEL = { deltaY: 100, deltaMode: 0 };

const finite = (x: number) => Number.isFinite(x);

/** Least squares y = a + b*x. Degenerate input (< 2 points, equal x) gives b = 0. */
function leastSquares(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0 };
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (n < 2 || sxx < 1e-9) return { a: my, b: 0 };
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

export function fitFitts(moves: Models['moves']): PaceProfile['fitts'] {
  const usable = moves.filter(
    (m) => finite(m.distance) && m.distance > 0 && finite(m.travel),
  );
  const sized = usable.filter((m) => (m.targetSize ?? 0) > 0);
  const useFixed = sized.length < MIN_FITTS_MOVES_WITH_SIZE;
  const pts = useFixed ? usable : sized;
  const xs = pts.map((m) =>
    Math.log2(
      m.distance / (useFixed ? FITTS_FIXED_W : (m.targetSize ?? 0)) + 1,
    ),
  );
  const ys = pts.map((m) => m.travel);
  const { a, b } = leastSquares(xs, ys);
  const residuals = ys.map((y, i) => y - (a + b * xs[i]));
  return {
    a,
    b,
    residuals,
    ...(useFixed ? { wFixed: FITTS_FIXED_W } : {}),
  };
}

export function fitReading(reading: Models['reading']): PaceProfile['reading'] {
  const pts = reading.filter(
    (r): r is { chars: number; dwell: number } =>
      r.chars !== null && finite(r.chars) && finite(r.dwell),
  );
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.chars);
  const ys = pts.map((p) => p.dwell);
  const { a, b } = leastSquares(xs, ys);
  return {
    base: a,
    perChar: b,
    residuals: ys.map((y, i) => y - (a + b * xs[i])),
  };
}

/**
 * The author's notch: the most common |deltaY| over non-zero events (ties:
 * the smaller) and the deltaMode seen most with it. The sign is applied by
 * whoever scrolls. No usable events gives DEFAULT_WHEEL.
 */
export function wheelNotch(wheel: Models['wheel']): PaceProfile['wheel'] {
  const used = wheel.filter((w) => finite(w.deltaY) && w.deltaY !== 0);
  if (used.length === 0) return { ...DEFAULT_WHEEL };
  const mode = (xs: number[]) => {
    const c = new Map<number, number>();
    for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
    return [...c].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0];
  };
  const deltaY = mode(used.map((w) => Math.abs(w.deltaY)));
  const deltaMode = mode(
    used.filter((w) => Math.abs(w.deltaY) === deltaY).map((w) => w.deltaMode),
  );
  return { deltaY, deltaMode };
}

/** The recordings that feed samples: LinkedIn and typing, never practice. */
const feeding = (recs: Recording[]) =>
  recs.filter((r) => r.source === 'linkedin' || r.source === 'typing');

/** True when `buildProfile(recs)` falls back to DEFAULT_WHEEL. */
export function wheelDefaulted(recs: Recording[]): boolean {
  const w = extractMeasures(feeding(recs)).models.wheel;
  return !w.some((x) => finite(x.deltaY) && x.deltaY !== 0);
}

/**
 * Builds the profile. Practice recordings only fill `profile.practice`;
 * typing recordings feed the key measures like any other.
 */
export function buildProfile(recs: Recording[]): PaceProfile {
  const main = feeding(recs);
  const practice = recs.filter((r) => r.source === 'practice');
  const m = extractMeasures(main);
  const p = extractMeasures(practice);
  const samples: PaceProfile['samples'] = {};
  for (const n of MEASURE_NAMES) if (m[n].length > 0) samples[n] = m[n];
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    sources: {
      applications: main.filter(
        (r) => r.source === 'linkedin' && isApplication(r),
      ).length,
      practice: practice.filter(isApplication).length,
    },
    samples,
    fitts: fitFitts(m.models.moves),
    reading: fitReading(m.models.reading),
    wheel: wheelNotch(m.models.wheel),
    practice: { stepTime: p.stepTime, appTime: p.appTime },
  };
}

export function loadProfile(
  path = join(PACE_DIR, 'profile.json'),
): PaceProfile {
  if (!existsSync(path))
    throw new ConfigError('no pace profile: run pnpm nx run runner:pace-build');
  return JSON.parse(readFileSync(path, 'utf8')) as PaceProfile;
}

function gaussian(rng: Rng): number {
  const u = 1 - rng.next(); // (0, 1]
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/**
 * Smoothed bootstrap: picks a sample, adds Gaussian noise with Silverman's
 * bandwidth, clamps to [min ?? 0, max ?? Infinity].
 */
export function sampleKde(
  samples: number[],
  rng: Rng,
  opts: { min?: number; max?: number } = {},
): number {
  const n = samples.length;
  if (n < 2) throw new Error('sampleKde needs at least 2 samples');
  const mean = samples.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(
    samples.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1),
  );
  const s = [...samples].sort((a, b) => a - b);
  const q = (f: number) => {
    const i = f * (n - 1);
    const lo = Math.floor(i);
    return s[lo] + (s[Math.min(lo + 1, n - 1)] - s[lo]) * (i - lo);
  };
  const spread = Math.min(sd, (q(0.75) - q(0.25)) / 1.34);
  const h = 0.9 * (spread > 0 ? spread : sd) * n ** -0.2;
  const pick = samples[Math.min(n - 1, Math.floor(rng.next() * n))];
  const x = pick + h * gaussian(rng);
  return Math.min(opts.max ?? Infinity, Math.max(opts.min ?? 0, x));
}
