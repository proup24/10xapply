import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractMeasures, MEASURE_NAMES, MINIMUMS } from './measures.js';
import type { RecordedEvent, Recording } from './recording.js';

const fixture = (name: string): Recording =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Recording;

const app = fixture('linkedin-app-1.json');
const practice = fixture('practice-1.json');

// Values below are worked out by hand from the made-up fixture's timeline.
describe('extractMeasures on the made-up LinkedIn application', () => {
  const m = extractMeasures([app]);

  it('has every measure name', () => {
    expect(Object.keys(m).sort()).toEqual([...MEASURE_NAMES, 'models'].sort());
  });

  it("pressRelease equals each click's mouseup.t - mousedown.t", () => {
    expect(m.pressRelease).toEqual([80, 90, 70, 60, 80, 50, 70, 80]);
  });

  it('keyGapAfterSpace takes only the gap after a space keydown', () => {
    expect(m.keyGapAfterSpace).toEqual([250]);
    expect(m.keyGapInWord).toEqual([200, 150]);
    expect(m.keyGapAroundBackspace).toEqual([150, 200]);
    expect(m.keyHold).toEqual([80, 70, 70, 60, 50, 60]);
  });

  it('moveDuration runs from movement start to pointerdown, moveDistance in CSS px', () => {
    expect(m.moveDuration).toEqual([160, 200, 160, 140, 100, 100, 140, 140]);
    expect(m.moveDistance).toEqual([100, 100, 100, 100, 40, 100, 100, 100]);
    expect(m.hoverToPress).toEqual([100, 140, 100, 100, 60, 60, 100, 100]);
    expect(m.models.moves[1]).toEqual({
      distance: 100,
      duration: 200,
      travel: 60,
      targetSize: 40,
    });
  });

  it('travel runs from movement start to the last pointermove before the press', () => {
    expect(m.models.moves.map((mv) => mv.travel)).toEqual([
      60, 60, 60, 40, 40, 40, 40, 40,
    ]);
  });

  it('overshootRate is the share of moves passing the end by more than 3 px', () => {
    expect(m.overshootRate).toEqual([1 / 8]);
    expect(m.overshootDist).toEqual([6]);
  });

  it('pathDeviation is the largest sideways distance over the move length', () => {
    expect(m.pathDeviation).toEqual([0.04, 0.02, 0, 0, 0.25, 0, 0, 0]);
  });

  it('sampleInterval and zeroMovementShare come from pointermoves', () => {
    expect(m.sampleInterval).toHaveLength(18);
    expect(m.sampleInterval.filter((g) => g === 30)).toHaveLength(2);
    expect(m.zeroMovementShare).toEqual([9 / 27]);
  });

  it('readDwell runs from the first description event to the Apply pointerdown, paired with desc.chars', () => {
    expect(m.readDwell).toEqual([4200]);
    expect(m.readChars).toEqual([2400]);
    expect(m.models.reading).toEqual([{ chars: 2400, dwell: 4200 }]);
    expect(m.expandRate).toEqual([1]);
    expect(m.scrollRate).toEqual([1]);
    expect(m.pageToFirstAction).toEqual([1160]);
  });

  it('wheel gaps, bursts and deltas', () => {
    expect(m.wheelGap).toEqual([120, 140, 100]);
    expect(m.wheelBurst).toEqual([3, 2]);
    expect(m.wheelDelta).toEqual([100, 100, 100, 100, 100]);
    expect(m.models.wheel).toHaveLength(5);
    expect(m.models.wheel[0]).toEqual({ deltaY: 100, deltaMode: 0 });
  });

  it('field dwells', () => {
    expect(m.fieldDwellBeforeTyping).toEqual([840]);
    expect(m.afterTypingToMove).toEqual([490]);
    expect(m.fieldDwellPrefilled).toEqual([800]);
    expect(m.pickDwell).toEqual([900]);
  });

  it('step and application times, long pauses, speed factor', () => {
    expect(m.stepTime).toEqual([3440, 2900]);
    expect(m.appTime).toEqual([9940]);
    expect(m.longPause).toEqual([3390]);
    expect(m.longPauseRate).toEqual([1 / 6]);
    expect(m.appSpeedFactor).toEqual([1]);
  });

  it('moveTargetSize is min(w, h) of the pressed target', () => {
    expect(m.moveTargetSize).toEqual([32, 40, 36, 32, 36, 36, 32, 40]);
    expect(m.models.moves.map((mv) => mv.targetSize)).toEqual([
      32, 40, 36, 32, 36, 36, 32, 40,
    ]);
  });

  it('clickOffset is the press offset from the centre over half-size', () => {
    const near = (xs: number[], want: number[]) => {
      expect(xs).toHaveLength(want.length);
      xs.forEach((x, i) => expect(x).toBeCloseTo(want[i], 9));
    };
    near(m.clickOffsetX, [0, 0.5, -0.8, 0, -0.5, 0.8, 0.2, 0]);
    near(m.clickOffsetY, [0, -0.5, 0.2, 0.5, 0, -0.2, 0, 0]);
  });
});

