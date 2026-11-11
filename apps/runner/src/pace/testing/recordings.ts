import type {
  Actor,
  Ctx,
  PageInfo,
  RecordedEvent,
  Recording,
  Source,
  Target,
} from '../recording.js';
import type { Rng } from '../rng.js';

export const AUTHOR_WIN: PageInfo['win'] = {
  screenX: 100,
  screenY: 80,
  outerWidth: 1300,
  outerHeight: 800,
  innerWidth: 1290,
  innerHeight: 700,
};
export const RUNNER_WIN: PageInfo['win'] = {
  screenX: 100,
  screenY: 80,
  outerWidth: 1300,
  outerHeight: 800,
  innerWidth: 1284,
  innerHeight: 640,
};

export interface SynthOptions {
  actor: Actor;
  source: Source;
  jobKey: string;
  start?: number;
  win?: PageInfo['win'];
  dpr?: number;
  /**
   * The unit of sx/sy: 'css' (what Chrome reports at any OS scale) or
   * 'device' (CSS px times dpr).
   */
  screenUnit?: 'css' | 'device';
  /** A leak: screen coordinates equal the client ones. */
  screenIsClient?: boolean;
  /** Share of pointermoves reporting no movement (default 0.03). */
  zeroMoveShare?: number;
  /** Extra dwell at the start of each form step, ms (default 0). */
  stepPause?: number;
  /** pointerType of pointer events (default 'mouse'). */
  pointerType?: string;
  /** deltaY of wheel events (default 100). */
  wheelDelta?: number;
}

const gauss = (rng: Rng, mean: number, sd: number, min: number) => {
  const u = 1 - rng.next();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  return Math.max(min, mean + sd * z);
};
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * A made-up recording of one application: a wheel burst, Apply, a text field
 * with typing and Next, Next, then Submit on the review step. Every timing
 * comes from fixed distributions, so recordings from different seeds look
 * like the same person.
 */
