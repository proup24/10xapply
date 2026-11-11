import {
  growthTime,
  isApplication,
  phaseContext,
  phaseOf,
  REVIEW_PROGRESS,
  sortedEvents,
} from './phases.js';
import type { PageInfo, RecordedEvent, Recording } from './recording.js';

export const MEASURE_NAMES = [
  'pageToFirstAction',
  // readDwell: first description event to Apply's press; with no description
  // events (LinkedIn's newer layout), the job's first event to Apply's press.
  'readDwell',
  'readChars',
  'expandRate',
  'scrollRate',
  'wheelGap',
  'wheelBurst',
  'wheelDelta',
  'moveDuration',
  'moveDistance',
  'moveTargetSize',
  'pathDeviation',
  'overshootRate',
  'overshootDist',
  'sampleInterval',
  'zeroMovementShare',
  'hoverToPress',
  'pressRelease',
  'clickOffsetX',
  'clickOffsetY',
  'keyHold',
  'keyGapInWord',
  'keyGapAfterSpace',
  'keyGapAroundBackspace',
  'fieldDwellPrefilled',
  'fieldDwellBeforeTyping',
  'afterTypingToMove',
  'pickDwell',
  'stepTime',
  'appTime',
  'longPauseRate',
  'longPause',
  'appSpeedFactor',
] as const;
export type MeasureName = (typeof MEASURE_NAMES)[number];

/** One move, for the Fitts fit. */
export interface MoveSample {
  distance: number;
  /** Movement start → pointerdown (the same as `moveDuration`). */
  duration: number;
  /** Movement start → the last pointermove at or before the pointerdown. */
  travel: number;
  /** min(w, h) of the pressed target, or null in recordings without boxes. */
  targetSize: number | null;
}
/** Inputs for the models `pace build` fits, kept paired. */
export interface Models {
  moves: MoveSample[];
  /** One per application read; `chars` is null when the description wasn't measured. */
  reading: { chars: number | null; dwell: number }[];
  wheel: { deltaY: number; deltaMode: number }[];
}
export type Measures = Record<MeasureName, number[]> & { models: Models };

/**
 * How many samples each measure needs before a profile is worth building.
 * The reasoning is in the plan (Task 6).
 */
export const MINIMUMS: Partial<Record<MeasureName, number>> = {
  readDwell: 8,
  moveDuration: 60,
  pressRelease: 60,
  keyGapInWord: 300,
  keyGapAfterSpace: 40,
  wheelGap: 100,
  fieldDwellBeforeTyping: 10,
  appTime: 5,
};
/** Practice applications count separately: 3 applications × 3 steps. */
export const PRACTICE_MINIMUMS: Partial<Record<MeasureName, number>> = {
  stepTime: 9,
};
/** Measures the typing page can top up. */
export const KEY_MEASURES: readonly MeasureName[] = [
  'keyHold',
  'keyGapInWord',
  'keyGapAfterSpace',
  'keyGapAroundBackspace',
];
/** A move starts after at least this long with no pointermove. */
export const STILL_MS = 150;
/** A move overshoots when it passes its end point by more than this. */
export const OVERSHOOT_PX = 3;
/** Wheel events closer than this belong to one burst. */
export const WHEEL_BURST_GAP_MS = 1000;
/** Longer gaps between keydowns are pauses, not typing rhythm. */
export const KEY_GAP_MAX_MS = 2000;
/** Longer holds are a held key, not a keystroke. */
export const KEY_HOLD_MAX_MS = 2000;
/** An idle gap inside the form at least this long is a long pause. */
export const LONG_PAUSE_MS = 3000;

const FIELD_KINDS = new Set(['text', 'textarea', 'number']);

interface Move {
  points: RecordedEvent[];
  down: RecordedEvent;
}

function empty(): Measures {
  const m = {} as Record<MeasureName, number[]>;
  for (const n of MEASURE_NAMES) m[n] = [];
  return { ...m, models: { moves: [], reading: [], wheel: [] } };
}

