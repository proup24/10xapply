import { ksTwoSample } from './ks.js';
import { extractMeasures, type MeasureName, type Models } from './measures.js';
import { sortedEvents } from './phases.js';
import { FITTS_FIXED_W, fitFitts } from './profile.js';
import type { PageInfo, RecordedEvent, Recording } from './recording.js';
import type { Rng } from './rng.js';

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
export interface CompareReport {
  passed: boolean;
  shape: Check[];
  timing: Check[];
  variety: Check[];
}

/** A KS check passes at or above this p-value. */
export const KS_MIN_P = 0.01;
/** Fewer values than this on either side fail the check. */
export const KS_MIN_SAMPLES = 5;
/** Runner screen offsets may move this much within one page, CSS px. */
export const OFFSET_SPREAD_PX = 1;
/** Runner screen offsets may sit this far from the author's model, CSS px. */
export const OFFSET_MODEL_PX = 2;
/** Largest allowed gap in the share of pointermoves with no movement. */
export const ZERO_MOVE_SHARE_DIFF = 0.05;
/** How many inter-event gaps and path points `runsDiffer` compares. */
export const VARIETY_PREFIX = 50;

/** Measures compared against the author's LinkedIn (and typing) recordings. */
const LINKEDIN_TIMING = [
  'sampleInterval',
  'pressRelease',
  'hoverToPress',
  'keyHold',
  'keyGapInWord',
  'keyGapAfterSpace',
  'wheelGap',
] as const satisfies readonly MeasureName[];
/** Measures that depend on the form layout: practice against practice only. */
const PRACTICE_TIMING = [
  'stepTime',
  'appTime',
] as const satisfies readonly MeasureName[];

