import type { Locator, Page } from 'patchright-core';
import type { Box } from './mouse.js';
import { createPace } from './pace.js';
import type { PaceProfile } from './profile.js';
import { cryptoRng, seededRng } from './rng.js';
import { flat, testProfile } from './testing/profiles.js';

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

const VIEW = { width: 1280, height: 800 };

type View = { width: number; height: number } | null;
interface Opts {
  moveLag?: number;
  /** What `page.viewportSize()` returns (default VIEW). */
  view?: View;
  /** `deps.viewport`, when given. */
  depView?: () => Promise<View>;
}

function fake(opts: Opts = {}) {
  let t = 1000;
  const log: Ev[] = [];
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += Math.max(0, ms);
    },
  };
  const page = {
    mouse: {
      move: async (x: number, y: number) => {
        log.push({ kind: 'move', t, x, y });
        t += opts.moveLag ?? 0;
      },
      down: async () => void log.push({ kind: 'down', t }),
      up: async () => void log.push({ kind: 'up', t }),
      wheel: async (dx: number, dy: number) =>
        void log.push({ kind: 'wheel', t, dx, dy }),
    },
    keyboard: {
      down: async (key: string) => void log.push({ kind: 'kdown', t, key }),
      up: async (key: string) => void log.push({ kind: 'kup', t, key }),
      insertText: async (key: string) =>
        void log.push({ kind: 'text', t, key }),
    },
    viewportSize: () => (opts.view === undefined ? VIEW : opts.view),
    waitForEvent: vi.fn(async (event: string) => {
      log.push({ kind: 'chooser', t, arg: event });
      // The chooser arrives once the button is pressed.
      await new Promise((r) => setImmediate(r));
      return {
        setFiles: async (files: string) =>
          void log.push({ kind: 'files', t, arg: files }),
      };
    }),
  };
  const locator = (boxes: Box[], extra: Record<string, unknown> = {}) => {
    let i = 0;
    return {
      boundingBox: async () => {
        log.push({ kind: 'box', t });
        return boxes[Math.min(i++, boxes.length - 1)];
      },
      selectOption: async (arg: unknown) =>
        void log.push({ kind: 'select', t, arg }),
      locator: () => ({ count: async () => 0 }),
      ...extra,
    } as unknown as Locator;
  };
  return { page: page as unknown as Page, log, clock, locator };
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
    const { pace, log, locator } = setup(testProfile(), 1, { view: null });
    const loc = locator([BOX]);
    const actions: (() => Promise<void>)[] = [
      () => pace.click(loc),
      () => pace.type(loc, 'x'),
      () => pace.glance(loc),
      () => pace.pick(loc, 0),
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

  it('click refuses a target outside the viewport', async () => {
    const { pace, log, locator } = setup();
    const below: Box = { x: 100, y: 2000, width: 80, height: 30 };
    await expect(pace.click(locator([below]))).rejects.toThrow(/off-screen/);
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
    await pace.type(locator([BOX]), 'Hi there\nok');
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
      .filter((k) => k.kind !== 'kup')
      .map((k) => k.key)
      .join('');
    expect(typed).toBe('Hi there\nok');
    const holds = of(log, 'kdown').map((d) => {
      const u = log.find(
        (e) => e.kind === 'kup' && e.key === d.key && e.t >= d.t,
      );
      return (u?.t ?? 0) - d.t;
    });
    expect(holds.every((h) => h === 70)).toBe(true);
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

  it('upload clicks the button with the file chooser intercepted and sets the file', async () => {
    const { pace, page, log, locator } = setup();
    await pace.upload(locator([BOX]), '/tmp/resume.pdf');
    expect(page.waitForEvent).toHaveBeenCalledWith('filechooser');
    const chooser = log.findIndex((e) => e.kind === 'chooser');
    const down = log.findIndex((e) => e.kind === 'down');
    const files = log.findIndex((e) => e.kind === 'files');
    expect(chooser).toBeGreaterThanOrEqual(0);
    expect(chooser).toBeLessThan(down);
    expect(files).toBeGreaterThan(down);
    expect(log[files]).toMatchObject({ arg: '/tmp/resume.pdf' });
  });

  it('pick on a select clicks it, waits pickDwell, then selects by index', async () => {
    const { pace, log, locator } = setup();
    await pace.pick(locator([BOX]), 2);
    const up = of(log, 'up')[0];
    const [sel] = of(log, 'select');
    expect(log.indexOf(sel)).toBeGreaterThan(log.indexOf(up));
    expect(sel.t - up.t).toBeCloseTo(600);
    expect(sel.arg).toEqual({ index: 2 });
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