const isMouse = (e: RecordedEvent) =>
  e.pointerType === 'mouse' && e.x !== undefined && e.y !== undefined;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Splits pointermoves into moves: a move starts at the first pointermove
 * after ≥ STILL_MS with none, and ends at the next pointerdown. Also returns
 * every movement start, including those that end without a press.
 */
function segmentMoves(events: RecordedEvent[]): {
  moves: Move[];
  starts: number[];
} {
  const moves: Move[] = [];
  const starts: number[] = [];
  let seg: RecordedEvent[] | null = null;
  let lastMove: number | null = null;
  for (const e of events) {
    if (!isMouse(e)) continue;
    if (e.type === 'pointermove') {
      if (lastMove === null || e.t - lastMove >= STILL_MS) {
        seg = [e];
        starts.push(e.t);
      } else seg?.push(e);
      lastMove = e.t;
    } else if (e.type === 'pointerdown') {
      if (seg) moves.push({ points: seg, down: e });
      seg = null;
    }
  }
  return { moves, starts };
}

/** Distance, timing and shape of each move, in CSS pixels (client x/y). */
function measureMoves(moves: Move[], m: Measures): number {
  let overshoots = 0;
  for (const { points, down } of moves) {
    const s = points[0];
    const sx = s.x ?? 0;
    const sy = s.y ?? 0;
    const dx = (down.x ?? 0) - sx;
    const dy = (down.y ?? 0) - sy;
    const distance = Math.hypot(dx, dy);
    const duration = down.t - s.t;
    m.moveDuration.push(duration);
    m.moveDistance.push(distance);
    const lastPoint = points[points.length - 1];
    const { w, h } = down.target;
    const targetSize =
      w !== undefined && h !== undefined ? Math.min(w, h) : null;
    if (targetSize !== null) m.moveTargetSize.push(targetSize);
    m.models.moves.push({
      distance,
      duration,
      travel: lastPoint.t - s.t,
      targetSize,
    });
    m.hoverToPress.push(down.t - lastPoint.t);
    for (let i = 1; i < points.length; i++) {
      m.sampleInterval.push(points[i].t - points[i - 1].t);
    }
    if (distance === 0) continue;
    let side = 0;
    let along = -Infinity;
    for (const p of points) {
      const px = (p.x ?? 0) - sx;
      const py = (p.y ?? 0) - sy;
      side = Math.max(side, Math.abs(dx * py - dy * px) / distance);
      along = Math.max(along, (dx * px + dy * py) / distance);
    }
    m.pathDeviation.push(side / distance);
    if (along - distance > OVERSHOOT_PX) {
      overshoots++;
      m.overshootDist.push(along - distance);
    }
  }
  return overshoots;
}

/** Press-to-release of each click: mouseup.t − mousedown.t. */
function measurePresses(events: RecordedEvent[], m: Measures): void {
  let down: RecordedEvent | null = null;
  let up: RecordedEvent | null = null;
  for (const e of events) {
    if (
      e.type === 'pointerdown' &&
      isMouse(e) &&
      e.ox !== undefined &&
      e.oy !== undefined
    ) {
      // Offset from the box centre, normalised by half-size.
      m.clickOffsetX.push((e.ox - 0.5) / 0.5);
      m.clickOffsetY.push((e.oy - 0.5) / 0.5);
    }
    if (e.type === 'mousedown') [down, up] = [e, null];
    else if (e.type === 'mouseup') up = e;
    else if (e.type === 'click' && down && up && up.t >= down.t) {
      m.pressRelease.push(up.t - down.t);
      [down, up] = [null, null];
    }
  }
}

/** Key holds and gaps; a gap never spans a focus change or a press. */
function measureKeys(events: RecordedEvent[], m: Measures): void {
  // Open keydowns, oldest first. Cleared on a focus change or press, and
  // stale entries dropped, so a lost keyup never shifts later pairs.
  let held: RecordedEvent[] = [];
  let prev: RecordedEvent | null = null;
  for (const e of events) {
    if (e.type === 'focusin' || e.type === 'pointerdown') {
      prev = null;
      held = [];
    } else if (e.type === 'keyup') {
      held = held.filter((d) => e.t - d.t <= KEY_HOLD_MAX_MS);
      const d = held.shift();
      if (d) m.keyHold.push(e.t - d.t);
    } else if (e.type === 'keydown') {
      held.push(e);
      if (prev && e.t - prev.t <= KEY_GAP_MAX_MS) {
        const gap = e.t - prev.t;
        if (prev.key === 'backspace' || e.key === 'backspace') {
          m.keyGapAroundBackspace.push(gap);
        } else if (prev.key === 'space') m.keyGapAfterSpace.push(gap);
        else m.keyGapInWord.push(gap);
      }
      prev = e;
    }
  }
}

