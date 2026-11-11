import { randomFillSync } from 'node:crypto';

export interface Rng {
  /** A number in [0, 1). */
  next(): number;
}

/** The runner's source of randomness. It takes no seed, on purpose. */
export function cryptoRng(): Rng {
  const buf = new Uint32Array(1);
  return {
    next() {
      randomFillSync(buf);
      return buf[0] / 0x1_0000_0000;
    },
  };
}

/** mulberry32. For tests only: the runner never seeds randomness. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