const fmt = (x: number) => x.toFixed(1);
const ok = (name: string, detail: string): Check => ({
  name,
  passed: true,
  detail,
});
const bad = (name: string, detail: string): Check => ({
  name,
  passed: false,
  detail,
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `name xN` for the most common keys, most common first. */
function tally(keys: string[], limit = 5): string {
  const c = new Map<string, number>();
  for (const k of keys) c.set(k, (c.get(k) ?? 0) + 1);
  return [...c]
    .sort((p, q) => q[1] - p[1])
    .slice(0, limit)
    .map(([k, n]) => `${k} x${n}`)
    .join(', ');
}

const label = (r: Recording) => `${r.source}/${r.sittingId}-${r.jobKey}`;
const trustedEvents = (r: Recording) =>
  sortedEvents(r).filter((e) => e.trusted);

// ---------------------------------------------------------------- shape

/**
 * Untrusted events come from page scripts. The practice page's own
 * `input.click()` on the file input is one; the author's recordings show it
 * too. So an untrusted runner event is fine only when the author's
 * recordings hold an untrusted event of the same type on the same kind of
 * target.
 */
const scriptKey = (e: RecordedEvent) => `${e.type}/${e.target.kind}`;

function pageScriptKeys(author: Recording[]): Set<string> {
  const keys = new Set<string>();
  for (const r of author)
    for (const e of r.events) if (!e.trusted) keys.add(scriptKey(e));
  return keys;
}

function trustedCheck(author: Recording[], runner: Recording[]): Check {
  const scripted = pageScriptKeys(author);
  const events = runner.flatMap((r) => r.events);
  if (events.length === 0) return bad('trusted', 'no runner events');
  const untrusted = events.filter((e) => !e.trusted);
  const leaks = untrusted.filter((e) => !scripted.has(scriptKey(e)));
  if (leaks.length > 0) {
    return bad(
      'trusted',
      `${leaks.length} untrusted events the author's pages never fire: ${tally(leaks.map(scriptKey))}`,
    );
  }
  return ok(
    'trusted',
    `${events.length - untrusted.length} of ${events.length} events trusted` +
      (untrusted.length
        ? `; ignored ${untrusted.length} page-script events the author's pages also fire (${tally(untrusted.map(scriptKey))})`
        : ''),
  );
}

function pointerTypeCheck(runner: Recording[]): Check {
  const pointer = runner.flatMap((r) =>
    trustedEvents(r).filter((e) => e.type.startsWith('pointer')),
  );
  if (pointer.length === 0)
    return bad('pointerType', 'no runner pointer events');
  const other = pointer.filter((e) => e.pointerType !== 'mouse');
  if (other.length > 0) {
    return bad(
      'pointerType',
      `${other.length} of ${pointer.length} pointer events not mouse: ${tally(other.map((e) => String(e.pointerType)))}`,
    );
  }
  return ok('pointerType', `${pointer.length} pointer events, all mouse`);
}

interface ScreenPoint {
  e: RecordedEvent;
  x: number;
  y: number;
  sx: number;
  sy: number;
}
interface PageGroup {
  rec: Recording;
  page: PageInfo | null;
  points: ScreenPoint[];
}

const atScreenOrigin = (p: ScreenPoint) => p.sx === 0 && p.sy === 0;

/**
 * The page record an event belongs to: the latest one for its path at or
 * before it, else the first for its path, else the latest before it, else
 * the first. Events carry no page id.
 */
function pageOf(e: RecordedEvent, pages: PageInfo[]): PageInfo | null {
  const same = pages.filter((p) => p.ctx.path === e.ctx.path);
  const before = (ps: PageInfo[]) => ps.filter((p) => p.t <= e.t).pop();
  return before(same) ?? same[0] ?? before(pages) ?? pages[0] ?? null;
}

/** Trusted events with client and screen points, grouped by page record. */
function pageGroups(recs: Recording[]): PageGroup[] {
  const groups: PageGroup[] = [];
  for (const rec of recs) {
    const pages = [...rec.pages].sort((a, b) => a.t - b.t);
    const byPage = new Map<PageInfo | null, PageGroup>();
    for (const e of trustedEvents(rec)) {
      const { x, y, sx, sy } = e;
      if (
        x === undefined ||
        y === undefined ||
        sx === undefined ||
        sy === undefined
      )
        continue;
      const page = pageOf(e, pages);
      let g = byPage.get(page);
      if (!g) {
        g = { rec, page, points: [] };
        byPage.set(page, g);
        groups.push(g);
      }
      g.points.push({ e, x, y, sx, sy });
    }
  }
  return groups;
}

type ScreenUnit = 'css' | 'device';

/** Client-to-screen offset of one point, in CSS px. */
function offsetOf(p: ScreenPoint, unit: ScreenUnit, dpr: number) {
  const s = unit === 'device' ? dpr : 1;
  return { x: p.sx / s - p.x, y: p.sy / s - p.y };
}

/** Where the viewport's top-left sits on screen before the fitted constant. */
function viewportOrigin(win: PageInfo['win']) {
  const border = (win.outerWidth - win.innerWidth) / 2;
  return {
    x: win.screenX + border,
    y: win.screenY + (win.outerHeight - win.innerHeight) - border,
  };
}

/** Largest distance of any value from the median. */
function spreadOf(xs: number[]): number {
  const m = median(xs);
  return Math.max(...xs.map((x) => Math.abs(x - m)));
}

/**
 * Whether sx/sy are CSS px (screen = viewport origin + client) or device px
 * (screen = (origin + client)·dpr), from the author's pages at dpr ≠ 1:
 * whichever keeps each page's offset steadier. Null when no page can tell.
 */
function deriveUnit(groups: PageGroup[]): ScreenUnit | null {
  let css = 0;
  let device = 0;
  let pages = 0;
  for (const g of groups) {
    if (!g.page || g.page.dpr === 1 || g.points.length < 2) continue;
    const dpr = g.page.dpr;
    const spread = (unit: ScreenUnit) => {
      const o = g.points.map((p) => offsetOf(p, unit, dpr));
      return spreadOf(o.map((v) => v.x)) + spreadOf(o.map((v) => v.y));
    };
    css += spread('css');
    device += spread('device');
    pages++;
  }
  if (pages === 0) return null;
  return device < css ? 'device' : 'css';
}

/**
 * Screen coordinates: in Chrome, an event's screen point is the viewport's
 * top-left on screen plus its client point. The viewport sits at the
 * window's position plus its frame: half the width difference for the side
 * border, the height difference less that border for the title bar,
 * toolbars and any infobar. The model is fitted on the author's pages: the
 * unit of sx/sy (CSS or device px, see `deriveUnit`) and a constant on top
 * of that geometry. Each runner page's offset must then be steady within
 * OFFSET_SPREAD_PX and within OFFSET_MODEL_PX of what the model gives for
 * the runner's own window and dpr.
 *
 * Chrome reports some events at screen (0, 0): a pick in a native select
 * popup ends with pointerup, mouseup and click there. Runner events at
 * (0, 0) are skipped only when the author's recordings show the same event
 * type on the same kind of target there.
 */
function coordinatesCheck(author: Recording[], runner: Recording[]): Check {
  const name = 'coordinates';
  const authorGroups = pageGroups(author);
  const originKeys = new Set(
    authorGroups.flatMap((g) =>
      g.points.filter(atScreenOrigin).map((p) => scriptKey(p.e)),
    ),
  );
  const fitGroups = authorGroups
    .map((g) => ({ ...g, points: g.points.filter((p) => !atScreenOrigin(p)) }))
    .filter((g) => g.page && g.points.length > 0);
  if (fitGroups.length === 0) {
    return bad(name, 'no author page records to fit the offset model on');
  }
  const derived = deriveUnit(fitGroups);
  const unit = derived ?? 'css';

  const residuals = fitGroups.map((g) => {
    const page = g.page as PageInfo;
    const o = g.points.map((p) => offsetOf(p, unit, page.dpr));
    const origin = viewportOrigin(page.win);
    return {
      x: median(o.map((v) => v.x)) - origin.x,
      y: median(o.map((v) => v.y)) - origin.y,
    };
  });
  const c = {
    x: median(residuals.map((r) => r.x)),
    y: median(residuals.map((r) => r.y)),
  };
  const authorFit = Math.max(
    ...residuals.map((r) => Math.max(Math.abs(r.x - c.x), Math.abs(r.y - c.y))),
  );
  const model =
    `offset = window + frame + (${fmt(c.x)}, ${fmt(c.y)}) CSS px, sx/sy in ${unit === 'css' ? 'CSS' : 'device'} px` +
    (derived ? '' : ' (assumed: no author page at dpr ≠ 1)') +
    `; fits ${fitGroups.length} author pages within ${fmt(authorFit)} px`;
  if (authorFit > OFFSET_MODEL_PX) {
    return bad(name, `the author's own pages don't fit the model: ${model}`);
  }

  const problems: string[] = [];
  let pages = 0;
  let points = 0;
  for (const g of pageGroups(runner)) {
    const used = g.points.filter(
      (p) => !(atScreenOrigin(p) && originKeys.has(scriptKey(p.e))),
    );
    if (used.length === 0) continue;
    pages++;
    points += used.length;
    const where = `${label(g.rec)} ${g.page?.ctx.path ?? ''}`.trim();
    if (!g.page) {
      problems.push(`${where}: no page record`);
      continue;
    }
    const page = g.page;
    const o = used.map((p) => offsetOf(p, unit, page.dpr));
    const spread = Math.max(
      spreadOf(o.map((v) => v.x)),
      spreadOf(o.map((v) => v.y)),
    );
    if (spread > OFFSET_SPREAD_PX) {
      problems.push(`${where}: offset spread ${fmt(spread)} px`);
      continue;
    }
    const origin = viewportOrigin(page.win);
    const off = Math.max(
      ...o.map((v) =>
        Math.max(
          Math.abs(v.x - origin.x - c.x),
          Math.abs(v.y - origin.y - c.y),
        ),
      ),
    );
    if (off > OFFSET_MODEL_PX) {
      problems.push(`${where}: off the author's model by ${fmt(off)} px`);
    }
  }
  if (pages === 0) return bad(name, 'no runner events with screen points');
  if (problems.length > 0) {
    return bad(
      name,
      `${problems.length} of ${pages} runner pages: ${problems.slice(0, 3).join('; ')}; ${model}`,
    );
  }
  return ok(name, `${pages} runner pages, ${points} events; ${model}`);
}

/** Share of mouse pointermoves (with movement recorded) reporting none. */
function zeroMoveShare(recs: Recording[]): { share: number; n: number } {
  const moves = recs.flatMap((r) =>
    trustedEvents(r).filter(
      (e) =>
        e.type === 'pointermove' &&
        e.pointerType === 'mouse' &&
        e.mx !== undefined &&
        e.my !== undefined,
    ),
  );
  const still = moves.filter((e) => e.mx === 0 && e.my === 0).length;
  return { share: moves.length ? still / moves.length : NaN, n: moves.length };
}

function movementCheck(author: Recording[], runner: Recording[]): Check {
  const a = zeroMoveShare(author);
  const r = zeroMoveShare(runner);
  if (a.n === 0 || r.n === 0) {
    return bad('movement', `no pointermoves (a=${a.n}, r=${r.n})`);
  }
  const detail = `zero-movement share: author ${a.share.toFixed(3)} (${a.n}), runner ${r.share.toFixed(3)} (${r.n})`;
  return Math.abs(a.share - r.share) <= ZERO_MOVE_SHARE_DIFF
    ? ok('movement', detail)
    : bad('movement', detail);
}

const SEQUENCE_TYPES = new Set<RecordedEvent['type']>([
  'pointerover',
  'pointermove',
  'pointerdown',
  'mousedown',
  'focusin',
  'pointerup',
  'mouseup',
]);
const MOVES = 'pointermove+';

/**
 * The event sequence before each trusted click, e.g.
 * `pointerover>pointermove+>pointerdown>mousedown>focusin>pointerup>mouseup>click`.
 * Walks back from the click, collapsing pointermove runs; mousemove (always
 * paired with a pointermove), wheel, scroll, keyup and change (a field left
 * by this press fires its change mid-sequence) are skipped. It stops at the
 * previous click or a keydown, and before the press it keeps only the last
 * run of pointermoves and a pointerover just before it.
 *
 * A click with no press of its own is one the browser makes: a label
 * forwarding its click to its input, a pick in a native select popup, a key
 * activating a control. Its sequence ends `click[<target kind>]`, since
 * which of these it is matters.
 *
 * Untrusted (page-script) clicks are left out; see `trustedCheck`.
 */
export function clickSequences(rec: Recording): string[] {
  const ev = trustedEvents(rec);
  const out: string[] = [];
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].type !== 'click') continue;
    const seq = ['click'];
    let pressed = false;
    for (let j = i - 1; j >= 0; j--) {
      const e = ev[j];
      if (e.type === 'click' || e.type === 'keydown') break;
      if (!SEQUENCE_TYPES.has(e.type)) continue;
      const tok = e.type === 'pointermove' ? MOVES : e.type;
      if (pressed) {
        if (tok === MOVES) {
          if (seq[0] !== MOVES) seq.unshift(MOVES);
          continue;
        }
        if (tok === 'pointerover' && seq[0] === MOVES) seq.unshift(tok);
        break;
      }
      if (!(tok === MOVES && seq[0] === MOVES)) seq.unshift(tok);
      if (e.type === 'pointerdown') pressed = true;
    }
    if (!pressed) seq[seq.length - 1] = `click[${ev[i].target.kind}]`;
    out.push(seq.join('>'));
  }
  return out;
}