export function synthRecording(opts: SynthOptions, rng: Rng): Recording {
  const win = opts.win ?? AUTHOR_WIN;
  const dpr = opts.dpr ?? 1.25;
  const unit = opts.screenUnit ?? 'css';
  const zeroShare = opts.zeroMoveShare ?? 0.03;
  const pointerType = opts.pointerType ?? 'mouse';
  const path =
    opts.source === 'practice'
      ? '/practice/'
      : opts.source === 'linkedin'
        ? '/jobs/view/:id/'
        : '/test-page/';
  const bw = (win.outerWidth - win.innerWidth) / 2;
  const originX = win.screenX + bw;
  const originY = win.screenY + (win.outerHeight - win.innerHeight) - bw;
  const screen = (x: number, y: number) => {
    if (opts.screenIsClient) return { sx: x, sy: y };
    const sx = originX + x;
    const sy = originY + y;
    return unit === 'device' ? { sx: sx * dpr, sy: sy * dpr } : { sx, sy };
  };

  let t = opts.start ?? 1_000_000;
  let ctx: Ctx = { path, dialog: false, progress: null };
  const pages: PageInfo[] = [
    {
      t,
      ctx,
      desc: null,
      win,
      screen: { width: 1920, height: 1080 },
      dpr,
    },
  ];
  const events: RecordedEvent[] = [];
  const at = { x: 400, y: 300 };
  const push = (
    type: RecordedEvent['type'],
    target: Target,
    extra: Partial<RecordedEvent> = {},
  ) =>
    events.push({ t: round1(t), type, trusted: true, target, ctx, ...extra });
  const pointer = (x: number, y: number) => ({
    x,
    y,
    ...screen(x, y),
  });

  /**
   * A pointermove to (x, y). Real browsers send none when the mouse stays
   * put, so a zero step is dropped unless drawn as a no-movement event.
   */
  const move = (x: number, y: number, kind: Target['kind']) => {
    const still = rng.next() < zeroShare;
    const dx = x - at.x;
    const dy = y - at.y;
    if (!still && dx === 0 && dy === 0) return;
    push(
      'pointermove',
      { kind },
      { ...pointer(x, y), mx: still ? 0 : dx, my: still ? 0 : dy, pointerType },
    );
    at.x = x;
    at.y = y;
  };

  move(at.x + 3, at.y - 2, 'other');

  t += gauss(rng, 800, 200, 200);
  for (let i = 0; i < 4; i++) {
    if (i > 0) t += gauss(rng, 120, 30, 20);
    push('wheel', { kind: 'other' }, { dy: opts.wheelDelta ?? 100, dm: 0 });
  }

  const click = (kind: Target['kind']) => {
    t += gauss(rng, 600, 150, 200) + (opts.stepPause ?? 0);
    const w = Math.round(30 + rng.next() * 170);
    const h = Math.round(24 + rng.next() * 36);
    const dist = 80 + rng.next() * 420;
    const angle = rng.next() * 2 * Math.PI;
    // Reflect off the viewport's edges, then clamp, so every move goes somewhere.
    const axis = (from: number, delta: number, max: number) => {
      const v =
        from + delta >= 20 && from + delta <= max ? from + delta : from - delta;
      return Math.round(Math.min(max, Math.max(20, v)));
    };
    const to = {
      x: axis(at.x, dist * Math.cos(angle), 1200),
      y: axis(at.y, dist * Math.sin(angle), 560),
    };
    if (Math.hypot(to.x - at.x, to.y - at.y) < 40) to.x = axis(at.x, 200, 1200);
    const d = Math.hypot(to.x - at.x, to.y - at.y);
    const travel = Math.max(
      60,
      80 + 110 * Math.log2(d / Math.min(w, h) + 1) + gauss(rng, 0, 40, -1e9),
    );
    const start = t;
    const from = { ...at };
    const overAt = rng.next() < 0.7 ? 1 + Math.floor(rng.next() * 3) : -1;
    let step = 0;
    while (t - start < travel) {
      const f = Math.min(1, (t - start) / travel);
      const ease = 1 - (1 - f) ** 2;
      const x = Math.round(from.x + (to.x - from.x) * ease);
      const y = Math.round(from.y + (to.y - from.y) * ease);
      if (step === overAt) {
        push(
          'pointerover',
          { kind },
          { ...pointer(x, y), mx: 0, my: 0, pointerType },
        );
      }
      move(x, y, 'other');
      step++;
      t += gauss(rng, 40, 8, 6);
    }
    move(to.x, to.y, kind);
    const target: Target = { kind, w, h };
    const press = {
      ...pointer(to.x, to.y),
      button: 0,
      ox: 0.5,
      oy: 0.5,
    };
    t += gauss(rng, 150, 40, 20);
    push('pointerdown', target, { ...press, pointerType });
    push('mousedown', target, press);
    push('focusin', { kind });
    t += gauss(rng, 90, 20, 30);
    push('pointerup', target, { ...press, pointerType });
    push('mouseup', target, press);
    push('click', target, press);
  };

  const type = (text: string) => {
    t += gauss(rng, 500, 100, 100);
    let prev = '';
    for (const ch of text) {
      if (prev) {
        t += prev === ' ' ? gauss(rng, 300, 60, 100) : gauss(rng, 150, 40, 40);
      }
      const hold = gauss(rng, 80, 15, 30);
      const key = ch === ' ' ? 'space' : 'other';
      push('keydown', { kind: 'text' }, { key });
      t += hold;
      push('keyup', { kind: 'text' }, { key });
      t -= hold;
      prev = ch;
    }
    t += 100;
  };

  click('button'); // Apply
  ctx = { path, dialog: true, progress: 33 };
  click('text');
  type('abcd efgh');
  click('button'); // Next
  ctx = { path, dialog: true, progress: 66 };
  click('button'); // Next
  ctx = { path, dialog: true, progress: 100 };
  click('button'); // Submit

  events.sort((a, b) => a.t - b.t);
  return {
    version: 1,
    actor: opts.actor,
    source: opts.source,
    sittingId: '20990101T000000Z',
    jobKey: opts.jobKey,
    pages,
    events,
  };
}

/**
 * `n` recordings from consecutive seeds, an hour apart, with job keys
 * `<prefix>-<i>`.
 */
export function synthSet(
  n: number,
  opts: Omit<SynthOptions, 'jobKey' | 'start'>,
  seed: number,
  rngFor: (seed: number) => Rng,
): Recording[] {
  return Array.from({ length: n }, (_, i) =>
    synthRecording(
      {
        ...opts,
        jobKey: `${opts.actor}-${opts.source}-${seed}-${i}`,
        start: 1_000_000 + i * 3_600_000,
      },
      rngFor(seed * 1000 + i),
    ),
  );
}