describe('extractMeasures, other cases', () => {
  it('practice steps 33/66/83 give three step times', () => {
    const m = extractMeasures([practice]);
    expect(m.stepTime).toEqual([3000, 3000, 5000]);
    expect(m.appTime).toEqual([13000]);
  });

  it('appSpeedFactor is each application median move over the median of all', () => {
    const slow: Recording = {
      ...app,
      jobKey: 'slow',
      events: app.events.map((e) =>
        // Doubles every gap from the first event: all moves take twice as long.
        ({ ...e, t: 2 * e.t }),
      ),
      pages: app.pages.map((p) => ({ ...p, t: 2 * p.t })),
    };
    const m = extractMeasures([app, slow]);
    // Medians 140 and 280; their median is 210.
    expect(m.appSpeedFactor).toEqual([140 / 210, 280 / 210]);
  });

  it('recordings without boxes skip target size and click offset', () => {
    const old: Recording = {
      ...app,
      events: app.events.map((e): RecordedEvent => {
        const copy = { ...e, target: { ...e.target } };
        delete copy.ox;
        delete copy.oy;
        delete copy.target.w;
        delete copy.target.h;
        return copy;
      }),
    };
    const m = extractMeasures([old]);
    expect(m.moveTargetSize).toEqual([]);
    expect(m.clickOffsetX).toEqual([]);
    expect(m.clickOffsetY).toEqual([]);
    expect(m.models.moves[0].targetSize).toBeNull();
    expect(m.moveDuration).toHaveLength(8);
  });

  it('an orphan keydown before a press never shifts later key holds', () => {
    const orphan: RecordedEvent = {
      t: 8100,
      type: 'keydown',
      trusted: true,
      key: 'other',
      target: { kind: 'text' },
      ctx: { path: '/jobs/view/:id/', dialog: true, progress: 33 },
    };
    const m = extractMeasures([{ ...app, events: [...app.events, orphan] }]);
    expect(m.keyHold).toEqual([80, 70, 70, 60, 50, 60]);
  });

  it('a stale keydown (lost keyup) is dropped before pairing', () => {
    const key = (t: number, type: 'keydown' | 'keyup'): RecordedEvent => ({
      t,
      type,
      trusted: true,
      key: 'other',
      target: { kind: 'textarea' },
      ctx: { path: '/typing/', dialog: false, progress: null },
    });
    const typing: Recording = {
      ...app,
      source: 'typing',
      pages: [],
      events: [key(0, 'keydown'), key(3000, 'keydown'), key(3080, 'keyup')],
    };
    expect(extractMeasures([typing]).keyHold).toEqual([80]);
  });

  it('zeroMovementShare ignores pointermoves without movement fields', () => {
    const extra: RecordedEvent[] = app.events
      .filter((e) => e.type === 'pointermove')
      .map((e) => {
        const copy = { ...e, t: e.t + 1 };
        delete copy.mx;
        delete copy.my;
        return copy;
      });
    const m = extractMeasures([{ ...app, events: [...app.events, ...extra] }]);
    expect(m.zeroMovementShare).toEqual([9 / 27]);
  });

  it('untrusted events are ignored', () => {
    const fake: Recording = {
      ...app,
      events: app.events.map((e): RecordedEvent => ({ ...e, trusted: false })),
    };
    const m = extractMeasures([fake]);
    expect(m.pressRelease).toEqual([]);
    expect(m.moveDuration).toEqual([]);
  });

  it('typing recordings feed only key measures', () => {
    const typing: Recording = { ...app, source: 'typing' };
    const m = extractMeasures([typing]);
    expect(m.keyGapInWord).toEqual([200, 150]);
    expect(m.moveDuration).toEqual([]);
    expect(m.fieldDwellBeforeTyping).toEqual([]);
    expect(m.appTime).toEqual([]);
  });

  it('a page without a description never pairs readChars', () => {
    const noDesc: Recording = {
      ...app,
      pages: app.pages.map((p) => ({ ...p, desc: null })),
    };
    const m = extractMeasures([noDesc]);
    expect(m.readChars).toEqual([]);
    expect(m.expandRate).toEqual([0]);
  });

  it('MINIMUMS are the planned values', () => {
    expect(MINIMUMS).toEqual({
      readDwell: 8,
      moveDuration: 60,
      pressRelease: 60,
      keyGapInWord: 300,
      keyGapAfterSpace: 40,
      wheelGap: 100,
      fieldDwellBeforeTyping: 10,
      appTime: 5,
    });
  });
});
