import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compare, type Check, type CompareReport } from './compare.js';
import type { RecordedEvent, Recording } from './recording.js';
import { seededRng } from './rng.js';
import {
  AUTHOR_WIN,
  RUNNER_WIN,
  synthSet,
  type SynthOptions,
} from './testing/recordings.js';

const fixture = (name: string): Recording[] =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
  ) as Recording[];

type Opts = Omit<SynthOptions, 'jobKey' | 'start' | 'actor' | 'source'>;

/** 8 LinkedIn applications and 6 practice runs by the author. */
function authorSet(linkedin: Opts = {}, practice: Opts = linkedin) {
  return [
    ...synthSet(
      8,
      { actor: 'author', source: 'linkedin', ...linkedin },
      1,
      seededRng,
    ),
    ...synthSet(
      6,
      { actor: 'author', source: 'practice', ...practice },
      2,
      seededRng,
    ),
  ];
}
const runnerSet = (n: number, opts: Opts = {}, seed = 7) =>
  synthSet(
    n,
    { actor: 'runner', source: 'practice', win: RUNNER_WIN, ...opts },
    seed,
    seededRng,
  );

const all = (r: CompareReport) => [...r.shape, ...r.timing, ...r.variety];
const check = (r: CompareReport, name: string): Check => {
  const c = all(r).find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}`);
  return c;
};
const failing = (r: CompareReport) =>
  all(r)
    .filter((c) => !c.passed)
    .map((c) => `${c.name}: ${c.detail}`);

const author = authorSet();

describe('compare', () => {
  it('names every check', () => {
    const r = compare(author, fixture('runner-good.json'), seededRng(1));
    expect(r.shape.map((c) => c.name)).toEqual([
      'trusted',
      'pointerType',
      'coordinates',
      'movement',
      'clickSequence',
      'wheel',
    ]);
    expect(r.timing.map((c) => c.name)).toEqual([
      'sampleInterval',
      'pressRelease',
      'hoverToPress',
      'keyHold',
      'keyGapInWord',
      'keyGapAfterSpace',
      'wheelGap',
      'moveDuration',
      'stepTime',
      'appTime',
    ]);
    expect(r.variety.map((c) => c.name)).toEqual(['runsDiffer']);
  });

  it('runner-good passes everything', () => {
    const r = compare(author, fixture('runner-good.json'), seededRng(1));
    expect(failing(r)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('runner-leaky fails coordinates and movement', () => {
    const r = compare(author, fixture('runner-leaky.json'), seededRng(1));
    expect(r.passed).toBe(false);
    expect(check(r, 'coordinates').passed).toBe(false);
    expect(check(r, 'movement').passed).toBe(false);
    expect(check(r, 'movement').detail).toMatch(/runner 1\.000/);
  });

  describe('coordinates', () => {
    const second: Opts = {
      win: { ...AUTHOR_WIN, screenX: 1920, screenY: 0 },
      dpr: 1.25,
    };

    it('coordinate check holds at dpr 1.25 on a second monitor', () => {
      const a = authorSet(second);
      const runner = runnerSet(3, {
        win: { ...RUNNER_WIN, screenX: 1920, screenY: 0 },
        dpr: 1.25,
      });
      const c = check(compare(a, runner, seededRng(1)), 'coordinates');
      expect(c).toMatchObject({ passed: true });
      expect(c.detail).toMatch(/CSS px/);
    });

    it('holds for a runner window at a negative screenX, with other chrome', () => {
      const runner = runnerSet(3, {
        win: { ...RUNNER_WIN, screenX: -1920, screenY: 200, innerHeight: 640 },
        dpr: 1.25,
      });
      expect(
        check(compare(author, runner, seededRng(1)), 'coordinates'),
      ).toMatchObject({ passed: true });
    });

    it('fails a runner page whose offset is 10 px off the model', () => {
      const runner = runnerSet(2);
      for (const e of runner[1].events) if (e.sx !== undefined) e.sx += 10;
      const c = check(compare(author, runner, seededRng(1)), 'coordinates');
      expect(c.passed).toBe(false);
      expect(c.detail).toMatch(/off the author's model by 10/);
    });

    it('fails a runner page whose offset is not constant', () => {
      const runner = runnerSet(2);
      const moves = runner[0].events.filter((e) => e.type === 'pointermove');
      moves[5].sx = (moves[5].sx ?? 0) + 3;
      const c = check(compare(author, runner, seededRng(1)), 'coordinates');
      expect(c.passed).toBe(false);
      expect(c.detail).toMatch(/spread 3\.0 px/);
    });

    it('derives device pixels when the author screen coordinates scale with dpr', () => {
      const device: Opts = { ...second, screenUnit: 'device' };
      const a = authorSet(device);
      const win = { ...RUNNER_WIN, screenX: 1920, screenY: 0 };
      const good = check(
        compare(
          a,
          runnerSet(2, { win, dpr: 1.25, screenUnit: 'device' }),
          seededRng(1),
        ),
        'coordinates',
      );
      expect(good.passed).toBe(true);
      expect(good.detail).toMatch(/device px/);
      const css = check(
        compare(a, runnerSet(2, { win, dpr: 1.25 }), seededRng(1)),
        'coordinates',
      );
      expect(css.passed).toBe(false);
    });

    it("skips (0, 0) screen points only for event kinds the author's browser also shows there", () => {
      const a = authorSet();
      const ctx = { path: '/practice/', dialog: true, progress: 33 };
      const popup = (
        t: number,
        type: RecordedEvent['type'],
      ): RecordedEvent => ({
        t,
        type,
        trusted: true,
        x: 264,
        y: 160,
        sx: 0,
        sy: 0,
        target: { kind: 'select', options: 3 },
        ctx,
      });
      // Chrome reports these after a pick in a native select popup.
      a[8].events.push(
        popup(1_000_500, 'pointerup'),
        popup(1_000_500, 'mouseup'),
      );
      a[8].events.push(popup(1_000_500, 'click'));
      const runner = runnerSet(2);
      runner[0].events.push(popup(1_000_600, 'click'));
      expect(
        check(compare(a, runner, seededRng(1)), 'coordinates').passed,
      ).toBe(true);
      runner[1].events.push(popup(1_000_600, 'pointerdown'));
      expect(
        check(compare(a, runner, seededRng(1)), 'coordinates').passed,
      ).toBe(false);
    });

    it('fails with no author page records to fit the model on', () => {
      const a = authorSet().map((r) => ({ ...r, pages: [] }));
      const c = check(compare(a, runnerSet(2), seededRng(1)), 'coordinates');
      expect(c).toMatchObject({ passed: false });
      expect(c.detail).toMatch(/no author page/);
    });
  });

  describe('shape', () => {
    const scriptClick = (t: number): RecordedEvent => ({
      t,
      type: 'click',
      trusted: false,
      x: 0,
      y: 0,
      sx: 0,
      sy: 0,
      target: { kind: 'file' },
      ctx: { path: '/practice/', dialog: true, progress: 66 },
    });

    it("ignores the page's own untrusted clicks when the author's pages fire them too", () => {
      const a = authorSet();
      a[9].events.push(scriptClick(1_000_700));
      const runner = runnerSet(2);
      runner[0].events.push(scriptClick(1_000_700));
      const r = compare(a, runner, seededRng(1));
      expect(check(r, 'trusted').passed).toBe(true);
      expect(check(r, 'clickSequence').passed).toBe(true);
      expect(check(r, 'coordinates').passed).toBe(true);
      // Without the author's own, the same event is a leak.
      expect(
        check(compare(author, runner, seededRng(1)), 'trusted').passed,
      ).toBe(false);
    });

    it('fails a click with no movement before its press', () => {
      const runner = runnerSet(2);
      const rec = runner[0];
      const down = rec.events.findIndex((e) => e.type === 'pointerdown');
      rec.events = rec.events.filter(
        (e, i) =>
          i >= down || !(e.type === 'pointermove' || e.type === 'pointerover'),
      );
      const c = check(compare(author, runner, seededRng(1)), 'clickSequence');
      expect(c.passed).toBe(false);
      expect(c.detail).toContain(
        'pointerdown>mousedown>focusin>pointerup>mouseup>click',
      );
    });

    it("tells the browser's own clicks apart by target kind", () => {
      // A click with no press of its own right after another click: a
      // label forwarding to its radio (author and runner), and a select
      // picked with keys (runner only).
      const own = (rec: Recording, kind: 'radio' | 'select'): void => {
        const last = rec.events.filter((e) => e.type === 'click').pop();
        if (!last) throw new Error('no click');
        rec.events.push(
          ...(kind === 'select'
            ? [{ ...last, t: last.t + 900, type: 'change' as const }]
            : []),
          {
            ...last,
            t: last.t + 1000,
            sx: 0,
            sy: 0,
            target: { kind },
          },
        );
      };
      const a = authorSet();
      own(a[0], 'radio');
      // The author picks in the select popup with the mouse: Chrome sends
      // pointerup, mouseup and click there, at screen (0, 0).
      const last = a[1].events.filter((e) => e.type === 'click').pop();
      if (!last) throw new Error('no click');
      for (const type of ['pointerup', 'mouseup', 'click'] as const) {
        a[1].events.push({
          ...last,
          t: last.t + 1000,
          type,
          sx: 0,
          sy: 0,
          target: { kind: 'select' },
        });
      }
      const runner = runnerSet(2);
      own(runner[0], 'radio');
      const r = compare(a, runner, seededRng(1));
      expect(check(r, 'clickSequence').passed).toBe(true);
      own(runner[1], 'select');
      const c = check(compare(a, runner, seededRng(1)), 'clickSequence');
      expect(c.passed).toBe(false);
      expect(c.detail).toContain('click[select] x1');
    });

    it('fails pointer events that are not mouse', () => {
      const r = compare(
        author,
        runnerSet(2, { pointerType: 'touch' }),
        seededRng(1),
      );
      expect(check(r, 'pointerType').passed).toBe(false);
    });

    it("fails wheel deltas the author's wheel never produced", () => {
      const r = compare(
        author,
        runnerSet(2, { wheelDelta: 120 }),
        seededRng(1),
      );
      expect(check(r, 'wheel')).toMatchObject({ passed: false });
      expect(check(r, 'wheel').detail).toContain('120/0');
    });
  });

  describe('timing', () => {
    it('layout timings use the practice baseline only', () => {
      // The author lingers on LinkedIn's steps, not on the practice page's.
      const a = authorSet({ stepPause: 4000 }, {});
      const runner = [
        ...runnerSet(5),
        ...synthSet(
          3,
          {
            actor: 'runner',
            source: 'test-page',
            win: RUNNER_WIN,
            stepPause: 9000,
          },
          8,
          seededRng,
        ),
      ];
      const r = compare(a, runner, seededRng(1));
      expect(check(r, 'stepTime').passed).toBe(true);
      expect(check(r, 'appTime').passed).toBe(true);
      expect(check(r, 'appTime').detail).toMatch(/a=6, r=5\b/);
      // Against a slow practice baseline the same runs fail.
      const slow = authorSet({}, { stepPause: 4000 });
      expect(
        check(compare(slow, runnerSet(5), seededRng(1)), 'stepTime').passed,
      ).toBe(false);
    });

    it('never passes on too few samples', () => {
      const runner = runnerSet(2).map((rec) => ({
        ...rec,
        events: rec.events.filter(
          (e) => e.type !== 'keydown' && e.type !== 'keyup',
        ),
      }));
      const c = check(compare(author, runner, seededRng(1)), 'keyHold');
      expect(c).toEqual({
        name: 'keyHold',
        passed: false,
        detail: expect.stringMatching(/^too few samples \(a=\d+, r=0\)$/),
      });
    });

    it('fails a runner whose presses are twice as long', () => {
      const runner = runnerSet(5);
      for (const rec of runner) {
        let down = 0;
        for (const e of rec.events) {
          if (e.type === 'mousedown') down = e.t;
          if (e.type === 'mouseup') e.t = down + (e.t - down) * 2;
        }
      }
      expect(
        check(compare(author, runner, seededRng(1)), 'pressRelease').passed,
      ).toBe(false);
    });
  });

  describe('variety', () => {
    it('identical runs fail runsDiffer', () => {
      const [one] = runnerSet(1);
      const twin = { ...structuredClone(one), jobKey: 'twin' };
      const c = check(compare(author, [one, twin], seededRng(1)), 'runsDiffer');
      expect(c.passed).toBe(false);
      expect(c.detail).toContain('twin');
    });

    it('the same path at other times still fails', () => {
      const [one] = runnerSet(1);
      const twin = structuredClone(one);
      twin.jobKey = 'shifted';
      twin.events.forEach((e, i) => (e.t += i * 3));
      const c = check(compare(author, [one, twin], seededRng(1)), 'runsDiffer');
      expect(c.passed).toBe(false);
      expect(c.detail).toMatch(/path/);
    });

    it('needs two runs of one source', () => {
      const c = check(
        compare(author, runnerSet(1), seededRng(1)),
        'runsDiffer',
      );
      expect(c.passed).toBe(false);
    });
  });
});