function clickSequenceCheck(author: Recording[], runner: Recording[]): Check {
  const known = new Set(author.flatMap(clickSequences));
  const seen = runner.flatMap(clickSequences);
  if (seen.length === 0) return bad('clickSequence', 'no runner clicks');
  const unknown = seen.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    return bad(
      'clickSequence',
      `${unknown.length} of ${seen.length} runner clicks follow a sequence the author's never do: ${tally(unknown, 3)}`,
    );
  }
  return ok(
    'clickSequence',
    `${seen.length} runner clicks, ${new Set(seen).size} sequences, all among the author's ${known.size}`,
  );
}

const wheelKey = (e: RecordedEvent) => `${e.dy}/${e.dm ?? 0}`;
const wheels = (recs: Recording[]) =>
  recs.flatMap((r) =>
    trustedEvents(r).filter((e) => e.type === 'wheel' && e.dy !== undefined),
  );

function wheelCheck(author: Recording[], runner: Recording[]): Check {
  const authored = wheels(author).map(wheelKey);
  const known = new Set(authored);
  const seen = wheels(runner).map(wheelKey);
  if (authored.length === 0 || seen.length === 0) {
    return bad(
      'wheel',
      `no wheel events (a=${authored.length}, r=${seen.length})`,
    );
  }
  const unknown = seen.filter((k) => !known.has(k));
  const set = [...known].sort().join(' ');
  if (unknown.length > 0) {
    return bad(
      'wheel',
      `${unknown.length} runner wheel events outside the author's set (${set}): ${tally(unknown)}`,
    );
  }
  return ok('wheel', `${seen.length} runner wheel events, all in (${set})`);
}