/** Wheel rhythm: gaps inside a burst, events per burst, and the deltas. */
function measureWheel(events: RecordedEvent[], m: Measures): void {
  let last: number | null = null;
  let burst = 0;
  for (const e of events) {
    if (e.type !== 'wheel' || e.dy === undefined) continue;
    m.wheelDelta.push(e.dy);
    m.models.wheel.push({ deltaY: e.dy, deltaMode: e.dm ?? 0 });
    if (last !== null && e.t - last < WHEEL_BURST_GAP_MS) {
      m.wheelGap.push(e.t - last);
      burst++;
    } else {
      if (burst > 0) m.wheelBurst.push(burst);
      burst = 1;
    }
    last = e.t;
  }
  if (burst > 0) m.wheelBurst.push(burst);
}

/** Dwell around fields: prefilled checks, before and after typing, picks. */
function measureFields(
  events: RecordedEvent[],
  starts: number[],
  m: Measures,
): void {
  const nextStart = (t: number) => starts.find((s) => s > t);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'change' && e.target.kind === 'select') {
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].type !== 'pointerdown') continue;
        if (events[j].target.kind === 'select') {
          m.pickDwell.push(e.t - events[j].t);
        }
        break;
      }
    }
    if (e.type !== 'focusin' || !FIELD_KINDS.has(e.target.kind)) continue;
    let firstKey: RecordedEvent | null = null;
    let lastKey: RecordedEvent | null = null;
    let leave: number | null = null;
    for (let j = i + 1; j < events.length; j++) {
      const f = events[j];
      if (f.type === 'pointerdown' || f.type === 'focusin') {
        leave = f.t;
        break;
      }
      if (f.type === 'keydown' || f.type === 'keyup') {
        firstKey ??= f;
        lastKey = f;
      }
    }
    if (firstKey && lastKey) {
      m.fieldDwellBeforeTyping.push(firstKey.t - e.t);
      const moved = nextStart(lastKey.t);
      if (moved !== undefined && (leave === null || moved < leave)) {
        m.afterTypingToMove.push(moved - lastKey.t);
      }
    } else if (e.target.hasValue) {
      const moved = nextStart(e.t);
      if (moved !== undefined) m.fieldDwellPrefilled.push(moved - e.t);
    }
  }
}

/** For each path, from its first page record to the first press, wheel or key. */
function measurePageStart(
  pages: PageInfo[],
  events: RecordedEvent[],
  m: Measures,
): void {
  const seen = new Set<string>();
  for (const p of [...pages].sort((a, b) => a.t - b.t)) {
    if (seen.has(p.ctx.path)) continue;
    seen.add(p.ctx.path);
    const act = events.find(
      (e) =>
        e.t >= p.t &&
        e.ctx.path === p.ctx.path &&
        (e.type === 'pointerdown' ||
          e.type === 'wheel' ||
          e.type === 'keydown'),
    );
    if (act) m.pageToFirstAction.push(act.t - p.t);
  }
}

