import { calibrateHolds, pairOldestFirst, pairedHolds } from './holds.js';
import { ksTwoSample } from './ks.js';
import { extractMeasures } from './measures.js';
import type { RecordedEvent, Recording } from './recording.js';
import { seededRng, type Rng } from './rng.js';
import { testProfile } from './testing/profiles.js';

/**
 * A made-up typist like the author in shape: true holds right-skewed around
 * 170 ms with a long tail, in-word gaps around 60 ms, so keys overlap
 * often (the author's paired holds also run longer than their gaps).
 */
function madeUpTypist(rng: Rng) {
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - rng.next())) *
    Math.cos(2 * Math.PI * rng.next());
  const trueHolds = Array.from({ length: 600 }, () =>
    Math.round(50 + 120 * Math.exp(normal())),
  );
  const gaps = Array.from({ length: 300 }, () =>
    Math.round(35 + 140 * rng.next() ** 2.5),
  );
  return { trueHolds, gaps };
}

/** KS p of 2000 simulated paired holds drawn from `holds`, against the author's. */
function pOf(holds: number[], author: number[], gaps: number[], rng: Rng) {
  return ksTwoSample(pairedHolds(holds, gaps, rng, 2000), author).p;
}

describe('pairOldestFirst', () => {
  it('matches extractMeasures on a recording of the same keys', () => {
    const downs = [0, 100, 180, 300, 390];
    const holds = [250, 60, 140, 90, 400];
    const ev = (t: number, type: 'keydown' | 'keyup'): RecordedEvent => ({
      t,
      type,
      trusted: true,
      key: 'other',
      target: { kind: 'text' },
      ctx: { path: '/practice/', dialog: true, progress: 33 },
    });
    const events = [
      ...downs.map((d) => ev(d, 'keydown')),
      ...downs.map((d, i) => ev(d + holds[i], 'keyup')),
    ].sort((a, b) => a.t - b.t);
    const rec: Recording = {
      version: 1,
      actor: 'runner',
      source: 'practice',
      sittingId: 's',
      jobKey: 'none',
      pages: [],
      events,
    };
    const measured = extractMeasures([rec]).keyHold;
    expect(
      pairOldestFirst(
        downs,
        downs.map((d, i) => d + holds[i]),
      ),
    ).toEqual(measured);
    // The swap: the 60 ms key comes up first and is paired with the 250 ms one.
    expect(measured).not.toEqual(holds);
  });
});

describe('calibrateHolds', () => {
  it("brings the runner's paired holds under the KS pass limit where raw draws fail", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = seededRng(seed);
      const { trueHolds, gaps } = madeUpTypist(rng);
      // What the recorder read from the made-up author.
      const author = pairedHolds(trueHolds, gaps, rng, 400);
      const profile = testProfile({ keyHold: author, keyGapInWord: gaps });

      const raw = pOf(author, author, gaps, rng);
      const calibrated = pOf(calibrateHolds(profile, rng), author, gaps, rng);
      expect(raw, `seed ${seed} raw`).toBeLessThan(0.01);
      expect(calibrated, `seed ${seed} calibrated`).toBeGreaterThanOrEqual(
        0.01,
      );
    }
  });

  it('gives shorter true holds than the paired ones, and never below 1 ms', () => {
    const rng = seededRng(7);
    const { trueHolds, gaps } = madeUpTypist(rng);
    const author = pairedHolds(trueHolds, gaps, rng, 400);
    const cal = calibrateHolds(
      testProfile({ keyHold: author, keyGapInWord: gaps }),
      rng,
    );
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(median(cal)).toBeLessThan(median(author));
    expect(Math.min(...cal)).toBeGreaterThanOrEqual(1);
    expect(cal).toHaveLength(author.length);
  });
});
