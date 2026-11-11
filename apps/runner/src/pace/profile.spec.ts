import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import {
  buildProfile,
  DEFAULT_WHEEL,
  fitFitts,
  fitReading,
  loadProfile,
  sampleKde,
  wheelNotch,
} from './profile.js';
import type { Recording } from './recording.js';
import { seededRng } from './rng.js';

const fixture = (name: string): Recording =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Recording;
const app = fixture('linkedin-app-1.json');
const practice = fixture('practice-1.json');

const noNaN = (v: unknown) =>
  expect(JSON.stringify(v)).not.toMatch(/null|NaN|Infinity/);

describe('sampleKde', () => {
  it('stays within clamps and its mean is within 10% of the samples mean over 5,000 draws', () => {
    const samples = [100, 120, 140, 160, 180, 200, 220, 240];
    const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
    const rng = seededRng(7);
    let sum = 0;
    for (let i = 0; i < 5000; i++) {
      const x = sampleKde(samples, rng, { min: 90, max: 260 });
      expect(x).toBeGreaterThanOrEqual(90);
      expect(x).toBeLessThanOrEqual(260);
      sum += x;
    }
    expect(Math.abs(sum / 5000 - mean) / mean).toBeLessThan(0.1);
  });
  it('throws with fewer than 2 samples and handles identical samples', () => {
    expect(() => sampleKde([1], seededRng(1))).toThrow();
    expect(sampleKde([5, 5, 5], seededRng(1))).toBe(5);
  });
});

describe('fitFitts', () => {
  const synth = (withSize: boolean, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const distance = 50 + i * 37;
      const w = withSize ? 20 + (i % 4) * 15 : 40;
      return {
        distance,
        duration: 0,
        travel: 80 + 120 * Math.log2(distance / w + 1),
        targetSize: withSize ? w : null,
      };
    });
  it('recovers a and b from synthetic data within 5%', () => {
    const f = fitFitts(synth(true, 40));
    expect(Math.abs(f.a - 80) / 80).toBeLessThan(0.05);
    expect(Math.abs(f.b - 120) / 120).toBeLessThan(0.05);
    expect(f.wFixed).toBeUndefined();
    expect(f.residuals).toHaveLength(40);
  });
  it('falls back to a fixed W of 40 with fewer than 10 sized moves', () => {
    const moves = [...synth(false, 30), ...synth(true, 5)];
    const f = fitFitts(moves);
    expect(f.wFixed).toBe(40);
    expect(f.residuals).toHaveLength(35);
    expect(f.b).toBeGreaterThan(0);
  });
  it('has no NaN or Infinity for W = 0, D = 0 or all-equal x', () => {
    const bad = [
      { distance: 0, duration: 0, travel: 50, targetSize: 30 },
      { distance: 100, duration: 0, travel: 90, targetSize: 0 },
      { distance: Infinity, duration: 0, travel: 90, targetSize: 30 },
    ];
    noNaN(fitFitts(bad));
    noNaN(fitFitts([]));
    const same = Array.from({ length: 12 }, (_, i) => ({
      distance: 100,
      duration: 0,
      travel: 100 + i,
      targetSize: 40,
    }));
    const f = fitFitts(same);
    expect(f.b).toBe(0);
    noNaN(f);
  });
});

describe('fitReading', () => {
  it('recovers base and perChar and is null without lengths', () => {
    const pts = [500, 1000, 2000, 3000].map((chars) => ({
      chars,
      dwell: 2000 + 3 * chars,
    }));
    const r = fitReading(pts)!;
    expect(r.base).toBeCloseTo(2000);
    expect(r.perChar).toBeCloseTo(3);
    expect(fitReading([{ chars: null, dwell: 4000 }])).toBeNull();
  });
});

describe('wheelNotch', () => {
  it('is the mode of deltaY', () => {
    const w = [100, 100, 120, 100, 53].map((deltaY) => ({
      deltaY,
      deltaMode: 0,
    }));
    expect(wheelNotch(w)).toEqual({ deltaY: 100, deltaMode: 0 });
    expect(
      wheelNotch([
        { deltaY: 3, deltaMode: 1 },
        { deltaY: 3, deltaMode: 1 },
        { deltaY: 7, deltaMode: 0 },
      ]),
    ).toEqual({ deltaY: 3, deltaMode: 1 });
  });
  it('defaults to deltaY 100, deltaMode 0 with no wheel events', () => {
    expect(wheelNotch([])).toEqual({ deltaY: 100, deltaMode: 0 });
    expect(DEFAULT_WHEEL).toEqual({ deltaY: 100, deltaMode: 0 });
  });
});

describe('buildProfile', () => {
  it('build without description lengths: reading is null and nothing throws', () => {
    const noDesc: Recording = {
      ...app,
      pages: app.pages.map((p) => ({ ...p, desc: null })),
    };
    const p = buildProfile([noDesc]);
    expect(p.reading).toBeNull();
    expect(p.sources.applications).toBe(1);
    noNaN(p.fitts);
  });
  it('practice recordings never feed samples', () => {
    const p = buildProfile([app, practice]);
    const only = buildProfile([app]);
    expect(p.samples).toEqual(only.samples);
    expect(p.fitts).toEqual(only.fitts);
    expect(p.sources.practice).toBe(1);
    expect(
      p.practice.stepTime.length + p.practice.appTime.length,
    ).toBeGreaterThan(0);
  });
  it('typing recordings feed key measures', () => {
    const typing: Recording = { ...app, source: 'typing' };
    const p = buildProfile([typing]);
    expect(p.samples.keyHold?.length).toBeGreaterThan(0);
    expect(p.sources.applications).toBe(0);
  });
});

describe('loadProfile', () => {
  it('loads the made-up fixture', () => {
    const p = loadProfile(
      new URL('./fixtures/profile.json', import.meta.url).pathname,
    );
    expect(p.version).toBe(1);
    expect(p.fitts.b).toBeGreaterThan(0);
  });
  it('throws ConfigError when missing', () => {
    expect(() => loadProfile(join('/nonexistent', 'profile.json'))).toThrow(
      ConfigError,
    );
  });
});
