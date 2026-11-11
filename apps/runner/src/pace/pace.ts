import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'patchright-core';
import { DEFAULTS, draw, isDefaulted, rate, samplesOf } from './defaults.js';
import type { MeasureName } from './measures.js';
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
  /** A `<select>` (by option index) or a radio group (the nth radio's label). */
  pick(control: Locator, index: number): Promise<void>;
  /** Clicks the button with the file chooser intercepted, then sets the file. */
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

  /** The viewport, or a refusal: pace never guesses where the window ends. */
  async function viewport(): Promise<{ width: number; height: number }> {
    const view = page.viewportSize() ?? (await deps.viewport?.()) ?? null;
    if (!view) throw new Error('pace: viewport unknown: refusing to move');
    return view;
  }

  /**
   * Sends each point when its time comes; points already overdue are
   * skipped. Points are kept inside the viewport (a bulge or overshoot near
   * an edge never leaves the window).
   */
  async function emit(
    points: TimedPt[],
    start: number,
    view: { width: number; height: number },
  ): Promise<void> {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      await wait(start + p.at - now());
      const next = points[i + 1];
      if (next && now() >= start + next.at) continue;
      const x = Math.min(view.width - 1, Math.max(0, p.x));
      const y = Math.min(view.height - 1, Math.max(0, p.y));
      await page.mouse.move(x, y);
      pos = { x, y };
    }
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

  /** The part of the target's box inside the viewport. */
  async function visibleBox(target: Locator): Promise<Box> {
    const box = await target.boundingBox();
    if (!box) throw new Error('pace: target has no box (hidden or detached)');
    const view = await viewport();
    const x0 = Math.max(box.x, 0);
    const y0 = Math.max(box.y, 0);
    const x1 = Math.min(box.x + box.width, view.width);
    const y1 = Math.min(box.y + box.height, view.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      throw new Error('pace: target is off-screen; scroll it into view first');
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /**
   * Moves onto the target. The box is read again before the final approach,
   * so a page that scrolled or a window that moved never gets a stale click.
   */
  async function approach(target: Locator): Promise<void> {
    const from = await position();
    const view = await viewport();
    const plan = planPath(from, await visibleBox(target), profile, rng);
    const start = now();
    const total = plan.points[plan.points.length - 1].at;
    const cut = plan.points.findIndex((p) => p.at >= total * APPROACH_AT);
    await emit(plan.points.slice(0, cut), start, view);
    const fresh = await visibleBox(target);
    if (inside(plan.end, fresh)) {
      await emit(plan.points.slice(cut), start, view);
    } else {
      const again = planPath(pos ?? from, fresh, profile, rng);
      await emit(again.points, now(), view);
    }
  }

  /** True when the mouse rests inside the target's current box. */
  async function onTarget(target: Locator): Promise<boolean> {
    const box = await visibleBox(target);
    return pos !== null && inside(pos, box);
  }

  async function click(target: Locator): Promise<void> {
    await approach(target);
    await wait(draw(profile, 'hoverToPress', rng));
    // The box is read once more right before the press: never a stale click.
    if (!(await onTarget(target))) {
      await approach(target);
      await wait(draw(profile, 'hoverToPress', rng));
      if (!(await onTarget(target))) {
        throw new Error('pace: target keeps moving; not pressing');
      }
    }
    await page.mouse.down();
    await wait(draw(profile, 'pressRelease', rng));
    await page.mouse.up();
  }

  async function type(field: Locator, text: string): Promise<void> {
    await click(field);
    await dwell('fieldDwellBeforeTyping');
    // Lay keydowns and keyups out on one timeline; holds may overlap the next key.
    const events: { at: number; ch: string; down: boolean }[] = [];
    let at = 0;
    for (const k of planKeys(text, profile, rng)) {
      at += k.gapBefore;
      events.push({ at, ch: k.ch, down: true });
      if (KEYED.test(k.ch))
        events.push({ at: at + k.hold, ch: k.ch, down: false });
    }
    // Stable sort; at equal times a release goes before a press.
    events.sort((p, q) => p.at - q.at || Number(p.down) - Number(q.down));
    const start = now();
    for (const e of events) {
      await wait(start + e.at - now());
      if (!KEYED.test(e.ch)) await page.keyboard.insertText(e.ch);
      else if (e.down) await page.keyboard.down(e.ch);
      else await page.keyboard.up(e.ch);
    }
  }

  async function pick(control: Locator, index: number): Promise<void> {
    const radios = control.locator('input[type="radio"]');
    if ((await radios.count()) > 0) {
      const radio = radios.nth(index);
      await click(await radioTarget(control, radio));
      return;
    }
    await click(control);
    await dwell('pickDwell');
    await control.selectOption({ index });
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
      // Listening for the chooser turns on interception, so no OS dialog opens.
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        click(button),
      ]);
      await chooser.setFiles(filePath);
    },
    async scroll(area, notches) {
      await approach(area);
      const n =
        notches ?? Math.round(draw(profile, 'wheelBurst', rng, { min: 1 }));
      const step = Math.sign(n) * (await notchPx());
      await wait(draw(profile, 'hoverToPress', rng));
      for (let i = 0; i < Math.abs(n); i++) {
        if (i > 0) await wait(draw(profile, 'wheelGap', rng));
        await page.mouse.wheel(0, step);
      }
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
