import { describe, expect, it } from 'vitest';
import { ksTwoSample } from './ks.js';
import { seededRng } from './rng.js';

function normals(n: number, mean: number, seed: number): number[] {
  const rng = seededRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = 1 - rng.next();
    out.push(
      mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next()),
    );
  }
  return out;
}

describe('ksTwoSample', () => {
  it('identical samples give d 0 and p 1', () => {
    const a = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(ksTwoSample(a, [...a].reverse())).toEqual({ d: 0, p: 1 });
  });

  it('N(0,1) vs N(1,1) with n=500 gives p < 0.001', () => {
    const r = ksTwoSample(normals(500, 0, 1), normals(500, 1, 2));
    expect(r.d).toBeGreaterThan(0.25);
    expect(r.p).toBeLessThan(0.001);
  });

  it('two samples from one distribution give a high p', () => {
    expect(
      ksTwoSample(normals(500, 0, 3), normals(400, 0, 4)).p,
    ).toBeGreaterThan(0.05);
  });

  it('the result matches a known reference pair', () => {
    // SciPy 1.18.1: ks_2samp(a, b, method='asymp') gives statistic 0.45,
    // pvalue 0.014961300030127744. SciPy's 'asymp' evaluates the exact
    // one-sample distribution at n = round(mn/(m+n)); ours is Stephens'
    // corrected asymptotic formula, which lands within 10% of it here.
    const a = [
      0.61, 0.29, 0.06, 0.59, -1.73, -0.74, 0.51, -0.56, 0.39, 1.64, 0.05,
      -0.06, 0.64, -0.82, 0.37, 1.77, 1.09, -1.28, 2.36, 1.31, 1.05, -0.52,
      -0.74, 0.71,
    ];
    const b = [
      -0.15, 1.19, 0.37, 1.83, 0.94, 1.47, 2.05, 0.29, 1.61, 0.43, 2.57, 0.98,
      1.38, 0.11, 1.86, 0.73, 1.31, 2.29, 0.52, 1.02,
    ];
    const r = ksTwoSample(a, b);
    expect(r.d).toBeCloseTo(0.45, 12);
    expect(
      Math.abs(r.p - 0.014961300030127744) / 0.014961300030127744,
    ).toBeLessThan(0.1);
  });

  it('counts ties once on both sides', () => {
    expect(ksTwoSample([1, 2, 2, 3], [2, 2, 2, 2]).d).toBeCloseTo(0.25, 12);
  });

  it('refuses an empty sample', () => {
    expect(() => ksTwoSample([], [1])).toThrow();
  });

  it('refuses NaN and infinite values instead of hanging', () => {
    expect(() => ksTwoSample([1, NaN, 2], [1, 2])).toThrow(/finite/);
    expect(() => ksTwoSample([1, 2], [Infinity])).toThrow(/finite/);
  });
});
