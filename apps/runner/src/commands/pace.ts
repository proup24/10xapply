import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNAVAILABLE_MESSAGE, EXTENSION_TIMEOUT_MS } from '../bridge/bridge.js';
import { loadConfig, type RunnerConfig } from '../config.js';
import {
  extractMeasures,
  KEY_MEASURES,
  MEASURE_NAMES,
  MINIMUMS,
  PRACTICE_MINIMUMS,
  type MeasureName,
  type Measures,
} from '../pace/measures.js';
import { compare, type Check } from '../pace/compare.js';
import { PACE_DIR, writeAtomic } from '../pace/paths.js';
import { buildProfile, wheelDefaulted } from '../pace/profile.js';
import { isApplication } from '../pace/phases.js';
import type { Actor, Recording } from '../pace/recording.js';
import { cryptoRng, type Rng } from '../pace/rng.js';
import { createWriter, type Writer } from '../pace/writer.js';
import { startRelay, type Relay } from '../relay/relay.js';

export interface RecordDeps {
  cfg?: RunnerConfig;
  /** Starts the relay without Patchright. */
  relay?: Pick<
    Relay,
    | 'waitForExtension'
    | 'onEvent'
    | 'onRecorderBatch'
    | 'startRecording'
    | 'stopRecording'
    | 'stop'
  >;
  createWriter?: (sittingId: string) => Writer;
  out?: (text: string) => void;
  /** Where SIGINT and SIGTERM arrive; defaults to the process. */
  signals?: Pick<EventEmitter, 'on' | 'off'>;
  countsIntervalMs?: number;
}

/** A UTC timestamp safe in file names, e.g. 20261111T101530Z. */
export function sittingIdNow(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '');
}

function line(c: ReturnType<Writer['counts']>): string {
  return `pages ${c.pages}  clicks ${c.clicks}  key gaps ${c.keyGaps}  wheels ${c.wheels}`;
}

/**
 * Records the author's own timing (no content) until Ctrl+C. Never touches
 * LinkedIn: the recorder only runs in the author's everyday Chrome.
 */
export async function recordCommand(
  opts: { typing?: boolean; deps?: RecordDeps } = {},
): Promise<number> {
  const deps = opts.deps ?? {};
  const out = deps.out ?? ((t: string) => void process.stdout.write(t));
  const cfg = deps.cfg ?? loadConfig();
  const relay =
    deps.relay ?? (await startRelay({ port: cfg.relayPort, token: cfg.token }));
  const signals = deps.signals ?? process;
  const sittingId = sittingIdNow();
  const writer =
    deps.createWriter?.(sittingId) ??
    createWriter({ dir: PACE_DIR, actor: 'author', sittingId });

  const cleanup: (() => void)[] = [];
  const finish = async (
    code: number,
    stopRecorder: boolean,
  ): Promise<number> => {
    for (const fn of cleanup.splice(0)) fn();
    if (stopRecorder) await relay.stopRecording().catch(() => undefined);
    let paths: string[] = [];
    try {
      paths = writer.flush();
    } finally {
      await relay.stop().catch(() => undefined);
    }
    out(`\n${paths.length ? paths.join('\n') : 'no recordings written'}\n`);
    return code;
  };

  try {
    if (!(await relay.waitForExtension(EXTENSION_TIMEOUT_MS))) {
      await relay.stop().catch(() => undefined);
      out(`${UNAVAILABLE_MESSAGE}\n`);
      return 2;
    }

    // Settles on Ctrl+C (0) or when the extension goes away (2).
    const stopped = new Promise<{ code: number; stopRecorder: boolean }>(
      (resolve) => {
        const onSignal = () => resolve({ code: 0, stopRecorder: true });
        signals.on('SIGINT', onSignal);
        signals.on('SIGTERM', onSignal);
        cleanup.push(() => {
          signals.off('SIGINT', onSignal);
          signals.off('SIGTERM', onSignal);
        });
        const off = relay.onEvent((e) => {
          if (e.kind !== 'extension-disconnected') return;
          out('\nrecording stopped: extension disconnected\n');
          resolve({ code: 2, stopRecorder: false });
        });
        cleanup.push(off);
      },
    );
    cleanup.push(relay.onRecorderBatch((b) => writer.add(b)));

    await relay.startRecording(randomBytes(16).toString('hex'));
    out(`recording started (${sittingId}).\n`);
    if (opts.typing) {
      out(`typing page: http://127.0.0.1:${cfg.relayPort}/typing/\n`);
    }
    out('open or reload the job pages now; Ctrl+C stops and saves.\n');

    const timer = setInterval(
      () => out(`\r${line(writer.counts())}`),
      deps.countsIntervalMs ?? 5000,
    );
    cleanup.push(() => clearInterval(timer));

    const { code, stopRecorder } = await stopped;
    return await finish(code, stopRecorder);
  } catch (e) {
    // Keep what was recorded even when starting or running failed.
    await finish(1, true).catch(() => undefined);
    throw e;
  }
}

