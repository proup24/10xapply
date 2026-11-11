import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'patchright-core';
import { DEFAULTS, draw, isDefaulted, rate, samplesOf } from './defaults.js';
import { WHEEL_BURST_GAP_MS, type MeasureName } from './measures.js';
import { planPath, type Box, type Pt, type TimedPt } from './mouse.js';
import { sampleKde, type PaceProfile } from './profile.js';
import { cryptoRng, type Rng } from './rng.js';
import { planKeys } from './typing.js';

export type Optional =
  'expand-description' | 'scroll-description' | 'idle-move';

export interface Pace {
  /** This run's pace factor; dwell, read and pause times are multiplied by it. */
  readonly mood: number;
  /** Measures drawn from DEFAULTS because the profile had fewer than 2 samples. */
  readonly defaulted: readonly MeasureName[];
  click(target: Locator): Promise<void>;
  /** Clicks the field first. Never sends Tab or Enter. */
  type(field: Locator, text: string): Promise<void>;
  /** A prefilled field: move onto it, dwell, no typing. */
  glance(field: Locator): Promise<void>;
  /**
   * A `<select>` (by option index: click to open, then arrow keys and Enter
   * in the open list) or a radio group (the nth radio's label).
   */
  pick(control: Locator, index: number): Promise<void>;
  /**
   * Clicks the button inside `deps.uploadOnChooser`, dwells as if in the
   * file dialog, and has it set `filePath` (a path where Chrome runs) on the
   * chooser's input.
   */
  upload(button: Locator, filePath: string): Promise<void>;
  /** Wheel notches over `area`; negative notches scroll up. */
  scroll(area: Locator, notches?: number): Promise<void>;
  /** Dwell for a text of `chars` characters, or a plain read when unknown. */
  read(chars: number | null): Promise<void>;
  /** Between actions, with an occasional long pause. */
  pause(): Promise<void>;
  maybe(action: Optional): boolean;
}

/** The mood is clamped to this range, whatever the author's spread. */
const MOOD_MIN = 0.5;
const MOOD_MAX = 2;
/** The target's box is read again once this share of the travel time has passed. */
const APPROACH_AT = 0.7;
/**
 * How often `maybe('idle-move')` says yes. The recordings have no idle-move
 * measure, so this is a fixed guess: about one action in four.
 */
export const IDLE_MOVE_RATE = 0.25;
/** Reading never takes less than this. */
const READ_MIN_MS = 1000;
/** Reading never takes more than this many times the longest plain read. */
const READ_MAX_FACTOR = 2;
/** CSS px per line and per page when the author's wheel reports lines or pages. */
const WHEEL_LINE_PX = 40;
/** At most this many wheel notches to bring an off-screen target into view. */
const REVEAL_MAX_NOTCHES = 40;
/** Scrolling gives up after this many bursts in a row that moved nothing. */
const REVEAL_MAX_STUCK = 2;
/** Wait after a burst for smooth scrolling to settle before re-reading the box. */
const SCROLL_SETTLE_MS = 300;
/** A revealed target sits at least this share of the window from its edge. */
const REVEAL_MARGIN = 0.15;
/** The `<select>` options after the checked one (plain CSS, no script). */
const AFTER_CHECKED = 'option:checked ~ option';
/** Characters a US keyboard types with Shift held. */
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
/** Shift goes down this share of a keyGapInWord draw before its key. */
const SHIFT_LEAD_SHARE = 0.5;
/** Shift comes up this share of a keyHold draw after its last key's release. */
const SHIFT_TRAIL_SHARE = 0.5;
/** Keys sent as keydown/keyup; anything else (newline, tab, non-ASCII) is inserted as text. */
const KEYED = /^[\x20-\x7e]$/;

/** A CSS string body: backslashes, quotes and newlines escaped. */
const cssString = (s: string) =>
  s.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ');

const inside = (p: Pt, b: Box) =>
  p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

