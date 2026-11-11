import { readFileSync } from 'node:fs';
import type { PaceProfile } from '../profile.js';

const fixture = (): PaceProfile =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/profile.json', import.meta.url).pathname,
      'utf8',
    ),
  ) as PaceProfile;

const flat = (x: number) => [x, x, x];

/**
 * The committed fixture profile plus the samples the pace module draws from.
 * Constant samples (`flat`) make a draw exact, so tests can tell which
 * measure a delay came from.
 */
export function testProfile(
  overrides: Partial<PaceProfile['samples']> = {},
): PaceProfile {
  const p = fixture();
  p.samples = {
    ...p.samples,
    sampleInterval: [8, 12, 14, 16, 16, 17, 18, 20, 24],
    pathDeviation: [0.02, 0.05, 0.08, 0.12],
    overshootRate: [0.1, 0.2, 0.3],
    overshootDist: [6, 10, 15, 25],
    clickOffsetX: [-0.4, -0.1, 0, 0.2, 0.5],
    clickOffsetY: [-0.3, 0, 0.1, 0.4],
    hoverToPress: flat(150),
    pressRelease: flat(90),
    keyHold: flat(70),
    keyGapInWord: flat(100),
    keyGapAfterSpace: flat(300),
    wheelGap: flat(120),
    wheelBurst: flat(3),
    readDwell: flat(5000),
    fieldDwellPrefilled: flat(800),
    fieldDwellBeforeTyping: flat(500),
    afterTypingToMove: flat(400),
    pickDwell: flat(600),
    longPauseRate: flat(0),
    longPause: flat(4000),
    appSpeedFactor: flat(1),
    expandRate: flat(1),
    scrollRate: flat(0),
    ...overrides,
  };
  return p;
}

export { flat };
