import type { Locator, Page } from 'patchright-core';
import type { Box } from './mouse.js';
import { calibrateHolds } from './holds.js';
import { physicalKey } from './keys.js';
import { createPace } from './pace.js';
import type { PaceProfile } from './profile.js';
import { cryptoRng, seededRng } from './rng.js';
import { flat, testProfile } from './testing/profiles.js';

vi.mock('./holds.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./holds.js')>();
  return { ...orig, calibrateHolds: vi.fn(orig.calibrateHolds) };
});

vi.mock('./rng.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./rng.js')>();
  return { ...orig, cryptoRng: vi.fn(orig.cryptoRng) };
});

type Ev =
  | { kind: 'move'; t: number; x: number; y: number }
  | { kind: 'down' | 'up'; t: number }
  | { kind: 'wheel'; t: number; dx: number; dy: number }
  | { kind: 'kdown' | 'kup' | 'text'; t: number; key: string }
  | { kind: 'box' | 'select' | 'chooser' | 'files'; t: number; arg?: unknown };

/** A fake `<select>`: options (true = disabled) and the checked index. */
interface FakeSelect {
  disabled: boolean[];
  checked: number;
  /** False: Enter does not commit (the select ignores the keys). */
  commits?: boolean;
  optgroups?: number;
  multiple?: boolean;
  /** The select itself is disabled: a click neither focuses nor opens it. */
  selfDisabled?: boolean;
  /** False: the click does not focus it (default true). */
  focuses?: boolean;
  /** False: the click focuses it but the list does not open (default true). */
  opens?: boolean;
}

const VIEW = { width: 1280, height: 800 };

type View = { width: number; height: number } | null;
interface Opts {
  moveLag?: number;
  /** What `page.viewportSize()` returns (default VIEW). */
  view?: View;
  /** `deps.viewport`, when given. */
  depView?: () => Promise<View>;
  /** Leave out `deps.uploadOnChooser`. */
  noUpload?: boolean;
  /** Mouse and key calls ack on a later macrotask, like a CDP round trip. */
  slowAcks?: boolean;
  /** ms that `mouse.down` and `keyboard.down` take to ack. */
  downLag?: number;
  /** ms a box read takes; time passes only as other work moves the clock. */
  boxLag?: number;
}

function fake(opts: Opts = {}) {
  let t = 1000;
  const log: Ev[] = [];
  /** How far the page has scrolled, in CSS px, from the wheel events. */
  let scrolled = 0;
  /** Box reads in flight: each resolves once the clock reaches its due time. */
  const reads: { due: number; done: () => void }[] = [];
  const settle = () => {
    for (const r of reads.filter((x) => x.due <= t)) {
      reads.splice(reads.indexOf(r), 1);
      r.done();
    }
  };
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(0, ms);
      settle();
    },
  };
  /** Calls whose ack has not come back yet, and the most at once. */
  let inFlight = 0;
  let maxInFlight = 0;
  const ack = async () => {
    if (!opts.slowAcks) return;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
  };
  /**
   * Waits until the clock reaches `due` through other work's sleeps; when
   * nothing else runs (the read is awaited alone), the clock moves there.
   */
  const until = (due: number) =>
    new Promise<void>((done) => {
      reads.push({ due, done });
      // Other work's sleeps resolve in microtasks, before this runs.
      setImmediate(() => {
        if (!reads.some((r) => r.done === done)) return;
        t = Math.max(t, due);
        settle();
      });
    });
  const page = {
    mouse: {
      move: async (x: number, y: number) => {
        log.push({ kind: 'move', t, x, y });
        t += opts.moveLag ?? 0;
        await ack();
      },
      down: async () => {
        log.push({ kind: 'down', t });
        t += opts.downLag ?? 0;
        await ack();
      },
      up: async () => {
        log.push({ kind: 'up', t });
        await ack();
      },
      wheel: async (dx: number, dy: number) => {
        log.push({ kind: 'wheel', t, dx, dy });
        scrolled += dy;
      },
    },
    keyboard: {
      down: async (key: string) => {
        log.push({ kind: 'kdown', t, key });
        t += opts.downLag ?? 0;
        await ack();
      },
      up: async (key: string) => {
        log.push({ kind: 'kup', t, key });
        await ack();
      },
      insertText: async (key: string) => {
        log.push({ kind: 'text', t, key });
        await ack();
      },
    },
    viewportSize: () => (opts.view === undefined ? VIEW : opts.view),
    /** Only what `pick` asks for: a pseudo-class to combine with `and`. */
    locator: (sel: string) => ({ pseudo: sel }),
  };
  const uploadOnChooser = vi.fn(
    async (
      file: string,
      open: () => Promise<void>,
      choose: () => Promise<void>,
    ) => {
      log.push({ kind: 'chooser', t });
      await open();
      // The chooser has opened: the person picks a file in the dialog.
      log.push({ kind: 'chooser', t, arg: 'opened' });
      await choose();
      log.push({ kind: 'files', t, arg: file });
    },
  );
  const locator = (boxes: Box[], extra: Record<string, unknown> = {}) => {
    let i = 0;
    return {
      boundingBox: async () => {
        log.push({ kind: 'box', t });
        const box = boxes[Math.min(i++, boxes.length - 1)];
        if (opts.boxLag) await until(t + opts.boxLag);
        return box;
      },
      selectOption: async (arg: unknown) =>
        void log.push({ kind: 'select', t, arg }),
      locator: () => ({ count: async () => 0 }),
      // A field takes focus once the mouse has pressed on it.
      and: (other: { pseudo: string }) => ({
        count: async () =>
          other.pseudo === ':focus' && log.some((e) => e.kind === 'down')
            ? 1
            : 0,
      }),
      ...extra,
    } as unknown as Locator;
  };
  /** A target on a page that scrolls by `pxPerPx` CSS px per wheel px. */
  const scrolling = (box: Box, pxPerPx = 1, maxScroll = Infinity) =>
    ({
      boundingBox: async () => {
        log.push({ kind: 'box', t });
        return { ...box, y: box.y - Math.min(scrolled, maxScroll) * pxPerPx };
      },
    }) as unknown as Locator;
  /** A target whose page shows each wheel only `lag` ms after it was sent. */
  const lagging = (box: Box, lag: number) =>
    ({
      boundingBox: async () => {
        log.push({ kind: 'box', t });
        const shown = log
          .filter((e): e is Ev & { kind: 'wheel' } => e.kind === 'wheel')
          .filter((w) => w.t + lag <= t)
          .reduce((n, w) => n + w.dy, 0);
        return { ...box, y: box.y - shown };
      },
    }) as unknown as Locator;
  /**
   * A `<select>` whose checked option follows the keys: arrows move the
   * open popup's highlight over enabled options, Enter commits it.
   */
  const select = (s: FakeSelect) => {
    const checked = () => {
      let cur = s.checked;
      let hi = s.checked;
      for (const e of log) {
        if (e.kind !== 'kdown') continue;
        const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (dir) {
          let i = hi + dir;
          while (s.disabled[i]) i += dir;
          if (i >= 0 && i < s.disabled.length) hi = i;
        } else if (e.key === 'Enter' && s.commits !== false) cur = hi;
      }
      return cur;
    };
    const selectors: string[] = [];
    // Focused and open once the mouse has pressed on it, unless disabled.
    const pressed = () => !s.selfDisabled && log.some((e) => e.kind === 'down');
    const state: Record<string, () => boolean> = {
      ':focus': () => pressed() && s.focuses !== false,
      ':open': () => pressed() && s.focuses !== false && s.opens !== false,
    };
    const loc = locator([BOX], {
      isDisabled: async () => s.selfDisabled === true,
      and: (other: { pseudo: string }) => {
        selectors.push(`and ${other.pseudo}`);
        return { count: async () => (state[other.pseudo]() ? 1 : 0) };
      },
      getAttribute: async (name: string) =>
        name === 'multiple' && s.multiple ? '' : null,
      locator: (sel: string) => {
        selectors.push(sel);
        if (sel === 'option') {
          return {
            count: async () => s.disabled.length,
            nth: (i: number) => ({ isDisabled: async () => s.disabled[i] }),
          };
        }
        if (sel === 'option:checked ~ option') {
          return { count: async () => s.disabled.length - 1 - checked() };
        }
        if (sel === 'optgroup') return { count: async () => s.optgroups ?? 0 };
        if (sel === 'option:checked') {
          return { count: async () => (s.checked >= 0 ? 1 : 0) };
        }
        return { count: async () => 0 };
      },
    });
    return { loc, checked, selectors };
  };
  return {
    page: page as unknown as Page,
    log,
    clock,
    locator,
    scrolling,
    lagging,
    select,
    uploadOnChooser,
    maxInFlight: () => maxInFlight,
  };
}