/** Reading, steps, whole-application time and pauses of one application. */
function measureApplication(
  rec: Recording,
  events: RecordedEvent[],
  m: Measures,
): void {
  const context = phaseContext(events);
  const first = events.findIndex((e) => e.ctx.progress !== null);
  const lastPressBefore = (idx: number) => {
    for (let j = idx - 1; j >= 0; j--) {
      if (events[j].type === 'pointerdown') return events[j];
    }
    return undefined;
  };
  const applyDown = lastPressBefore(first);
  const applyT =
    applyDown && applyDown.ctx.progress === null
      ? applyDown.t
      : events[first].t;

  // Reading: from the first description-phase event to Apply's press. A
  // layout with no description element has no such events; then it runs from
  // the job's first recorded event instead, and `chars` stays null.
  const firstRead =
    events.find(
      (e) =>
        e.t < applyT && phaseOf(e, rec.pages, context).phase === 'description',
    ) ?? (events[0] && events[0].t < applyT ? events[0] : undefined);
  if (firstRead) {
    const dwell = applyT - firstRead.t;
    const page = [...rec.pages]
      .filter((p) => p.desc && p.t <= applyT)
      .sort((a, b) => a.t - b.t)
      .pop();
    const chars = page?.desc?.chars ?? null;
    m.readDwell.push(dwell);
    if (chars !== null) m.readChars.push(chars);
    m.models.reading.push({ chars, dwell });
  }
  const grown = growthTime(rec.pages, events[first].ctx.path);
  m.expandRate.push(grown !== null && grown < applyT ? 1 : 0);
  m.scrollRate.push(
    events.some((e) => e.type === 'wheel' && e.t < applyT) ? 1 : 0,
  );

  // Steps: each runs from the press that opened it to the press that left it.
  let current = events[first].ctx.progress;
  let stepStart = applyT;
  for (let i = first + 1; i < events.length; i++) {
    const p = events[i].ctx.progress;
    if (p === null || p === current) continue;
    const down = lastPressBefore(i);
    const boundary =
      down && down.t >= stepStart ? down.t : Math.max(events[i].t, stepStart);
    if (current !== REVIEW_PROGRESS) m.stepTime.push(boundary - stepStart);
    stepStart = boundary;
    current = p;
  }

  const end = context.submitAt ?? events[events.length - 1].t;
  if (context.submitAt !== null) m.appTime.push(context.submitAt - applyT);

  // Long pauses: idle gaps inside the form, per press made there.
  let pauses = 0;
  let presses = 0;
  let prev: number | null = null;
  for (const e of events) {
    if (e.t < applyT || e.t > end || e.type === 'scroll') continue;
    if (prev !== null && e.t - prev >= LONG_PAUSE_MS) {
      m.longPause.push(e.t - prev);
      pauses++;
    }
    if (e.type === 'pointerdown' && e.t > applyT) presses++;
    prev = e.t;
  }
  if (presses > 0) m.longPauseRate.push(pauses / presses);
}

/**
 * Turns recordings into named samples. Only trusted events count. Typing-page
 * recordings feed the key measures only; application-level measures and
 * rates come one per application (a recording with an Easy Apply dialog).
 */
export function extractMeasures(recs: Recording[]): Measures {
  const m = empty();
  const appMoves: number[][] = [];
  for (const rec of recs) {
    const events = sortedEvents(rec).filter((e) => e.trusted);
    measureKeys(events, m);
    if (rec.source === 'typing') continue;

    const { moves, starts } = segmentMoves(events);
    const overshoots = measureMoves(moves, m);
    measurePresses(events, m);
    measureWheel(events, m);
    measureFields(events, starts, m);
    measurePageStart(rec.pages, events, m);

    if (!isApplication({ ...rec, events })) continue;
    measureApplication(rec, events, m);
    if (moves.length > 0) {
      m.overshootRate.push(overshoots / moves.length);
      appMoves.push(moves.map((mv) => mv.down.t - mv.points[0].t));
    }
    // Only pointermoves that report movement count, either way.
    const pointerMoves = events.filter(
      (e) =>
        e.type === 'pointermove' &&
        isMouse(e) &&
        e.mx !== undefined &&
        e.my !== undefined,
    );
    if (pointerMoves.length > 0) {
      const still = pointerMoves.filter((e) => e.mx === 0 && e.my === 0).length;
      m.zeroMovementShare.push(still / pointerMoves.length);
    }
  }
  if (appMoves.length > 0) {
    const medians = appMoves.map(median);
    const typical = median(medians);
    for (const d of medians) m.appSpeedFactor.push(d / typical);
  }
  return m;
}