export function createPace(
  page: Page,
  profile: PaceProfile,
  deps: {
    rng?: Rng;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /**
     * The viewport in CSS px when `page.viewportSize()` has none (a
     * connectOverCDP window). Must not run scripts in the page.
     */
    viewport?: () => Promise<{ width: number; height: number } | null>;
    /**
     * Runs `open` (the click on an upload button), waits for the chooser,
     * awaits `choose` (the time in the dialog), then sets `file` on the
     * chooser's input so Chrome fires a trusted `change` (the bridge's
     * relay-side upload). Without it `upload` refuses.
     */
    uploadOnChooser?: (
      file: string,
      open: () => Promise<void>,
      choose: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Pace {
  const rng = deps.rng ?? cryptoRng();
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const now = deps.now ?? (() => performance.now());
  const wait = (ms: number) => sleep(Math.max(0, ms));
  const mood = draw(profile, 'appSpeedFactor', rng, {
    min: MOOD_MIN,
    max: MOOD_MAX,
  });
  const defaulted = (Object.keys(DEFAULTS) as MeasureName[]).filter((n) =>
    isDefaulted(profile, n),
  );
  const dwell = (name: MeasureName) => wait(draw(profile, name, rng) * mood);

  let pos: Pt | null = null;
  /** When the last move was sent: the hover before a press counts from it. */
  let lastMoveAt: number | null = null;
  /** How long a box read takes here (a moving average): see `hoverThenCheck`. */
  let boxCost: number | null = null;

  /**
   * Input sent without waiting for each ack. CDP keeps the order, and the
   * page sees each event about when it was sent: live, pipelined moves
   * landed within ±1.5 ms of their schedule, awaited ones within ±7 ms
   * (each waits a 8–17 ms round trip). The first failure stops later sends
   * and is thrown by `flush`.
   */
  function pipeline() {
    const pending: Promise<void>[] = [];
    let failure: { error: unknown } | null = null;
    return {
      get failed() {
        return failure !== null;
      },
      send(call: () => Promise<void>) {
        pending.push(
          call().catch((error: unknown) => {
            failure ??= { error };
          }),
        );
      },
      async flush() {
        await Promise.all(pending);
        if (failure) throw failure.error;
      },
    };
  }

  /** The viewport, or a refusal: pace never guesses where the window ends. */
  async function viewport(): Promise<{ width: number; height: number }> {
    const view = page.viewportSize() ?? (await deps.viewport?.()) ?? null;
    if (!view) throw new Error('pace: viewport unknown: refusing to move');
    return view;
  }

  /**
   * Sends each point when its time comes; points already overdue are
   * skipped. Points are kept inside the viewport (a bulge or overshoot near
   * an edge never leaves the window). A point where the pointer already is
   * (whole-pixel rounding at the slow start and end of a stroke, or edge
   * clamping) is not sent: Chrome would report it as a pointermove with no
   * movement, which a real mouse at rest never sends. Moves are pipelined
   * (see `pipeline`). `stop` ends the stroke early when it turns true.
   */
  async function emit(
    points: TimedPt[],
    start: number,
    view: { width: number; height: number },
    stop: () => boolean = () => false,
  ): Promise<void> {
    const out = pipeline();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const x = Math.min(view.width - 1, Math.max(0, p.x));
      const y = Math.min(view.height - 1, Math.max(0, p.y));
      // Not waited for either: the pointer stopped at the last move sent.
      if (pos && pos.x === x && pos.y === y) continue;
      await wait(start + p.at - now());
      if (out.failed || stop()) break;
      const next = points[i + 1];
      if (next && now() >= start + next.at) continue;
      lastMoveAt = now();
      out.send(() => page.mouse.move(x, y));
      pos = { x, y };
    }
    await out.flush();
  }

  /** The first position: from a viewport edge into the middle 60%. */
  async function position(): Promise<Pt> {
    if (pos) return pos;
    const view = await viewport();
    const { width, height } = view;
    const r = () => rng.next();
    const edges: Pt[] = [
      { x: 0, y: Math.floor(r() * height) },
      { x: width - 1, y: Math.floor(r() * height) },
      { x: Math.floor(r() * width), y: 0 },
      { x: Math.floor(r() * width), y: height - 1 },
    ];
    const edge = edges[Math.floor(r() * 4)];
    await page.mouse.move(edge.x, edge.y);
    pos = edge;
    const size = 40;
    const spot: Box = {
      x: width * (0.3 + 0.4 * r()) - size / 2,
      y: height * (0.3 + 0.4 * r()) - size / 2,
      width: size,
      height: size,
    };
    await emit(planPath(edge, spot, profile, rng).points, now(), view);
    return pos;
  }

  /** The part of `box` inside the viewport; throws when none of it is. */
  function clip(box: Box, view: { width: number; height: number }): Box {
    const x0 = Math.max(box.x, 0);
    const y0 = Math.max(box.y, 0);
    const x1 = Math.min(box.x + box.width, view.width);
    const y1 = Math.min(box.y + box.height, view.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      throw new Error('pace: target is off-screen; scroll it into view first');
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** The part of the target's box inside the viewport; times the read. */
  async function visibleBox(target: Locator): Promise<Box> {
    const t0 = now();
    const box = await target.boundingBox();
    if (!box) throw new Error('pace: target has no box (hidden or detached)');
    const shown = clip(box, await viewport());
    const cost = now() - t0;
    boxCost = boxCost === null ? cost : 0.7 * boxCost + 0.3 * cost;
    return shown;
  }

  /**
   * How far (CSS px, + is down) the page must scroll to show the target
   * comfortably: 0 when it is fully in the window, or a tall target covers
   * half of it. Throws for a target off to the side.
   */
  function revealDistance(
    box: Box,
    view: { width: number; height: number },
  ): number {
    if (box.x + box.width <= 0 || box.x >= view.width) {
      throw new Error('pace: target is off-screen to the side; not scrolling');
    }
    const top = box.y;
    const bottom = box.y + box.height;
    const shown = Math.min(bottom, view.height) - Math.max(top, 0);
    if (box.height <= view.height) {
      if (top >= 0 && bottom <= view.height) return 0;
    } else if (shown >= view.height / 2) {
      return 0;
    }
    const margin = view.height * REVEAL_MARGIN;
    // Below (or taller than the window): bring its bottom, or its top, up.
    if (top > 0 && box.height <= view.height) {
      return bottom - (view.height - margin);
    }
    return top - margin;
  }

  /**
   * Scrolls an off-screen target into view the way a person does: the
   * pointer goes over the target's column mid-window, then wheel bursts at
   * the author's rhythm, reading the box again after each burst. Gives up
   * after REVEAL_MAX_NOTCHES notches or when bursts stop moving the target.
   * Returns the visible part of the target's last box.
   */
  async function reveal(target: Locator): Promise<Box> {
    let used = 0;
    let stuck = 0;
    let lastY: number | null = null;
    for (;;) {
      const box = await target.boundingBox();
      if (!box) throw new Error('pace: target has no box (hidden or detached)');
      const view = await viewport();
      const distance = revealDistance(box, view);
      if (distance === 0) return clip(box, view);
      if (lastY !== null) {
        stuck = box.y === lastY ? stuck + 1 : 0;
        if (stuck >= REVEAL_MAX_STUCK) {
          throw new Error(
            'pace: target is off-screen and scrolling does not move it',
          );
        }
      }
      if (used >= REVEAL_MAX_NOTCHES) {
        throw new Error(
          `pace: target is still off-screen after ${used} wheel notches`,
        );
      }
      lastY = box.y;
      if (used > 0) {
        // Bursts are apart by at least the gap that splits them in recordings.
        await wait(
          WHEEL_BURST_GAP_MS -
            SCROLL_SETTLE_MS +
            draw(profile, 'wheelGap', rng),
        );
      } else {
        await moveOver(scrollSpot(box, view), view);
        await wait(draw(profile, 'hoverToPress', rng));
      }
      const px = await notchPx();
      const needed = Math.max(1, Math.ceil(Math.abs(distance) / px));
      const burst = Math.min(
        Math.round(draw(profile, 'wheelBurst', rng, { min: 1 })),
        needed,
        REVEAL_MAX_NOTCHES - used,
      );
      await wheelNotches(Math.sign(distance) * burst, px);
      used += burst;
      await wait(SCROLL_SETTLE_MS);
    }
  }

  /** Where the pointer rests while scrolling: the target's column, mid-window. */
  function scrollSpot(box: Box, view: { width: number; height: number }): Box {
    const x0 = Math.max(box.x, 0);
    const x1 = Math.min(box.x + box.width, view.width);
    const width = Math.min(x1 - x0, 120);
    return {
      x: (x0 + x1) / 2 - width / 2,
      y: view.height * 0.35,
      width,
      height: view.height * 0.3,
    };
  }

  /** Moves into `spot` along a planned path, unless the pointer is there. */
  async function moveOver(
    spot: Box,
    view: { width: number; height: number },
  ): Promise<void> {
    const from = await position();
    if (inside(from, spot)) return;
    await emit(planPath(from, spot, profile, rng).points, now(), view);
  }

  /** `n` wheel notches of `px` (negative scrolls up), wheelGap apart. */
  async function wheelNotches(n: number, px: number): Promise<void> {
    for (let i = 0; i < Math.abs(n); i++) {
      if (i > 0) await wait(draw(profile, 'wheelGap', rng));
      await page.mouse.wheel(0, Math.sign(n) * px);
    }
  }

  /**
   * Moves onto the target, scrolling it into view first. The box is read
   * again before the final approach, so a page that scrolled or a window
   * that moved never gets a stale click.
   */
  async function approach(target: Locator): Promise<void> {
    await position();
    const shown = await reveal(target);
    // After a scroll the pointer rests where it wheeled.
    const from = await position();
    const view = await viewport();
    const plan = planPath(from, shown, profile, rng);
    const start = now();
    const total = plan.points[plan.points.length - 1].at;
    const cut = plan.points.findIndex((p) => p.at >= total * APPROACH_AT);
    await emit(plan.points.slice(0, cut), start, view);
    // The box is read while the stroke goes on (a read takes ~40 ms; a
    // pause mid-stroke shows up as a long sample interval). A target that
    // moved ends the stroke where it is and gets a new one.
    let read: { box: Box } | { error: unknown } | null = null;
    const reading = visibleBox(target).then(
      (box) => void (read = { box }),
      (error: unknown) => void (read = { error }),
    );
    const moved = () =>
      read !== null && (!('box' in read) || !inside(plan.end, read.box));
    await emit(plan.points.slice(cut), start, view, moved);
    await reading;
    const done = read as { box: Box } | { error: unknown } | null;
    if (!done || !('box' in done)) throw done?.error;
    if (!inside(plan.end, done.box)) {
      const again = planPath(pos ?? from, done.box, profile, rng);
      await emit(again.points, now(), view);
    }
  }

  /**
   * Waits a hoverToPress draw from the last move sent, reading the target's
   * box at the end of it: the read's usual cost comes off the wait, so the
   * page sees the author's hover and the read is still the last thing
   * before the press. True when the pointer is on the target.
   */
  async function hoverThenCheck(target: Locator): Promise<boolean> {
    const due = (lastMoveAt ?? now()) + draw(profile, 'hoverToPress', rng);
    await wait(due - (boxCost ?? 0) - now());
    const on = await onTarget(target);
    await wait(due - now());
    return on;
  }

  /** `down`, then `up` a draw of `hold` after `down` was sent. */
  async function hold(
    name: MeasureName,
    down: () => Promise<void>,
    up: () => Promise<void>,
  ): Promise<void> {
    const sent = now();
    await down();
    await wait(sent + draw(profile, name, rng) - now());
    await up();
  }

  /** True when the mouse rests inside the target's current box. */
  async function onTarget(target: Locator): Promise<boolean> {
    const box = await visibleBox(target);
    return pos !== null && inside(pos, box);
  }

  async function click(target: Locator): Promise<void> {
    await approach(target);
    // The box is read once more right before the press: never a stale click.
    if (!(await hoverThenCheck(target))) {
      await approach(target);
      if (!(await hoverThenCheck(target))) {
        throw new Error('pace: target keeps moving; not pressing');
      }
    }
    await hold(
      'pressRelease',
      () => page.mouse.down(),
      () => page.mouse.up(),
    );
  }

  async function type(field: Locator, text: string): Promise<void> {
    await click(field);
    await dwell('fieldDwellBeforeTyping');
    // Lay keydowns and keyups out on one timeline; holds may overlap the next key.
    const keys: { at: number; up: number; ch: string }[] = [];
    let at = 0;
    for (const k of planKeys(text, profile, rng)) {
      at += k.gapBefore;
      keys.push({ at, up: at + k.hold, ch: k.ch });
    }
    const events: { at: number; key: string; down: boolean; text?: true }[] =
      [];
    for (const k of keys) {
      if (!KEYED.test(k.ch)) {
        events.push({ at: k.at, key: k.ch, down: true, text: true });
        continue;
      }
      events.push({ at: k.at, key: k.ch, down: true });
      events.push({ at: k.up, key: k.ch, down: false });
    }
    events.push(...shiftHolds(keys));
    // Stable sort; at equal times a release goes before a press.
    events.sort((p, q) => p.at - q.at || Number(p.down) - Number(q.down));
    const start = now() - Math.min(0, ...events.map((e) => e.at));
    // Pipelined like moves, so each key lands on its schedule.
    const out = pipeline();
    for (const e of events) {
      await wait(start + e.at - now());
      if (out.failed) break;
      out.send(() =>
        e.text
          ? page.keyboard.insertText(e.key)
          : e.down
            ? page.keyboard.down(e.key)
            : page.keyboard.up(e.key),
      );
    }
    await out.flush();
  }

  /**
   * Shift presses for capitals and shifted symbols (US layout): a keyboard
   * can't type them without it, and a page sees `shiftKey` on each key. One
   * hold covers a run of them. Shift goes down a share of a keyGapInWord
   * draw before the run (never before the previous key's press) and comes up
   * a share of a keyHold draw after its last release (always before the next
   * key's press). The recorder keeps no modifier timing, so the shares are
   * fixed guesses; Shift's own keydowns do land in the key-gap measures, as
   * the author's do.
   */
  function shiftHolds(
    keys: { at: number; up: number; ch: string }[],
  ): { at: number; key: string; down: boolean }[] {
    const out: { at: number; key: string; down: boolean }[] = [];
    for (let i = 0; i < keys.length; i++) {
      if (!SHIFTED.test(keys[i].ch)) continue;
      let j = i;
      while (j + 1 < keys.length && SHIFTED.test(keys[j + 1].ch)) j++;
      const gap = i > 0 ? keys[i].at - keys[i - 1].at : Infinity;
      const lead = Math.min(
        draw(profile, 'keyGapInWord', rng, { min: 1 }) * SHIFT_LEAD_SHARE,
        gap * 0.8,
      );
      const lastUp = Math.max(...keys.slice(i, j + 1).map((k) => k.up));
      const next = keys[j + 1]?.at ?? Infinity;
      const release = Math.min(
        lastUp + draw(profile, 'keyHold', rng, { min: 1 }) * SHIFT_TRAIL_SHARE,
        keys[j].at + (next - keys[j].at) * 0.8,
      );
      out.push({ at: keys[i].at - lead, key: 'Shift', down: true });
      out.push({ at: release, key: 'Shift', down: false });
      i = j;
    }
    return out;
  }

  async function pick(control: Locator, index: number): Promise<void> {
    const radios = control.locator('input[type="radio"]');
    if ((await radios.count()) > 0) {
      const radio = radios.nth(index);
      await click(await radioTarget(control, radio));
      return;
    }
    const steps = await selectSteps(control, index);
    // Open the list with the mouse, then move in it with the keys and take
    // the option with Enter, so Chrome fires a trusted `change`.
    await click(control);
    await dwell('pickDwell');
    await assertListOpen(control);
    const key = steps > 0 ? 'ArrowDown' : 'ArrowUp';
    for (let i = 0; i < Math.abs(steps); i++) {
      await press(key);
      await wait(draw(profile, 'keyGapInWord', rng));
    }
    await press('Enter');
    if ((await checkedIndex(control)) !== index) {
      throw new Error(`pace: the select did not take option ${index}`);
    }
  }

  /**
   * Refuses to send keys unless the select has focus and its list is open,
   * read through CSS (`:focus`, `:open`; no script). Otherwise the keys go
   * to whatever had focus before (Enter in a text field submits its form),
   * or each arrow changes a closed select (one `change` per press).
   */
  async function assertListOpen(control: Locator): Promise<void> {
    const is = async (pseudo: string) =>
      (await control.and(page.locator(pseudo)).count()) > 0;
    if (!(await is(':focus'))) {
      throw new Error('pace: the select did not take focus; no keys sent');
    }
    if (!(await is(':open'))) {
      throw new Error('pace: the select list did not open; no keys sent');
    }
  }

  /** One key press with the author's hold. */
  async function press(key: string): Promise<void> {
    await hold(
      'keyHold',
      () => page.keyboard.down(key),
      () => page.keyboard.up(key),
    );
  }

  /** The checked option's index, read through CSS (no script). */
  async function checkedIndex(control: Locator): Promise<number> {
    const n = await control.locator('option').count();
    return n - 1 - (await control.locator(AFTER_CHECKED).count());
  }

  /**
   * Arrow presses from the checked option to option `index` (+ down, - up);
   * disabled options are skipped, as the open list skips them. Refuses what
   * the keys can't pick reliably (a disabled select among them), before
   * anything is clicked.
   */
  async function selectSteps(control: Locator, index: number): Promise<number> {
    // A click on a disabled select neither focuses nor opens it.
    if (await control.isDisabled()) {
      throw new Error('pace: the select is disabled');
    }
    if ((await control.getAttribute('multiple')) !== null) {
      throw new Error('pace: a multiple select is not supported');
    }
    if ((await control.locator('optgroup').count()) > 0) {
      throw new Error('pace: a select with option groups is not supported');
    }
    const options = control.locator('option');
    const n = await options.count();
    if (!Number.isInteger(index) || index < 0 || index >= n) {
      throw new Error(`pace: the select has no option ${index}`);
    }
    if (await options.nth(index).isDisabled()) {
      throw new Error(`pace: option ${index} is disabled`);
    }
    if ((await control.locator('option:checked').count()) !== 1) {
      throw new Error('pace: the select has no checked option');
    }
    const from = await checkedIndex(control);
    const dir = Math.sign(index - from);
    let steps = 0;
    for (let i = from + dir; dir !== 0 && i !== index + dir; i += dir) {
      if (!(await options.nth(i).isDisabled())) steps += dir;
    }
    return steps;
  }

  /** The radio's label: `label[for=id]`, else a wrapping label, else the radio. */
  async function radioTarget(
    control: Locator,
    radio: Locator,
  ): Promise<Locator> {
    const id = await radio.getAttribute('id');
    if (id) {
      const byFor = control.locator(`label[for="${cssString(id)}"]`).first();
      if ((await byFor.count()) > 0) return byFor;
    }
    const wrapping = radio.locator('xpath=ancestor::label').first();
    if ((await wrapping.count()) > 0) return wrapping;
    return radio;
  }

  function readTime(chars: number | null): number {
    const plain = samplesOf(profile, 'readDwell');
    if (chars === null || !profile.reading) {
      return sampleKde(plain, rng, { min: READ_MIN_MS });
    }
    const { base, perChar, residuals } = profile.reading;
    const residual =
      residuals.length >= 2
        ? sampleKde(residuals, rng, {
            min: Math.min(...residuals),
            max: Math.max(...residuals),
          })
        : (residuals[0] ?? 0);
    const t = base + perChar * chars + residual;
    const max = READ_MAX_FACTOR * Math.max(...plain);
    return Math.min(max, Math.max(READ_MIN_MS, Number.isFinite(t) ? t : 0));
  }

  /** One notch in CSS px, as a positive magnitude. */
  async function notchPx(): Promise<number> {
    const deltaY = Math.abs(profile.wheel.deltaY);
    const { deltaMode } = profile.wheel;
    if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
    if (deltaMode === 2) return deltaY * (await viewport()).height;
    return deltaY;
  }

  return {
    mood,
    defaulted,
    click,
    type,
    pick,
    async glance(field) {
      await approach(field);
      await dwell('fieldDwellPrefilled');
    },
    async upload(button, filePath) {
      // Patchright's own setFiles over a remote connection sets the files by
      // script (an untrusted `change`), so there is no fallback to it.
      const upload = deps.uploadOnChooser;
      if (!upload) {
        throw new Error('pace: upload needs deps.uploadOnChooser; refusing');
      }
      await upload(
        filePath,
        () => click(button),
        () => dwell('fileChooserDwell'),
      );
    },
    async scroll(area, notches) {
      await approach(area);
      const n =
        notches ?? Math.round(draw(profile, 'wheelBurst', rng, { min: 1 }));
      const px = await notchPx();
      await wait(draw(profile, 'hoverToPress', rng));
      await wheelNotches(n, px);
    },
    async read(chars) {
      await wait(readTime(chars) * mood);
    },
    async pause() {
      let ms = draw(profile, 'afterTypingToMove', rng);
      if (rng.next() < rate(profile, 'longPauseRate')) {
        ms += draw(profile, 'longPause', rng);
      }
      await wait(ms * mood);
    },
    maybe(action) {
      const p =
        action === 'expand-description'
          ? rate(profile, 'expandRate')
          : action === 'scroll-description'
            ? rate(profile, 'scrollRate')
            : IDLE_MOVE_RATE;
      return rng.next() < p;
    },
  };
}