const inside = (p: { x: number; y: number }, b: Box) =>
  p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

const BOX: Box = { x: 700, y: 500, width: 120, height: 36 };

function setup(
  profile: PaceProfile = testProfile(),
  seed = 1,
  opts: Opts = {},
) {
  const f = fake(opts);
  const pace = createPace(f.page, profile, {
    rng: seededRng(seed),
    sleep: f.clock.sleep,
    now: f.clock.now,
    ...(opts.depView ? { viewport: opts.depView } : {}),
    ...(opts.noUpload ? {} : { uploadOnChooser: f.uploadOnChooser }),
  });
  return { ...f, pace };
}

const of = <K extends Ev['kind']>(log: Ev[], kind: K) =>
  log.filter((e): e is Ev & { kind: K } => e.kind === kind);

/** Events after the first box read (skips the first-position move). */
const afterBox = (log: Ev[]) =>
  log.slice(log.findIndex((e) => e.kind === 'box'));

describe('createPace', () => {
  it('starts from a viewport edge and settles in the middle 60%', async () => {
    const { pace, log, locator } = setup();
    await pace.click(locator([BOX]));
    const first = of(log, 'move')[0];
    const onEdge =
      first.x === 0 ||
      first.y === 0 ||
      first.x === VIEW.width - 1 ||
      first.y === VIEW.height - 1;
    expect(onEdge).toBe(true);
    const before = log.slice(
      0,
      log.findIndex((e) => e.kind === 'box'),
    );
    const settled = of(before, 'move').at(-1);
    expect(settled?.x).toBeGreaterThanOrEqual(VIEW.width * 0.2);
    expect(settled?.x).toBeLessThanOrEqual(VIEW.width * 0.8);
    expect(settled?.y).toBeGreaterThanOrEqual(VIEW.height * 0.2);
    expect(settled?.y).toBeLessThanOrEqual(VIEW.height * 0.8);
  });

  it('click moves along the planned points, then hoverToPress, down, pressRelease, up', async () => {
    const { pace, log, locator } = setup();
    await pace.click(locator([BOX]));
    const ev = afterBox(log);
    const moves = of(ev, 'move');
    expect(moves.length).toBeGreaterThan(10);
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].t).toBeGreaterThanOrEqual(moves[i - 1].t);
    }
    const last = moves[moves.length - 1];
    expect(inside(last, BOX)).toBe(true);
    const [down] = of(ev, 'down');
    const [up] = of(ev, 'up');
    const between = ev.slice(ev.indexOf(last) + 1, ev.indexOf(down));
    expect(between.map((e) => e.kind)).toEqual(['box']);
    expect(down.t - last.t).toBeCloseTo(150, 6);
    expect(up.t - down.t).toBeCloseTo(90, 6);
    expect(ev.at(-1)).toBe(up);
  });

  it('click re-reads the box before arriving', async () => {
    const moved: Box = { x: 200, y: 150, width: 80, height: 30 };
    const { pace, log, locator } = setup();
    await pace.click(locator([BOX, moved]));
    const ev = afterBox(log);
    expect(of(ev, 'box').length).toBeGreaterThanOrEqual(2);
    const second = ev.indexOf(of(ev, 'box')[1]);
    expect(of(ev.slice(0, second), 'move').length).toBeGreaterThan(0);
    const last = of(ev, 'move').at(-1);
    expect(last && inside(last, moved)).toBe(true);
    expect(of(ev, 'down')).toHaveLength(1);
  });

  it('click re-reads the box right before the press and re-approaches once', async () => {
    const moved: Box = { x: 200, y: 150, width: 80, height: 30 };
    const { pace, log, locator } = setup();
    // Arrives on BOX; the press-time read finds it moved.
    await pace.click(locator([BOX, BOX, moved]));
    const [down] = of(log, 'down');
    const before = of(log.slice(0, log.indexOf(down)), 'move').at(-1);
    expect(before && inside(before, moved)).toBe(true);
  });

  it('click refuses to press a target that keeps moving', async () => {
    const boxes: Box[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      x: 100 + i * 150,
      y: 100 + i * 80,
      width: 60,
      height: 24,
    }));
    const { pace, log, locator } = setup();
    // Each read pair puts the target somewhere new.
    await expect(
      pace.click(
        locator([
          boxes[0],
          boxes[0],
          boxes[1],
          boxes[1],
          boxes[1],
          boxes[2],
          boxes[3],
        ]),
      ),
    ).rejects.toThrow(/keeps moving/);
    expect(of(log, 'down')).toHaveLength(0);
  });

  it('every input action refuses to move when the viewport is unknown', async () => {
    const { pace, log, locator, select } = setup(testProfile(), 1, {
      view: null,
    });
    const loc = locator([BOX]);
    const sel = select({ disabled: [false, false], checked: 0 }).loc;
    const actions: (() => Promise<void>)[] = [
      () => pace.click(loc),
      () => pace.type(loc, 'x'),
      () => pace.glance(loc),
      () => pace.pick(sel, 1),
      () => pace.upload(loc, '/tmp/f.pdf'),
      () => pace.scroll(loc, 1),
    ];
    for (const act of actions) {
      await expect(act()).rejects.toThrow(/viewport unknown/);
    }
    expect(of(log, 'move')).toHaveLength(0);
    expect(of(log, 'down')).toHaveLength(0);
    expect(of(log, 'wheel')).toHaveLength(0);
  });

  it('uses deps.viewport when the page reports none', async () => {
    const small = { width: 640, height: 400 };
    const depView = vi.fn(async () => small);
    const { pace, log, locator } = setup(testProfile(), 1, {
      view: null,
      depView,
    });
    await pace.click(locator([{ x: 300, y: 200, width: 60, height: 24 }]));
    expect(depView).toHaveBeenCalled();
    for (const m of of(log, 'move')) {
      expect(m.x).toBeLessThan(small.width);
      expect(m.y).toBeLessThan(small.height);
    }
    // Below the reported viewport: refused.
    await expect(
      pace.click(locator([{ x: 300, y: 450, width: 60, height: 24 }])),
    ).rejects.toThrow(/off-screen/);
    expect(of(log, 'down')).toHaveLength(1);
  });

  describe('an off-screen target', () => {
    /** Wheel events split where the gap is at least a second (as measures do). */
    const bursts = (log: Ev[]) => {
      const out: (Ev & { kind: 'wheel' })[][] = [];
      let last: number | null = null;
      for (const w of of(log, 'wheel')) {
        if (last === null || w.t - last >= 1000) out.push([]);
        out[out.length - 1].push(w);
        last = w.t;
      }
      return out;
    };

    it('click scrolls down in wheel bursts over the target column, then clicks it', async () => {
      const f = setup();
      const below: Box = { x: 600, y: 1700, width: 200, height: 96 };
      await f.pace.click(f.scrolling(below));
      const wheels = of(f.log, 'wheel');
      expect(wheels.length).toBeGreaterThan(0);
      expect(wheels.every((w) => w.dy === 100 && w.dx === 0)).toBe(true);
      const b = bursts(f.log);
      expect(b.length).toBeGreaterThan(1);
      for (const burst of b) {
        expect(burst.length).toBeLessThanOrEqual(3);
        for (let i = 1; i < burst.length; i++) {
          expect(burst[i].t - burst[i - 1].t).toBeCloseTo(120);
        }
      }
      // The pointer rests over the target's column, mid-window, while wheeling.
      const moves = of(f.log, 'move');
      const atWheel = moves.filter((m) => m.t <= wheels[0].t).at(-1);
      expect(atWheel?.x).toBeGreaterThanOrEqual(below.x);
      expect(atWheel?.x).toBeLessThan(below.x + below.width);
      expect(atWheel?.y).toBeGreaterThan(VIEW.height * 0.3);
      expect(atWheel?.y).toBeLessThan(VIEW.height * 0.7);
      // Scrolled until the whole target is in the window, then pressed on it.
      const scrolled = wheels.reduce((n, w) => n + w.dy, 0);
      const final = { ...below, y: below.y - scrolled };
      expect(final.y).toBeGreaterThanOrEqual(0);
      expect(final.y + final.height).toBeLessThanOrEqual(VIEW.height);
      const down = of(f.log, 'down')[0];
      expect(f.log.indexOf(down)).toBeGreaterThan(
        f.log.indexOf(wheels.at(-1) as Ev),
      );
      const press = moves.filter((m) => m.t <= down.t).at(-1);
      expect(press && inside(press, final)).toBe(true);
    });

    it('scrolls up to a target above the window', async () => {
      const f = setup();
      const above: Box = { x: 200, y: -900, width: 120, height: 36 };
      await f.pace.click(f.scrolling(above));
      const wheels = of(f.log, 'wheel');
      expect(wheels.length).toBeGreaterThan(0);
      expect(wheels.every((w) => w.dy === -100)).toBe(true);
      expect(of(f.log, 'down')).toHaveLength(1);
    });

    it('does not scroll a target already in view', async () => {
      const f = setup();
      await f.pace.click(f.scrolling(BOX));
      expect(of(f.log, 'wheel')).toHaveLength(0);
    });

    it('gives up when scrolling does not move the target', async () => {
      const f = setup();
      const below: Box = { x: 100, y: 2000, width: 80, height: 30 };
      await expect(f.pace.click(f.locator([below]))).rejects.toThrow(
        /off-screen/,
      );
      expect(of(f.log, 'wheel').length).toBeGreaterThan(0);
      expect(of(f.log, 'wheel').length).toBeLessThanOrEqual(6);
      expect(of(f.log, 'down')).toHaveLength(0);
    });

    it('a target that moves only after a slow settle is not counted as stuck', async () => {
      const f = setup();
      // One burst of two notches brings it into view, but the page shows
      // each wheel only 450 ms later: after the usual 300 ms settle it
      // still looks unmoved.
      const below: Box = { x: 600, y: 790, width: 120, height: 36 };
      await f.pace.click(f.lagging(below, 450));
      expect(of(f.log, 'wheel')).toHaveLength(2);
      expect(of(f.log, 'down')).toHaveLength(1);
    });

    it('stops after 40 notches when the target is still off-screen', async () => {
      const f = setup();
      // Each 100 px notch moves this page by only 10 px.
      const far: Box = { x: 100, y: 5000, width: 80, height: 30 };
      await expect(f.pace.click(f.scrolling(far, 0.1))).rejects.toThrow(
        /off-screen/,
      );
      expect(of(f.log, 'wheel')).toHaveLength(40);
      expect(of(f.log, 'down')).toHaveLength(0);
    });

    it('refuses a target off to the side without scrolling', async () => {
      const f = setup();
      const side: Box = { x: 3000, y: 300, width: 80, height: 30 };
      await expect(f.pace.click(f.scrolling(side))).rejects.toThrow(
        /off-screen/,
      );
      expect(of(f.log, 'wheel')).toHaveLength(0);
    });
  });

  describe('a target inside a scrolling box (within)', () => {
    /** A dialog whose visible bottom edge is 200 px above the window's. */
    const DIALOG: Box = { x: 340, y: 100, width: 600, height: 500 };
    const bottom = (b: Box) => b.y + b.height;
    const right = (b: Box) => b.x + b.width;
    const inBox = (inner: Box, outer: Box) =>
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      right(inner) <= right(outer) &&
      bottom(inner) <= bottom(outer);

    it('wheels over the box until the target is inside it, then presses', async () => {
      const f = setup();
      // In the window (800 px tall), below the dialog's visible bottom.
      const below: Box = { x: 700, y: 650, width: 120, height: 36 };
      await f.pace.click(f.scrolling(below), {
        within: f.locator([DIALOG]),
      });
      const wheels = of(f.log, 'wheel');
      expect(wheels.length).toBeGreaterThan(0);
      expect(wheels.every((w) => w.dy > 0)).toBe(true);
      // The pointer rests inside the dialog while wheeling.
      const moves = of(f.log, 'move');
      for (const w of wheels) {
        const at = moves.filter((m) => m.t <= w.t).at(-1);
        expect(at && inside(at, DIALOG)).toBe(true);
      }
      // One press, after the last wheel, with the whole target in the dialog.
      const downs = of(f.log, 'down');
      expect(downs).toHaveLength(1);
      const down = downs[0];
      expect(f.log.indexOf(down)).toBeGreaterThan(
        f.log.indexOf(wheels.at(-1) as Ev),
      );
      const scrolled = wheels.reduce((n, w) => n + w.dy, 0);
      const final = { ...below, y: below.y - scrolled };
      expect(inBox(final, DIALOG)).toBe(true);
      const press = moves.filter((m) => m.t <= down.t).at(-1);
      expect(press && inside(press, final)).toBe(true);
      expect(press && inside(press, DIALOG)).toBe(true);
    });

    it('re-reads the box on every reveal iteration', async () => {
      const f = setup();
      const within = f.locator([DIALOG]);
      const reads = vi.spyOn(within, 'boundingBox');
      const below: Box = { x: 700, y: 900, width: 120, height: 36 };
      await f.pace.click(f.scrolling(below), { within });
      const bursts = of(f.log, 'wheel').length;
      expect(bursts).toBeGreaterThan(1);
      // At least once per reveal iteration (a burst and the final check).
      expect(reads.mock.calls.length).toBeGreaterThan(2);
    });

    for (const [name, stuck] of [
      ['below the box', { x: 700, y: 650, width: 120, height: 36 }],
      ['across its bottom edge', { x: 700, y: 590, width: 120, height: 36 }],
    ] as const) {
      it(`throws a pace: error and never presses a target stuck ${name}`, async () => {
        const f = setup();
        await expect(
          f.pace.click(f.locator([stuck]), { within: f.locator([DIALOG]) }),
        ).rejects.toThrow(/^pace: /);
        expect(of(f.log, 'wheel').length).toBeGreaterThan(0);
        expect(of(f.log, 'wheel').length).toBeLessThanOrEqual(6);
        expect(of(f.log, 'down')).toHaveLength(0);
      });
    }

    it('stops after 40 notches when the target is still outside the box', async () => {
      const f = setup();
      const far: Box = { x: 700, y: 5000, width: 80, height: 30 };
      await expect(
        f.pace.click(f.scrolling(far, 0.1), { within: f.locator([DIALOG]) }),
      ).rejects.toThrow(/^pace: /);
      expect(of(f.log, 'wheel')).toHaveLength(40);
      expect(of(f.log, 'down')).toHaveLength(0);
    });

    it('does not press when the press-time read finds the target outside the box', async () => {
      const f = setup();
      const target: Box = { x: 700, y: 500, width: 120, height: 36 };
      // The dialog shrinks after the approach: the target is now below it.
      const shrunk: Box = { ...DIALOG, height: 300 };
      await expect(
        f.pace.click(f.locator([target]), {
          within: f.locator([DIALOG, DIALOG, shrunk]),
        }),
      ).rejects.toThrow(/^pace: /);
      expect(of(f.log, 'down')).toHaveLength(0);
    });

    it('a within with no bounding box is refused and nothing is pressed or wheeled', async () => {
      const f = setup();
      const gone = {
        boundingBox: async () => null,
      } as unknown as Locator;
      await expect(
        f.pace.click(f.locator([BOX]), { within: gone }),
      ).rejects.toThrow(/^pace: /);
      expect(of(f.log, 'down')).toHaveLength(0);
      expect(of(f.log, 'wheel')).toHaveLength(0);
    });

    it('every targeted action keeps to the box', async () => {
      const stuck: Box = { x: 700, y: 650, width: 120, height: 36 };
      const acts: ((
        p: ReturnType<typeof setup>,
        within: Locator,
      ) => Promise<void>)[] = [
        (f, within) => f.pace.click(f.locator([stuck]), { within }),
        (f, within) => f.pace.type(f.locator([stuck]), 'x', { within }),
        (f, within) => f.pace.clear(f.locator([stuck]), { within }),
        (f, within) => f.pace.glance(f.locator([stuck]), { within }),
        (f, within) =>
          f.pace.pick(
            f.select({ disabled: [false, false], checked: 0 }).loc,
            1,
            { within },
          ),
        (f, within) =>
          f.pace.upload(f.locator([stuck]), 'C:\\r.pdf', { within }),
      ];
      // The select fake sits at BOX (y 500–536): shrink the dialog above it.
      const box: Box = { ...DIALOG, height: 350 };
      for (const act of acts) {
        const f = setup();
        await expect(act(f, f.locator([box]))).rejects.toThrow(/^pace: /);
        expect(of(f.log, 'down')).toHaveLength(0);
        expect(of(f.log, 'kdown')).toHaveLength(0);
      }
    });

    it('at the end of scroll, presses a target mostly inside the box, in its visible part', async () => {
      const f = setup();
      // 50 px tall; scrolling ends with its bottom 10 px (20%) below the box.
      const target: Box = { x: 700, y: 700, width: 120, height: 50 };
      await f.pace.click(f.scrolling(target, 1, 140), {
        within: f.locator([DIALOG]),
      });
      const downs = of(f.log, 'down');
      expect(downs).toHaveLength(1);
      const press = of(f.log, 'move')
        .filter((m) => m.t <= downs[0].t)
        .at(-1);
      // The visible part: y 560 to the dialog's bottom edge (600).
      expect(press && inside(press, { ...target, y: 560, height: 40 })).toBe(
        true,
      );
    });

    it('at the end of scroll, refuses a target only 30% inside the box', async () => {
      const f = setup();
      const target: Box = { x: 700, y: 700, width: 120, height: 50 };
      // Scrolling ends at y 585: 15 px of 50 inside the box.
      await expect(
        f.pace.click(f.scrolling(target, 1, 115), {
          within: f.locator([DIALOG]),
        }),
      ).rejects.toThrow(/^pace: /);
      expect(of(f.log, 'down')).toHaveLength(0);
    });

    it('without within, a click is the same as before', async () => {
      const a = setup();
      const b = setup();
      await a.pace.click(a.locator([BOX]));
      await b.pace.click(b.locator([BOX]), {});
      expect(b.log).toEqual(a.log);
    });
  });

  it('refuses a target under 4 px (a visually hidden input) as unusable, not off-screen', async () => {
    for (const tiny of [
      { x: 700, y: 500, width: 0.5, height: 20 },
      { x: 700, y: 500, width: 20, height: 0.9 },
      { x: 700, y: 1500, width: 0.5, height: 0.5 },
      { x: 700, y: 500, width: 1, height: 1 },
      { x: 700, y: 500, width: 3, height: 20 },
      { x: 700, y: 1500, width: 1, height: 1 },
    ]) {
      const f = setup();
      await expect(f.pace.click(f.locator([tiny]))).rejects.toThrow(
        'pace: target has no usable box (hidden or zero-size)',
      );
      expect(of(f.log, 'down')).toHaveLength(0);
      expect(of(f.log, 'wheel')).toHaveLength(0);
    }
  });

  it('accepts a 4×4 px target', async () => {
    const f = setup();
    await f.pace.click(f.locator([{ x: 700, y: 500, width: 4, height: 4 }]));
    expect(of(f.log, 'down')).toHaveLength(1);
  });

  it('never sends a move to where the pointer already is (Chrome reports it as a zero-movement pointermove)', async () => {
    // A box at the window's corner: overshoot and bulge points get clamped.
    const corner: Box = { x: VIEW.width - 30, y: 0, width: 30, height: 20 };
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { pace, log, locator } = setup(testProfile(), seed);
      await pace.click(locator([BOX]));
      await pace.click(locator([corner]));
      await pace.click(locator([BOX]));
      const moves = of(log, 'move');
      expect(moves.length).toBeGreaterThan(10);
      for (let i = 1; i < moves.length; i++) {
        const same =
          moves[i].x === moves[i - 1].x && moves[i].y === moves[i - 1].y;
        expect(same, `seed ${seed}, move ${i}`).toBe(false);
      }
    }
  });

  it('sends moves and keys without waiting for each ack', async () => {
    const { pace, locator, maxInFlight } = setup(testProfile(), 1, {
      slowAcks: true,
    });
    await pace.type(locator([BOX]), 'hello there');
    expect(maxInFlight()).toBeGreaterThan(1);
  });

  it('times the release from when the press was sent, not from its ack', async () => {
    const { pace, log, locator } = setup(testProfile(), 1, { downLag: 12 });
    await pace.click(locator([BOX]));
    const [down] = of(log, 'down');
    const [up] = of(log, 'up');
    expect(up.t - down.t).toBeCloseTo(90, 6);
  });

  it('holds keys in an open select from when each keydown was sent', async () => {
    const { pace, log, select } = setup(testProfile(), 1, { downLag: 12 });
    const s = select({ disabled: [false, false, false], checked: 0 });
    await pace.pick(s.loc, 2);
    const downs = of(log, 'kdown');
    for (const d of downs) {
      const u = log.find(
        (e) => e.kind === 'kup' && e.key === d.key && e.t >= d.t,
      );
      expect((u?.t ?? 0) - d.t).toBeCloseTo(70, 6);
    }
  });

  it("the hover before a press absorbs the box read's cost and the read stays last", async () => {
    for (const seed of [1, 2, 3]) {
      const { pace, log, locator } = setup(testProfile(), seed, {
        boxLag: 40,
      });
      await pace.click(locator([BOX]));
      const [down] = of(log, 'down');
      const before = log.slice(0, log.indexOf(down));
      const last = of(before, 'move').at(-1);
      // Hover 150 ms; the moving average of the read's cost is a few ms off.
      expect(down.t - (last?.t ?? 0)).toBeGreaterThanOrEqual(150);
      expect(down.t - (last?.t ?? 0)).toBeLessThan(165);
      expect(before.at(-1)?.kind).toBe('box');
    }
  });

  it('keeps moving while the box is read mid-stroke (no pause in the stroke)', async () => {
    const strokeOf = async (seed: number, boxLag: number) => {
      const { pace, log, locator } = setup(testProfile(), seed, { boxLag });
      await pace.click(locator([BOX]));
      const ev = afterBox(log);
      const moves = of(ev.slice(0, ev.indexOf(of(ev, 'down')[0])), 'move');
      return moves.map((m) => `${m.x},${m.y}@${(m.t - moves[0].t).toFixed(3)}`);
    };
    for (const seed of [1, 2, 3, 4]) {
      // A 40 ms read changes nothing in the stroke: it runs alongside it.
      expect(await strokeOf(seed, 40), `seed ${seed}`).toEqual(
        await strokeOf(seed, 0),
      );
    }
  });

  it('keyups name the physical key, so a key that outlives Shift comes up unshifted (R40)', async () => {
    // Holds of 300 ms against 100 ms gaps: Shift must come up before the
    // shifted key does, so it is not held into the next press.
    const { pace, log, locator } = setup(testProfile({ keyHold: flat(300) }));
    await pace.type(locator([BOX]), 'Bc!d');
    const ups = of(log, 'kup').filter((k) => k.key !== 'Shift');
    expect(ups.map((k) => k.key).sort()).toEqual(['1', 'b', 'c', 'd']);
    const shiftUps = of(log, 'kup').filter((k) => k.key === 'Shift');
    const bUp = ups.find((k) => k.key === 'b');
    expect(shiftUps[0].t).toBeLessThan(bUp?.t ?? 0);
    // Keydowns still name the character typed (Shift is down for them).
    expect(
      of(log, 'kdown')
        .filter((k) => k.key !== 'Shift')
        .map((k) => k.key),
    ).toEqual(['B', 'c', '!', 'd']);
  });

  it('a failed key send releases Shift and every key still down', async () => {
    const { pace, page, log, locator } = setup(
      testProfile({ keyHold: flat(300) }),
    );
    const down = page.keyboard.down.bind(page.keyboard);
    page.keyboard.down = async (key: string) => {
      if (key === 'C') throw new Error('relay gone');
      return down(key);
    };
    await expect(pace.type(locator([BOX]), 'aBCd')).rejects.toThrow(
      /relay gone/,
    );
    const keys = log.filter(
      (e): e is Ev & { kind: 'kdown' | 'kup'; key: string } =>
        e.kind === 'kdown' || e.kind === 'kup',
    );
    const stillDown = new Set<string>();
    for (const k of keys) {
      const id = physicalKey(k.key);
      if (k.kind === 'kdown') stillDown.add(id);
      else stillDown.delete(id);
    }
    expect([...stillDown]).toEqual([]);
    // Shift comes up last, after the keys it was shifting.
    expect(keys.at(-1)).toMatchObject({ kind: 'kup', key: 'Shift' });
    expect(of(log, 'kdown').map((k) => k.key)).not.toContain('d');
  });

  it('a failed move stops the stroke and the click rejects', async () => {
    const { pace, page, log, locator } = setup();
    let n = 0;
    const move = page.mouse.move.bind(page.mouse);
    page.mouse.move = async (x: number, y: number) => {
      if (++n === 5) throw new Error('relay gone');
      return move(x, y);
    };
    await expect(pace.click(locator([BOX]))).rejects.toThrow(/relay gone/);
    expect(of(log, 'move').length).toBeLessThan(6);
    expect(of(log, 'down')).toHaveLength(0);
  });

  it('lagging moves skip points instead of slowing the move', async () => {
    const quick = setup(testProfile(), 3);
    await quick.pace.click(quick.locator([BOX]));
    const slow = setup(testProfile(), 3, { moveLag: 40 });
    await slow.pace.click(slow.locator([BOX]));
    const span = (log: Ev[]) => {
      const ev = afterBox(log);
      const m = of(ev, 'move');
      return { n: m.length, end: m[m.length - 1].t - ev[0].t };
    };
    const a = span(quick.log);
    const b = span(slow.log);
    expect(b.n).toBeLessThan(a.n);
    // Lag shows up at most as one late move, never as a stretched path.
    expect(b.end - a.end).toBeLessThanOrEqual(2 * 40);
  });

  it('type clicks the field first and never sends Tab or Enter', async () => {
    const { pace, log, locator } = setup();
    await pace.type(locator([BOX]), 'Hi there ok');
    const up = of(log, 'up')[0];
    const firstKey = log.find((e) => e.kind === 'kdown' || e.kind === 'text');
    expect(firstKey && log.indexOf(firstKey)).toBeGreaterThan(log.indexOf(up));
    expect((firstKey?.t ?? 0) - up.t).toBeCloseTo(500);
    const keys = log.filter(
      (e): e is Ev & { kind: 'kdown' | 'kup' | 'text'; key: string } =>
        e.kind === 'kdown' || e.kind === 'kup' || e.kind === 'text',
    );
    for (const k of keys) {
      expect(['Tab', 'Enter', '\t', '\n', '\r']).not.toContain(
        k.kind === 'text' ? '' : k.key,
      );
    }
    const typed = keys
      .filter((k) => k.kind !== 'kup' && k.key !== 'Shift')
      .map((k) => k.key)
      .join('');
    expect(typed).toBe('Hi there ok');
    const holds = of(log, 'kdown')
      .filter((d) => d.key !== 'Shift')
      .map((d) => {
        const u = log.find(
          (e) => e.kind === 'kup' && e.key === physicalKey(d.key) && e.t >= d.t,
        );
        return (u?.t ?? 0) - d.t;
      });
    expect(holds.every((h) => h === 70)).toBe(true);
  });

  it.each([
    ['alpha\nbravo', /1 newline/],
    ['a\tb', /1 tab/],
    ['café, naïve', /2 non-ASCII/],
    ['zulu 😀', /1 non-ASCII/],
    ['xray\u0007\r\n', /1 control, 2 newline/],
  ])(
    'type refuses %j before moving: no click, no key, no text',
    async (text, msg) => {
      const { pace, log, locator } = setup();
      const err = await pace.type(locator([BOX]), text).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(msg);
      expect(err?.message).toMatch(/nothing typed/);
      // The message never carries the text itself.
      for (const word of ['alpha', 'bravo', 'caf', 'zulu', 'xray']) {
        expect(err?.message).not.toContain(word);
      }
      expect(log).toEqual([]);
    },
  );

  it('type sends no key when the field did not take focus', async () => {
    const { pace, log, locator } = setup();
    const unfocused = locator([BOX], {
      and: () => ({ count: async () => 0 }),
    });
    await expect(pace.type(unfocused, 'abc')).rejects.toThrow(
      'pace: the field did not take focus; no keys sent',
    );
    expect(of(log, 'up')).toHaveLength(1);
    expect(of(log, 'kdown')).toHaveLength(0);
    expect(of(log, 'kup')).toHaveLength(0);
    expect(of(log, 'text')).toHaveLength(0);
  });

  it('clear selects all then deletes', async () => {
    const { pace, log, locator } = setup();
    await pace.clear(locator([BOX]));
    expect(of(log, 'up')).toHaveLength(1);
    const keys = log
      .filter((e) => e.kind === 'kdown' || e.kind === 'kup')
      .map((e) => `${e.kind}:${(e as { key: string }).key}`);
    expect(keys).toEqual([
      'kdown:Control',
      'kdown:a',
      'kup:a',
      'kup:Control',
      'kdown:Backspace',
      'kup:Backspace',
    ]);
    expect(of(log, 'text')).toHaveLength(0);
  });

  it('clear sends nothing without focus', async () => {
    const { pace, log, locator } = setup();
    const unfocused = locator([BOX], {
      and: () => ({ count: async () => 0 }),
    });
    await expect(pace.clear(unfocused)).rejects.toThrow(
      'pace: the field did not take focus; no keys sent',
    );
    expect(of(log, 'kdown')).toHaveLength(0);
    expect(of(log, 'kup')).toHaveLength(0);
  });

  it('clear still tries to release Control when its keyup fails', async () => {
    const { pace, page, locator } = setup();
    const ups: string[] = [];
    const real = page.keyboard.up.bind(page.keyboard);
    let failed = false;
    page.keyboard.up = async (key: string) => {
      ups.push(key);
      if (key === 'Control' && !failed) {
        failed = true;
        throw new Error('relay gone');
      }
      await real(key);
    };
    await expect(pace.clear(locator([BOX]))).rejects.toThrow('relay gone');
    expect(ups.filter((k) => k === 'Control')).toHaveLength(2);
  });

  it('type sends Enter for a newline in a textarea', async () => {
    const { pace, log, locator } = setup();
    const asked: string[] = [];
    const area = locator([BOX], {
      locator: (sel: string) => {
        asked.push(sel);
        return { count: async () => 1 };
      },
    });
    await pace.type(area, 'a\nb');
    expect(asked).toEqual(['xpath=self::textarea']);
    const downs = of(log, 'kdown').map((e) => e.key);
    expect(downs).toEqual(['a', 'Enter', 'b']);
    const ups = of(log, 'kup').map((e) => e.key);
    expect(ups).toEqual(['a', 'Enter', 'b']);
  });

  it('type throws on a newline in an input before moving', async () => {
    const { pace, log, locator } = setup();
    const input = locator([BOX], {
      locator: () => ({ count: async () => 0 }),
    });
    await expect(pace.type(input, 'a\nb')).rejects.toThrow(/1 newline/);
    expect(log).toEqual([]);
  });

  it('type checks focus on the field itself, after the click', async () => {
    const { pace, log, locator } = setup();
    const asked: { pseudo: string; afterUp: boolean }[] = [];
    const field = locator([BOX], {
      and: (other: { pseudo: string }) => {
        asked.push({
          pseudo: other.pseudo,
          afterUp: log.some((e) => e.kind === 'up'),
        });
        return { count: async () => 1 };
      },
    });
    await pace.type(field, 'ab');
    expect(asked).toEqual([{ pseudo: ':focus', afterUp: true }]);
  });

  it('type holds Shift over capitals and shifted symbols, as a keyboard needs', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { pace, log, locator } = setup(testProfile(), seed);
      await pace.type(locator([BOX]), 'Ab@Cd!e AB?x');
      const keys = log.filter(
        (e): e is Ev & { kind: 'kdown' | 'kup'; key: string } =>
          e.kind === 'kdown' || e.kind === 'kup',
      );
      // Replay the key stream with the Shift state.
      let shift = false;
      const seen: string[] = [];
      for (const k of keys) {
        if (k.key === 'Shift') {
          expect(shift, `seed ${seed}: Shift ${k.kind}`).toBe(k.kind === 'kup');
          shift = k.kind === 'kdown';
          continue;
        }
        if (k.kind !== 'kdown') continue;
        const needs = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(k.key);
        expect(shift, `seed ${seed}: ${k.key}`).toBe(needs);
        seen.push(k.key);
      }
      expect(shift).toBe(false);
      expect(seen.join('')).toBe('Ab@Cd!e AB?x');
      // One Shift hold covers a run of shifted characters.
      const shiftDowns = keys.filter(
        (k) => k.key === 'Shift' && k.kind === 'kdown',
      );
      expect(shiftDowns).toHaveLength(4);
      // Shift goes down before the key it modifies, never at the same moment.
      for (const d of shiftDowns) {
        const next = keys.find(
          (k) => k.kind === 'kdown' && k.key !== 'Shift' && k.t >= d.t,
        );
        expect((next?.t ?? 0) - d.t).toBeGreaterThan(0);
      }
    }
  });

  it('holds keys for calibrated true holds, worked out once per pace (R37)', async () => {
    vi.mocked(calibrateHolds).mockClear();
    vi.mocked(calibrateHolds).mockReturnValueOnce([33, 33, 33]);
    const { pace, log, locator, select } = setup();
    await pace.type(locator([BOX]), 'abc');
    const s = select({ disabled: [false, false, false], checked: 0 });
    await pace.pick(s.loc, 1);
    const downs = of(log, 'kdown');
    expect(downs.length).toBeGreaterThan(3);
    for (const d of downs) {
      const u = log.find(
        (e) => e.kind === 'kup' && e.key === d.key && e.t >= d.t,
      );
      expect((u?.t ?? 0) - d.t).toBeCloseTo(33, 6);
    }
    expect(calibrateHolds).toHaveBeenCalledTimes(1);
  });

  it('glance sends no keys', async () => {
    const { pace, log, locator } = setup();
    await pace.glance(locator([BOX]));
    expect(of(log, 'kdown')).toHaveLength(0);
    expect(of(log, 'text')).toHaveLength(0);
    expect(of(log, 'down')).toHaveLength(0);
    const last = of(log, 'move').at(-1);
    expect(last && inside(last, BOX)).toBe(true);
  });

  it('scroll sends wheel events of profile.wheel.deltaY with wheelGap gaps, after moving over the area', async () => {
    const { pace, log, locator } = setup();
    const area = locator([{ x: 100, y: 100, width: 900, height: 2400 }]);
    await pace.scroll(area);
    const wheels = of(log, 'wheel');
    expect(wheels.map((w) => w.dy)).toEqual([100, 100, 100]);
    expect(wheels.map((w) => w.dx)).toEqual([0, 0, 0]);
    expect(wheels[1].t - wheels[0].t).toBeCloseTo(120);
    expect(wheels[2].t - wheels[1].t).toBeCloseTo(120);
    const lastMove = of(log, 'move').at(-1);
    expect(log.indexOf(lastMove as Ev)).toBeLessThan(log.indexOf(wheels[0]));
    expect(lastMove?.y).toBeLessThan(VIEW.height);

    await pace.scroll(area, -2);
    expect(
      of(log, 'wheel')
        .slice(3)
        .map((w) => w.dy),
    ).toEqual([-100, -100]);
  });

  it('read(null) uses readDwell samples; read(2500) uses the reading model', async () => {
    const p = testProfile();
    p.reading = { base: 2000, perChar: 3, residuals: [50, 50] };
    const { pace, clock } = setup(p);
    let t0 = clock.now();
    await pace.read(null);
    expect(clock.now() - t0).toBeCloseTo(5000);
    t0 = clock.now();
    await pace.read(2500);
    expect(clock.now() - t0).toBe(2000 + 3 * 2500 + 50);
  });

  it('read(chars) falls back to readDwell without a reading model', async () => {
    const p = testProfile();
    p.reading = null;
    const { pace, clock } = setup(p);
    const t0 = clock.now();
    await pace.read(2500);
    expect(clock.now() - t0).toBeCloseTo(5000);
  });

  it('pause draws afterTypingToMove, with a long-pause tail', async () => {
    const a = setup();
    let t0 = a.clock.now();
    await a.pace.pause();
    expect(a.clock.now() - t0).toBeCloseTo(400);
    const b = setup(testProfile({ longPauseRate: flat(1) }));
    t0 = b.clock.now();
    await b.pace.pause();
    expect(b.clock.now() - t0).toBeCloseTo(400 + 4000);
  });

  it('mood scales dwell, read and pause durations but not sampleInterval or keyHold', async () => {
    const run = async (factor: number) => {
      const s = setup(testProfile({ appSpeedFactor: flat(factor) }), 11);
      const time = async (f: () => Promise<void>) => {
        const t0 = s.clock.now();
        await f();
        return s.clock.now() - t0;
      };
      const read = await time(() => s.pace.read(null));
      const pause = await time(() => s.pace.pause());
      await s.pace.glance(s.locator([BOX]));
      const glanceEnd = s.clock.now() - (of(s.log, 'move').at(-1)?.t ?? 0);
      const at = s.log.length;
      await s.pace.type(s.locator([BOX]), 'a');
      const ev = s.log.slice(at);
      const moves = of(ev, 'move');
      const gaps = moves.slice(1).map((m, i) => m.t - moves[i].t);
      const [kd] = of(ev, 'kdown');
      const [ku] = of(ev, 'kup');
      return {
        mood: s.pace.mood,
        read,
        pause,
        glanceEnd,
        gaps,
        hold: ku.t - kd.t,
      };
    };
    const one = await run(1);
    const two = await run(2);
    expect(one.mood).toBe(1);
    expect(two.mood).toBe(2);
    expect(two.read).toBeCloseTo(2 * one.read);
    expect(two.pause).toBeCloseTo(2 * one.pause);
    expect(two.glanceEnd).toBeCloseTo(2 * one.glanceEnd);
    expect(two.gaps).toHaveLength(one.gaps.length);
    two.gaps.forEach((g, i) => expect(g).toBeCloseTo(one.gaps[i], 6));
    expect(two.hold).toBe(one.hold);
  });

  it('mood is drawn from appSpeedFactor', () => {
    expect(setup(testProfile({ appSpeedFactor: flat(1.3) })).pace.mood).toBe(
      1.3,
    );
    const moods = Array.from(
      { length: 50 },
      (_, i) =>
        setup(testProfile({ appSpeedFactor: [0.8, 0.9, 1.1, 1.2] }), i).pace
          .mood,
    );
    expect(Math.min(...moods)).toBeGreaterThan(0.5);
    expect(Math.max(...moods)).toBeLessThan(1.6);
    expect(new Set(moods).size).toBeGreaterThan(40);
  });

  it('upload clicks the button inside deps.uploadOnChooser, which sets the file', async () => {
    const { pace, log, locator, uploadOnChooser } = setup();
    await pace.upload(locator([BOX]), 'C:\\x\\resume.pdf');
    expect(uploadOnChooser).toHaveBeenCalledOnce();
    const chooser = log.findIndex((e) => e.kind === 'chooser');
    const down = log.findIndex((e) => e.kind === 'down');
    const files = log.findIndex((e) => e.kind === 'files');
    expect(chooser).toBeGreaterThanOrEqual(0);
    expect(chooser).toBeLessThan(down);
    expect(files).toBeGreaterThan(down);
    expect(log[files]).toMatchObject({ arg: 'C:\\x\\resume.pdf' });
  });

  it('upload waits a mood-scaled fileChooserDwell between the chooser opening and the files', async () => {
    for (const [factor, wait] of [
      [1, 4500],
      [2, 9000],
    ]) {
      const { pace, log, locator } = setup(
        testProfile({
          fileChooserDwell: flat(4500),
          appSpeedFactor: flat(factor),
        }),
      );
      await pace.upload(locator([BOX]), 'C:\\r.pdf');
      const opened = log.find(
        (e) => e.kind === 'chooser' && e.arg === 'opened',
      );
      const files = log.find((e) => e.kind === 'files');
      expect((files?.t ?? 0) - (opened?.t ?? 0)).toBeCloseTo(wait);
    }
  });

  it('upload refuses without deps.uploadOnChooser (no script-set files)', async () => {
    const { pace, log, locator } = setup(testProfile(), 1, { noUpload: true });
    await expect(pace.upload(locator([BOX]), '/tmp/r.pdf')).rejects.toThrow(
      /uploadOnChooser/,
    );
    expect(of(log, 'move')).toHaveLength(0);
  });

  describe('pick on a select', () => {
    const keys = (log: Ev[]) =>
      log.filter(
        (e): e is Ev & { kind: 'kdown' | 'kup'; key: string } =>
          e.kind === 'kdown' || e.kind === 'kup',
      );

    it('clicks it, waits pickDwell, then presses ArrowDown n times and Enter', async () => {
      const f = setup();
      const s = f.select({
        disabled: [false, false, false, false],
        checked: 0,
      });
      await f.pace.pick(s.loc, 2);
      const up = of(f.log, 'up')[0];
      const k = keys(f.log);
      expect(k.map((e) => `${e.kind}:${e.key}`)).toEqual([
        'kdown:ArrowDown',
        'kup:ArrowDown',
        'kdown:ArrowDown',
        'kup:ArrowDown',
        'kdown:Enter',
        'kup:Enter',
      ]);
      expect(f.log.indexOf(k[0])).toBeGreaterThan(f.log.indexOf(up));
      expect(k[0].t - up.t).toBeCloseTo(600);
      // keyHold 70 per press, keyGapInWord 100 between presses.
      expect(k[1].t - k[0].t).toBe(70);
      expect(k[2].t - k[1].t).toBe(100);
      expect(k[5].t - k[4].t).toBe(70);
      expect(of(f.log, 'select')).toHaveLength(0);
      expect(s.checked()).toBe(2);
      // Focus and the open list are checked once, after the click.
      expect(s.selectors.filter((x) => x.startsWith('and '))).toEqual([
        'and :focus',
        'and :open',
      ]);
    });

    it('goes up with ArrowUp and skips disabled options', async () => {
      const f = setup();
      const s = f.select({ disabled: [false, true, false, false], checked: 3 });
      await f.pace.pick(s.loc, 0);
      expect(of(f.log, 'kdown').map((e) => e.key)).toEqual([
        'ArrowUp',
        'ArrowUp',
        'Enter',
      ]);
      expect(s.checked()).toBe(0);
    });

    it('presses only Enter when the option is already picked', async () => {
      const f = setup();
      const s = f.select({ disabled: [false, false], checked: 1 });
      await f.pace.pick(s.loc, 1);
      expect(of(f.log, 'kdown').map((e) => e.key)).toEqual(['Enter']);
    });

    it('refuses a disabled or missing option, option groups and multiple selects before clicking', async () => {
      for (const [sel, index] of [
        [{ disabled: [false, true], checked: 0 }, 1],
        [{ disabled: [false, false], checked: 0 }, 2],
        [{ disabled: [false, false], checked: 0, optgroups: 1 }, 1],
        [{ disabled: [false, false], checked: 0, multiple: true }, 1],
        [{ disabled: [false, false], checked: -1 }, 1],
        [{ disabled: [false, false], checked: 0, selfDisabled: true }, 1],
      ] as [FakeSelect, number][]) {
        const f = setup();
        await expect(f.pace.pick(f.select(sel).loc, index)).rejects.toThrow(
          /pace: /,
        );
        expect(of(f.log, 'down')).toHaveLength(0);
        expect(of(f.log, 'kdown')).toHaveLength(0);
      }
    });

    it('throws when the select did not take the option', async () => {
      const f = setup();
      const s = f.select({
        disabled: [false, false, false],
        checked: 0,
        commits: false,
      });
      await expect(f.pace.pick(s.loc, 2)).rejects.toThrow(/did not take/);
    });

    it('refuses a disabled select with no click and no keys', async () => {
      const f = setup();
      const s = f.select({
        disabled: [false, false],
        checked: 0,
        selfDisabled: true,
      });
      await expect(f.pace.pick(s.loc, 1)).rejects.toThrow(/select is disabled/);
      expect(of(f.log, 'move')).toHaveLength(0);
      expect(of(f.log, 'down')).toHaveLength(0);
      expect(of(f.log, 'kdown')).toHaveLength(0);
    });

    it('sends no keys when the click did not focus the select', async () => {
      const f = setup();
      const s = f.select({
        disabled: [false, false],
        checked: 0,
        focuses: false,
      });
      await expect(f.pace.pick(s.loc, 1)).rejects.toThrow(
        /did not take focus.*no keys sent/,
      );
      expect(of(f.log, 'down')).toHaveLength(1);
      expect(of(f.log, 'kdown')).toHaveLength(0);
      expect(s.checked()).toBe(0);
    });

    it('sends no keys when the select is focused but its list did not open', async () => {
      const f = setup();
      const s = f.select({
        disabled: [false, false],
        checked: 0,
        opens: false,
      });
      await expect(f.pace.pick(s.loc, 1)).rejects.toThrow(
        /did not open.*no keys sent/,
      );
      expect(of(f.log, 'kdown')).toHaveLength(0);
    });
  });

  describe('pick on a radio group', () => {
    const labelBoxes: Box[] = [
      { x: 300, y: 300, width: 60, height: 20 },
      { x: 300, y: 340, width: 60, height: 20 },
    ];
    const radioBoxes: Box[] = [
      { x: 280, y: 302, width: 14, height: 14 },
      { x: 280, y: 342, width: 14, height: 14 },
    ];

    /**
     * A fieldset fake: each radio has an id (or none), an optional
     * `label[for]` in the group, and an optional wrapping label.
     */
    function group(
      f: ReturnType<typeof setup>,
      radios: { id: string | null; forLabel: boolean; wrapped: boolean }[],
      selectors: string[],
    ) {
      const none = { count: async () => 0 };
      const found = (box: Box) => {
        const l = f.locator([box]);
        return Object.assign(l, { count: async () => 1, first: () => l });
      };
      const radioLocs = radios.map((r, i) =>
        Object.assign(f.locator([radioBoxes[i]]), {
          getAttribute: async (name: string) => (name === 'id' ? r.id : null),
          locator: (sel: string) => {
            selectors.push(sel);
            return sel === 'xpath=ancestor::label' && r.wrapped
              ? found(labelBoxes[i])
              : { first: () => none };
          },
        }),
      );
      return f.locator([BOX], {
        locator: (sel: string) => {
          selectors.push(sel);
          if (sel === 'input[type="radio"]') {
            return {
              count: async () => radios.length,
              nth: (i: number) => radioLocs[i],
            };
          }
          const m = /^label\[for="(.*)"\]$/.exec(sel);
          const i = radios.findIndex(
            (r) =>
              r.forLabel &&
              r.id !== null &&
              m?.[1] === r.id.replace(/["\\]/g, '\\$&'),
          );
          return { first: () => (i >= 0 ? found(labelBoxes[i]) : none) };
        },
      });
    }

    const lastMove = (f: ReturnType<typeof setup>) => of(f.log, 'move').at(-1);

    it("clicks the nth radio's label[for]", async () => {
      const f = setup();
      const sel: string[] = [];
      const g = group(
        f,
        [
          { id: 'auth-yes', forLabel: true, wrapped: false },
          { id: 'a"b', forLabel: true, wrapped: false },
        ],
        sel,
      );
      await f.pace.pick(g, 1);
      expect(sel).toContain('label[for="a\\"b"]');
      const last = lastMove(f);
      expect(last && inside(last, labelBoxes[1])).toBe(true);
      expect(of(f.log, 'select')).toHaveLength(0);
      expect(of(f.log, 'down')).toHaveLength(1);
    });

    it('falls back to the wrapping label', async () => {
      const f = setup();
      const g = group(
        f,
        [
          { id: null, forLabel: false, wrapped: true },
          { id: null, forLabel: false, wrapped: true },
        ],
        [],
      );
      await f.pace.pick(g, 0);
      const last = lastMove(f);
      expect(last && inside(last, labelBoxes[0])).toBe(true);
    });

    it('falls back to the radio itself', async () => {
      const f = setup();
      const g = group(
        f,
        [
          { id: 'x', forLabel: false, wrapped: false },
          { id: 'y', forLabel: false, wrapped: false },
        ],
        [],
      );
      await f.pace.pick(g, 1);
      const last = lastMove(f);
      expect(last && inside(last, radioBoxes[1])).toBe(true);
    });
  });

  it('maybe follows the profile rates', () => {
    const { pace } = setup();
    expect(pace.maybe('expand-description')).toBe(true);
    expect(pace.maybe('scroll-description')).toBe(false);
  });

  it('measures with fewer than 2 samples fall back to DEFAULTS and are listed', async () => {
    const p = testProfile({ sampleInterval: [16], pathDeviation: undefined });
    const { pace, locator, log } = setup(p);
    expect(pace.defaulted).toContain('sampleInterval');
    expect(pace.defaulted).toContain('pathDeviation');
    expect(pace.defaulted).not.toContain('readDwell');
    await pace.click(locator([BOX]));
    expect(of(log, 'up')).toHaveLength(1);
  });

  it('createPace without deps.rng uses cryptoRng', () => {
    const spy = vi.mocked(cryptoRng);
    spy.mockClear();
    const f = fake();
    createPace(f.page, testProfile(), { rng: seededRng(1) });
    expect(spy).not.toHaveBeenCalled();
    createPace(f.page, testProfile());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