/** Every recording under `dir/<actor>/`, skipping unreadable files. */
function readRecordings(
  dir: string,
  out: (t: string) => void,
  actor: Actor = 'author',
): Recording[] {
  const root = join(dir, actor);
  if (!existsSync(root)) return [];
  const recs: Recording[] = [];
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(root, f), 'utf8')) as Recording;
      if (
        r.version !== 1 ||
        !Array.isArray(r.events) ||
        !Array.isArray(r.pages)
      )
        throw new Error('not a version 1 recording');
      recs.push(r);
    } catch (e) {
      out(`skipped ${f}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return recs;
}

/** Prints one table and returns the measures that are short. */
function table(
  title: string,
  m: Measures,
  names: readonly MeasureName[],
  minimums: Partial<Record<MeasureName, number>>,
  out: (t: string) => void,
): MeasureName[] {
  const short: MeasureName[] = [];
  out(`\n${title}\n`);
  out(
    `  ${'measure'.padEnd(24)}${'count'.padStart(7)}${'minimum'.padStart(9)}  status\n`,
  );
  for (const n of names) {
    const count = m[n].length;
    const min = minimums[n] ?? 1;
    const status = count >= min ? 'enough' : 'short';
    if (status === 'short') short.push(n);
    out(
      `  ${n.padEnd(24)}${String(count).padStart(7)}${String(min).padStart(9)}  ${status}\n`,
    );
  }
  return short;
}

/**
 * Prints how many samples each measure has against the minimum it needs,
 * and how to fill what is short. Only reads files.
 */
export function summaryCommand(
  opts: { dir?: string; out?: (text: string) => void } = {},
): number {
  const dir = opts.dir ?? PACE_DIR;
  const out = opts.out ?? ((t: string) => void process.stdout.write(t));
  const recs = readRecordings(dir, out);
  const main = recs.filter(
    (r) => r.source === 'linkedin' || r.source === 'typing',
  );
  const practice = recs.filter((r) => r.source === 'practice');
  if (main.length === 0 && practice.length === 0) {
    out(
      `no recordings under ${join(dir, 'author')}: run pnpm nx run runner:pace-record\n`,
    );
    return 1;
  }

  const apps = main.filter((r) => r.source === 'linkedin' && isApplication(r));
  const practiceApps = practice.filter(isApplication);
  const typing = main.filter((r) => r.source === 'typing').length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  out(
    `pace summary: ${plural(apps.length, 'application')}, ${practiceApps.length} practice, ${plural(typing, 'typing recording')}\n`,
  );

  const short = table(
    'LinkedIn (and typing page for key measures)',
    extractMeasures(main),
    MEASURE_NAMES.filter((n) => n !== 'fileChooserDwell'),
    MINIMUMS,
    out,
  );
  // The only measure that takes practice samples (see buildProfile).
  const chooserShort = table(
    'file chooser (LinkedIn and practice)',
    extractMeasures([...main, ...practice]),
    ['fileChooserDwell'],
    MINIMUMS,
    out,
  );
  const practiceShort = table(
    'practice',
    extractMeasures(practice),
    ['stepTime', 'appTime'],
    PRACTICE_MINIMUMS,
    out,
  );

  const keys = short.filter((n) => KEY_MEASURES.includes(n));
  const rest = short.filter((n) => !KEY_MEASURES.includes(n));
  out('\n');
  if (keys.length > 0) {
    out(
      `short: ${keys.join(', ')}\n  fix: type on the typing page: pnpm nx run runner:pace-record-typing\n`,
    );
  }
  if (rest.length > 0) {
    out(
      `short: ${rest.join(', ')}\n  fix: apply to a few more jobs while recording: pnpm nx run runner:pace-record\n`,
    );
  }
  if (chooserShort.length > 0) {
    out(
      `short: ${chooserShort.join(', ')}\n  fix: upload the resume in a few more practice runs (/practice/?run=<n>) while recording: pnpm nx run runner:pace-record\n`,
    );
  }
  if (practiceShort.length > 0) {
    out(
      `short (practice): ${practiceShort.join(', ')}\n  fix: fill a few more practice runs (/practice/?run=<n>) while recording: pnpm nx run runner:pace-record\n`,
    );
  }
  if (
    short.length === 0 &&
    chooserShort.length === 0 &&
    practiceShort.length === 0
  ) {
    out('every measure has enough samples\n');
  }
  return 0;
}

/**
 * Builds `profile.json` from the author's recordings and prints the sample
 * count per measure. Only reads recordings; never touches the relay.
 */
export function buildCommand(
  opts: { dir?: string; out?: (text: string) => void } = {},
): number {
  const dir = opts.dir ?? PACE_DIR;
  const out = opts.out ?? ((t: string) => void process.stdout.write(t));
  const recs = readRecordings(dir, out);
  if (recs.length === 0) {
    out(
      `no recordings under ${join(dir, 'author')}: run pnpm nx run runner:pace-record\n`,
    );
    return 1;
  }
  const profile = buildProfile(recs);
  writeAtomic(
    join(dir, 'profile.json'),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  out(
    `pace profile: ${profile.sources.applications} applications, ${profile.sources.practice} practice\n`,
  );
  for (const n of MEASURE_NAMES) {
    out(
      `  ${n.padEnd(24)}${String(profile.samples[n]?.length ?? 0).padStart(7)}\n`,
    );
  }
  out(
    `  fitts: a=${profile.fitts.a.toFixed(1)} b=${profile.fitts.b.toFixed(1)} (${profile.fitts.residuals.length} moves${profile.fitts.wFixed ? `, W fixed at ${profile.fitts.wFixed}` : ''})\n`,
  );
  out(
    profile.reading
      ? `  reading: base=${profile.reading.base.toFixed(0)} perChar=${profile.reading.perChar.toFixed(2)}\n`
      : '  warning: no description lengths recorded, so no reading model\n',
  );
  const empty = MEASURE_NAMES.filter((n) => !profile.samples[n]?.length);
  if (empty.length > 0) out(`  warning: no samples for ${empty.join(', ')}\n`);
  if (wheelDefaulted(recs))
    out(
      `  warning: no wheel events in the LinkedIn or typing recordings; using the default notch (deltaY ${profile.wheel.deltaY}, deltaMode ${profile.wheel.deltaMode})\n`,
    );
  return 0;
}

function checkRows(title: string, checks: Check[], out: (t: string) => void) {
  out(`\n${title}\n`);
  for (const c of checks) {
    out(
      `  ${c.name.padEnd(18)}${(c.passed ? 'pass' : 'FAIL').padEnd(6)}${c.detail}\n`,
    );
  }
}

/**
 * Puts the runner's recordings next to the author's, writes
 * `compare-<timestamp>.json` and prints a table. Exits 0 when every check
 * passes and 2 when one fails; 1 when either side has no recordings. Only
 * reads files.
 */
export function compareCommand(
  opts: { dir?: string; out?: (text: string) => void; rng?: Rng } = {},
): number {
  const dir = opts.dir ?? PACE_DIR;
  const out = opts.out ?? ((t: string) => void process.stdout.write(t));
  const author = readRecordings(dir, out, 'author');
  const runner = readRecordings(dir, out, 'runner');
  if (author.length === 0) {
    out(
      `no recordings under ${join(dir, 'author')}: run pnpm nx run runner:pace-record\n`,
    );
    return 1;
  }
  if (runner.length === 0) {
    out(
      `no recordings under ${join(dir, 'runner')}: run pnpm nx run runner:pace-practice\n`,
    );
    return 1;
  }
  const report = compare(author, runner, opts.rng ?? cryptoRng());
  const path = join(dir, `compare-${sittingIdNow()}.json`);
  writeAtomic(
    path,
    `${JSON.stringify({ comparedAt: new Date().toISOString(), recordings: { author: author.length, runner: runner.length }, ...report }, null, 2)}\n`,
  );
  out(
    `pace compare: ${author.length} author recordings, ${runner.length} runner recordings\n`,
  );
  checkRows('shape', report.shape, out);
  checkRows('timing (two-sample KS, pass at p >= 0.01)', report.timing, out);
  checkRows('variety', report.variety, out);
  const checks = [...report.shape, ...report.timing, ...report.variety];
  const failed = checks.filter((c) => !c.passed).length;
  out(
    `\n${report.passed ? 'PASS' : `FAIL: ${failed} of ${checks.length} checks`}\nreport: ${path}\n`,
  );
  return report.passed ? 0 : 2;
}
