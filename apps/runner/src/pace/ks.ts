/**
 * Kolmogorov's survival function Q(λ) = 2 Σ (−1)^(k−1) e^(−2k²λ²), with the
 * dual series for small λ, where the alternating one converges slowly.
 */
function kolmogorovQ(lambda: number): number {
  if (lambda <= 0) return 1;
  if (lambda < 1.18) {
    // Q = 1 − √(2π)/λ Σ e^(−(2k−1)²π²/(8λ²))
    const f = -(Math.PI ** 2) / (8 * lambda * lambda);
    let s = 0;
    for (let k = 1; k <= 20; k++) s += Math.exp(f * (2 * k - 1) ** 2);
    return Math.min(1, Math.max(0, 1 - (Math.sqrt(2 * Math.PI) / lambda) * s));
  }
  let s = 0;
  for (let k = 1; k <= 100; k++) {
    const term = Math.exp(-2 * k * k * lambda * lambda);
    s += (k % 2 ? 1 : -1) * term;
    if (term < 1e-16) break;
  }
  return Math.min(1, Math.max(0, 2 * s));
}

/**
 * Two-sample Kolmogorov–Smirnov test. `d` is the largest gap between the two
 * empirical CDFs (ties counted on both sides at once). `p` is the asymptotic
 * two-sided p-value, with Stephens' small-sample correction:
 * λ = (√n + 0.12 + 0.11/√n)·d, n = |a||b|/(|a|+|b|).
 */
export function ksTwoSample(
  a: number[],
  b: number[],
): { d: number; p: number } {
  if (a.length === 0 || b.length === 0) {
    throw new Error('ksTwoSample needs two non-empty samples');
  }
  // NaN never equals itself, so the tie loops below would never advance.
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) {
    throw new Error('ksTwoSample needs finite values');
  }
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] === v) i++;
    while (j < y.length && y[j] === v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  const n = (x.length * y.length) / (x.length + y.length);
  const sq = Math.sqrt(n);
  return { d, p: kolmogorovQ((sq + 0.12 + 0.11 / sq) * d) };
}
