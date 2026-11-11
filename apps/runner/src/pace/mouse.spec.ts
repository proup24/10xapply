import { OVERSHOOT_PX } from './measures.js';
import { planPath, type Box, type Pt } from './mouse.js';
import { seededRng } from './rng.js';
import { testProfile } from './testing/profiles.js';

const profile = testProfile();

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Largest sideways distance and furthest progress along from → end. */
function shape(from: Pt, end: Pt, points: Pt[]) {
  const dx = end.x - from.x;
  const dy = end.y - from.y;
  const d = Math.hypot(dx, dy);
  let side = 0;
  let along = -Infinity;
  for (const p of points) {
    const px = p.x - from.x;
    const py = p.y - from.y;
    side = Math.max(side, Math.abs(dx * py - dy * px) / d);
    along = Math.max(along, (dx * px + dy * py) / d);
  }
  return { d, side, overshoot: along - d > OVERSHOOT_PX };
}

function randomCase(rng: ReturnType<typeof seededRng>): {
  from: Pt;
  box: Box;
} {
  const from = { x: rng.next() * 300, y: rng.next() * 300 };
  const box = {
    x: 500 + rng.next() * 700,
    y: 300 + rng.next() * 400,
    width: 20 + rng.next() * 200,
    height: 20 + rng.next() * 60,
  };
  return { from, box };
}

describe('planPath', () => {
  it('path ends inside the box', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 300; i++) {
      const { from, box } = randomCase(rng);
      const { points, end } = planPath(from, box, profile, rng);
      const last = points[points.length - 1];
      expect(last.x).toBe(end.x);
      expect(last.y).toBe(end.y);
      expect(end.x).toBeGreaterThanOrEqual(box.x);
      expect(end.x).toBeLessThan(box.x + box.width);
      expect(end.y).toBeGreaterThanOrEqual(box.y);
      expect(end.y).toBeLessThan(box.y + box.height);
    }
  });

  it('no straight lines', () => {
    const rng = seededRng(2);
    let curved = 0;
    for (let i = 0; i < 200; i++) {
      const { from, box } = randomCase(rng);
      const { points, end } = planPath(from, box, profile, rng);
      const s = shape(from, end, points);
      expect(s.d).toBeGreaterThan(200);
      if (s.side > 0) curved++;
    }
    expect(curved / 200).toBeGreaterThanOrEqual(0.95);
  });

  it('overshoot rate within ±0.05 of profile.overshootRate mean over 1,000 paths', () => {
    const rng = seededRng(3);
    let n = 0;
    for (let i = 0; i < 1000; i++) {
      const { from, box } = randomCase(rng);
      const { points, end } = planPath(from, box, profile, rng);
      if (shape(from, end, points).overshoot) n++;
    }
    expect(Math.abs(n / 1000 - 0.2)).toBeLessThanOrEqual(0.05);
  });

  it('duration follows fitts within the residual range', () => {
    const rng = seededRng(4);
    const { a, b, residuals } = profile.fitts;
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const { from, box } = randomCase(rng);
      const { points, end } = planPath(from, box, profile, rng);
      const s = shape(from, end, points);
      if (s.overshoot) continue;
      const w = Math.min(box.width, box.height);
      const predicted = a + b * Math.log2(s.d / w + 1);
      const travel = points[points.length - 1].at;
      // Rounding the end point to whole pixels moves D by under a pixel.
      expect(travel - predicted).toBeGreaterThanOrEqual(
        Math.min(...residuals) - 1,
      );
      expect(travel - predicted).toBeLessThanOrEqual(
        Math.max(...residuals) + 1,
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('uses wFixed for W when the profile has it', () => {
    const p = testProfile({ overshootRate: [0, 0, 0] });
    p.fitts = { a: 100, b: 100, residuals: [0, 0], wFixed: 40 };
    const from = { x: 0, y: 0 };
    const box = { x: 630, y: 0, width: 20, height: 1 };
    const { points, end } = planPath(from, box, p, seededRng(5));
    const d = Math.hypot(end.x, end.y);
    const at = points[points.length - 1].at;
    expect(at).toBeCloseTo(100 + 100 * Math.log2(d / 40 + 1), 0);
  });

  it('a negative or zero fit still gives a positive duration', () => {
    const p = testProfile();
    p.fitts = { a: -50, b: -10, residuals: [0, 0] };
    const { points } = planPath(
      { x: 0, y: 0 },
      { x: 400, y: 400, width: 30, height: 30 },
      p,
      seededRng(6),
    );
    expect(points[points.length - 1].at).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].at).toBeGreaterThan(points[i - 1].at);
    }
  });

  it('point gaps are drawn from sampleInterval', () => {
    const rng = seededRng(7);
    const gaps: number[] = [];
    for (let i = 0; i < 200; i++) {
      const { from, box } = randomCase(rng);
      const { points } = planPath(from, box, profile, rng);
      // The last gap is cut short by the end of the move.
      for (let j = 1; j < points.length - 1; j++) {
        gaps.push(points[j].at - points[j - 1].at);
      }
    }
    const want = median(profile.samples.sampleInterval ?? []);
    expect(Math.abs(median(gaps) - want) / want).toBeLessThanOrEqual(0.15);
  });

  it('two seeds give different paths', () => {
    const from = { x: 10, y: 10 };
    const box = { x: 600, y: 400, width: 80, height: 30 };
    const p1 = planPath(from, box, profile, seededRng(8));
    const p2 = planPath(from, box, profile, seededRng(9));
    expect(p1.points).not.toEqual(p2.points);
  });
});