// ---------------------------------------------------------------- timing

/** `n` values of `xs` drawn without replacement (partial Fisher–Yates). */
function subsample(xs: number[], n: number, rng: Rng): number[] {
  const a = [...xs];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng.next() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/**
 * KS on the two samples after cutting the larger one down to the smaller's
 * size at random, so large samples don't fail on trivial differences.
 */
function ksCheck(name: string, a: number[], r: number[], rng: Rng): Check {
  const counts = `a=${a.length}, r=${r.length}`;
  if (a.length < KS_MIN_SAMPLES || r.length < KS_MIN_SAMPLES) {
    return bad(name, `too few samples (${counts})`);
  }
  const n = Math.min(a.length, r.length);
  const { d, p } = ksTwoSample(
    a.length > n ? subsample(a, n, rng) : a,
    r.length > n ? subsample(r, n, rng) : r,
  );
  const detail = `p=${p.toFixed(3)} d=${d.toFixed(3)} (${counts}, n=${n})`;
  return p >= KS_MIN_P ? ok(name, detail) : bad(name, detail);
}

/**
 * Move time with the Fitts part taken out: (travel − a) / log2(D/W + 1),
 * W = min(w, h) of the pressed target, or FITTS_FIXED_W when not recorded.
 * Travel, not duration, because the Fitts fit is on travel.
 */
function normalisedMoves(moves: Models['moves'], a: number): number[] {
  return moves
    .filter((m) => m.distance > 0 && Number.isFinite(m.travel))
    .map((m) => {
      const w =
        (m.targetSize ?? 0) > 0 ? (m.targetSize as number) : FITTS_FIXED_W;
      return (m.travel - a) / Math.log2(m.distance / w + 1);
    });
}

/**
 * The LinkedIn-baseline measures compare the author's LinkedIn and typing
 * recordings with every runner recording; the layout measures (stepTime,
 * appTime) compare the author's practice runs with the runner's practice
 * runs only.
 */
function timingChecks(
  author: Recording[],
  runner: Recording[],
  rng: Rng,
): Check[] {
  const am = extractMeasures(
    author.filter((r) => r.source === 'linkedin' || r.source === 'typing'),
  );
  const rm = extractMeasures(runner);
  const ap = extractMeasures(author.filter((r) => r.source === 'practice'));
  const rp = extractMeasures(runner.filter((r) => r.source === 'practice'));
  const { a } = fitFitts(am.models.moves);
  return [
    ...LINKEDIN_TIMING.map((n) => ksCheck(n, am[n], rm[n], rng)),
    ksCheck(
      'moveDuration',
      normalisedMoves(am.models.moves, a),
      normalisedMoves(rm.models.moves, a),
      rng,
    ),
    ...PRACTICE_TIMING.map((n) => ksCheck(n, ap[n], rp[n], rng)),
  ];
}

// ---------------------------------------------------------------- variety

/** The first VARIETY_PREFIX gaps between trusted events, rounded to 1 ms. */
function gapKey(rec: Recording): string {
  const ev = trustedEvents(rec).slice(0, VARIETY_PREFIX + 1);
  return ev
    .slice(1)
    .map((e, i) => Math.round(e.t - ev[i].t))
    .join(',');
}

/** The first path: pointermoves before the first press, rounded to 1 px. */
function pathKey(rec: Recording): string {
  const pts: string[] = [];
  for (const e of trustedEvents(rec)) {
    if (e.type === 'pointerdown') break;
    if (e.type !== 'pointermove' || e.x === undefined || e.y === undefined)
      continue;
    pts.push(`${Math.round(e.x)}:${Math.round(e.y)}`);
    if (pts.length === VARIETY_PREFIX) break;
  }
  return pts.join(',');
}

function runsDifferCheck(runner: Recording[]): Check {
  const bySource = new Map<string, Recording[]>();
  for (const r of runner) {
    bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  }
  const twins: string[] = [];
  let pairs = 0;
  for (const recs of bySource.values()) {
    const keys = recs.map((r) => ({ gaps: gapKey(r), path: pathKey(r) }));
    for (let i = 0; i < recs.length; i++) {
      for (let j = i + 1; j < recs.length; j++) {
        pairs++;
        const same: string[] = [];
        if (keys[i].gaps && keys[i].gaps === keys[j].gaps) same.push('gaps');
        if (keys[i].path && keys[i].path === keys[j].path) same.push('path');
        if (same.length > 0) {
          twins.push(
            `${label(recs[i])} = ${label(recs[j])} (${same.join(', ')})`,
          );
        }
      }
    }
  }
  if (pairs === 0) {
    return bad(
      'runsDiffer',
      'too few runs: needs two runner recordings of one source',
    );
  }
  if (twins.length > 0) {
    return bad(
      'runsDiffer',
      `${twins.length} of ${pairs} pairs repeat: ${twins.slice(0, 3).join('; ')}`,
    );
  }
  return ok('runsDiffer', `${pairs} pairs of runs, none repeats`);
}

/**
 * Puts the runner's recordings next to the author's: event shape, timing
 * distributions (two-sample KS) and run-to-run variety. `rng` only drives
 * the subsampling before each KS test.
 */
export function compare(
  author: Recording[],
  runner: Recording[],
  rng: Rng,
): CompareReport {
  const shape = [
    trustedCheck(author, runner),
    pointerTypeCheck(runner),
    coordinatesCheck(author, runner),
    movementCheck(author, runner),
    clickSequenceCheck(author, runner),
    wheelCheck(author, runner),
  ];
  const timing = timingChecks(author, runner, rng);
  const variety = [runsDifferCheck(runner)];
  const passed = [...shape, ...timing, ...variety].every((c) => c.passed);
  return { passed, shape, timing, variety };
}
