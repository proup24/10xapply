import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cryptoRng, seededRng } from './rng.js';

describe('rng', () => {
  it('seededRng is repeatable and cryptoRng is not seeded', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b.next()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRng(43).next()).not.toBe(xs[0]);
    expect(cryptoRng.length).toBe(0);
    const src = readFileSync(new URL('./rng.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/export function cryptoRng\(\): Rng/);
    const c = cryptoRng().next();
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(1);
  });
});
