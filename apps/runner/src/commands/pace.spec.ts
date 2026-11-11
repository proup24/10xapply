import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '../relay/relay.js';
import type { Writer } from '../pace/writer.js';
import type { Recording } from '../pace/recording.js';
import { seededRng } from '../pace/rng.js';
import { synthSet } from '../pace/testing/recordings.js';
import {
  buildCommand,
  compareCommand,
  recordCommand,
  summaryCommand,
  type RecordDeps,
} from './pace.js';

function setup() {
  const listeners = new Set<(e: BridgeEvent) => void>();
  const relay = {
    waitForExtension: vi.fn(async () => true),
    onEvent: vi.fn((fn: (e: BridgeEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    onRecorderBatch: vi.fn(() => () => undefined),
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const writer: Writer = {
    add: vi.fn(),
    counts: () => ({ pages: 0, clicks: 0, keyGaps: 0, wheels: 0 }),
    flush: vi.fn(() => ['/pace/author/linkedin/S-a.json']),
  };
  const signals = new EventEmitter();
  let output = '';
  const deps: RecordDeps = {
    cfg: { relayPort: 9444, token: 't' },
    relay,
    createWriter: () => writer,
    out: (t) => void (output += t),
    signals,
    countsIntervalMs: 1_000_000,
  };
  const started = () =>
    vi.waitFor(() => expect(output).toContain('open or reload'));
  return {
    relay,
    writer,
    signals,
    deps,
    out: () => output,
    started,
    emit: (e: BridgeEvent) => listeners.forEach((fn) => fn(e)),
  };
}

describe('pace record', () => {
  it('record prints the reload hint', async () => {
    const t = setup();
    const done = recordCommand({ deps: t.deps });
    await t.started();
    expect(t.out()).toContain('open or reload the job pages now');
    expect(t.relay.startRecording).toHaveBeenCalledOnce();
    t.signals.emit('SIGINT');
    await done;
  });

  it('record stops on extension disconnect', async () => {
    const t = setup();
    const done = recordCommand({ deps: t.deps });
    await t.started();
    t.emit({ kind: 'extension-disconnected' });
    expect(await done).toBe(2);
    expect(t.out()).toContain('recording stopped: extension disconnected');
    expect(t.writer.flush).toHaveBeenCalledOnce();
    expect(t.out()).toContain('/pace/author/linkedin/S-a.json');
    expect(t.relay.stop).toHaveBeenCalled();
  });

  it('record --typing prints the typing page URL', async () => {
    const t = setup();
    const done = recordCommand({ typing: true, deps: t.deps });
    await t.started();
    expect(t.out()).toContain('http://127.0.0.1:9444/typing/');
    t.signals.emit('SIGINT');
    await done;
  });

  it('SIGINT flushes and exits 0', async () => {
    const t = setup();
    const done = recordCommand({ deps: t.deps });
    await t.started();
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
    expect(t.relay.stopRecording).toHaveBeenCalledOnce();
    expect(t.writer.flush).toHaveBeenCalledOnce();
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('exits 2 when the extension never connects', async () => {
    const t = setup();
    t.relay.waitForExtension.mockResolvedValueOnce(false);
    expect(await recordCommand({ deps: t.deps })).toBe(2);
    expect(t.relay.startRecording).not.toHaveBeenCalled();
  });
});

describe('pace summary', () => {
  const fixtures = fileURLToPath(new URL('../pace/fixtures/', import.meta.url));
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function withFixtures(): string {
    dir = mkdtempSync(join(tmpdir(), 'pace-summary-'));
    for (const [source, file] of [
      ['linkedin', 'linkedin-app-1.json'],
      ['practice', 'practice-1.json'],
    ]) {
      mkdirSync(join(dir, 'author', source), { recursive: true });
      copyFileSync(join(fixtures, file), join(dir, 'author', source, file));
    }
    return dir;
  }

  function run(d: string) {
    let output = '';
    const code = summaryCommand({ dir: d, out: (t) => void (output += t) });
    return { code, output };
  }

  const row = (output: string, name: string) =>
    output.split('\n').find((l) => l.trim().startsWith(`${name} `));

  it('build writes profile.json and prints counts', () => {
    const d = withFixtures();
    let output = '';
    expect(buildCommand({ dir: d, out: (t) => void (output += t) })).toBe(0);
    expect(existsSync(join(d, 'profile.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(d, 'profile.json'), 'utf8')).version,
    ).toBe(1);
    expect(output).toContain('pace profile: 1 applications, 1 practice');
    expect(output).toContain('pressRelease');
  });

  it('build warns about the default wheel notch when only practice has wheel events', () => {
    const d = withFixtures();
    const lf = join(d, 'author', 'linkedin', 'linkedin-app-1.json');
    const lrec = JSON.parse(readFileSync(lf, 'utf8'));
    lrec.events = lrec.events.filter(
      (e: { type: string }) => e.type !== 'wheel',
    );
    writeFileSync(lf, JSON.stringify(lrec));
    const f = join(d, 'author', 'practice', 'practice-1.json');
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    rec.events.push({ t: 1, type: 'wheel', dy: 240, dm: 1 });
    writeFileSync(f, JSON.stringify(rec));
    let output = '';
    buildCommand({ dir: d, out: (t) => void (output += t) });
    expect(output).toContain('warning: no wheel events');
  });

  it('build with no recordings writes nothing and exits 1', () => {
    dir = mkdtempSync(join(tmpdir(), 'pace-summary-'));
    expect(buildCommand({ dir, out: () => undefined })).toBe(1);
    expect(existsSync(join(dir, 'profile.json'))).toBe(false);
  });

  it('summary prints count, minimum and enough/short per measure', () => {
    const { code, output } = run(withFixtures());
    expect(code).toBe(0);
    expect(output).toContain('1 application, 1 practice');
    expect(row(output, 'keyGapInWord')).toMatch(
      /^\s*keyGapInWord\s+2\s+300\s+short$/,
    );
    expect(row(output, 'pressRelease')).toMatch(/\s8\s+60\s+short$/);
    expect(row(output, 'keyGapAroundBackspace')).toMatch(/\s2\s+1\s+enough$/);
    expect(row(output, 'moveTargetSize')).toMatch(/\s8\s+1\s+enough$/);
    expect(output).toMatch(/practice[\s\S]*stepTime\s+3\s+9\s+short/);
    expect(output).toContain('pnpm nx run runner:pace-record-typing');
    expect(output).toMatch(/keyGapInWord[^\n]*\n?[^\n]*pace-record-typing/);
  });

  it('summary counts fileChooserDwell from LinkedIn and practice in its own line', () => {
    const d = withFixtures();
    const f = join(d, 'author', 'practice', 'practice-1.json');
    const rec = JSON.parse(readFileSync(f, 'utf8'));
    const ctx = { path: '/practice/', dialog: true, progress: 66 };
    for (const t of [90_000, 100_000]) {
      rec.events.push(
        {
          t,
          type: 'pointerdown',
          trusted: true,
          target: { kind: 'button' },
          ctx,
        },
        {
          t: t + 5000,
          type: 'change',
          trusted: true,
          target: { kind: 'file' },
          ctx,
        },
      );
    }
    writeFileSync(f, JSON.stringify(rec));
    const { output } = run(d);
    const rows = output
      .split('\n')
      .filter((l) => l.trim().startsWith('fileChooserDwell '));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\s2\s+3\s+short$/);
    expect(output).toMatch(/file chooser \(LinkedIn and practice\)/);
    expect(output).toMatch(/short: fileChooserDwell\n[^\n]*practice runs/);
  });

  it('summary with no recordings says how to record', () => {
    dir = mkdtempSync(join(tmpdir(), 'pace-summary-'));
    const { code, output } = run(dir);
    expect(code).toBe(1);
    expect(output).toContain('pnpm nx run runner:pace-record');
  });
});

describe('pace compare', () => {
  const fixtures = fileURLToPath(new URL('../pace/fixtures/', import.meta.url));
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function save(d: string, recs: Recording[]) {
    for (const r of recs) {
      const sub = join(d, r.actor, r.source);
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `${r.jobKey}.json`), JSON.stringify(r));
    }
  }
  function withAuthor(runnerFixture?: string): string {
    const d = mkdtempSync(join(tmpdir(), 'pace-compare-'));
    dir = d;
    save(d, [
      ...synthSet(8, { actor: 'author', source: 'linkedin' }, 1, seededRng),
      ...synthSet(6, { actor: 'author', source: 'practice' }, 2, seededRng),
    ]);
    if (runnerFixture) {
      save(
        d,
        JSON.parse(
          readFileSync(join(fixtures, runnerFixture), 'utf8'),
        ) as Recording[],
      );
    }
    return d;
  }
  function run(d: string) {
    let output = '';
    const code = compareCommand({
      dir: d,
      out: (t) => void (output += t),
      rng: seededRng(1),
    });
    return { code, output };
  }
  const reports = (d: string) =>
    readdirSync(d).filter((f) => /^compare-\d{8}T\d{6}Z\.json$/.test(f));

  it('exits 0, prints the table and writes the report when every check passes', () => {
    const d = withAuthor('runner-good.json');
    const { code, output } = run(d);
    expect(code).toBe(0);
    expect(output).toContain(
      'pace compare: 14 author recordings, 5 runner recordings',
    );
    expect(output).toMatch(/^\s+coordinates\s+pass\s/m);
    // 5 practice runs: a pass, but flagged in the table and the JSON.
    expect(output).toMatch(/^\s+appTime\s+pass \(low power\)\s+p=/m);
    expect(output).toMatch(/^\s+keyHold\s+pass\s+p=/m);
    expect(output).toMatch(/PASS \(\d+ low-power passes\)/);
    expect(output).toContain('PASS');
    const [file] = reports(d);
    const report = JSON.parse(readFileSync(join(d, file), 'utf8'));
    expect(report).toMatchObject({
      passed: true,
      recordings: { author: 14, runner: 5 },
    });
    expect(report.timing).toHaveLength(10);
    const appTime = report.timing.find(
      (c: { name: string }) => c.name === 'appTime',
    );
    expect(appTime).toMatchObject({ passed: true, lowPower: true });
    expect(appTime.ks).toMatchObject({ n: 5 });
  });

  it('exits 2 and names the failing checks when one fails', () => {
    const d = withAuthor('runner-leaky.json');
    const { code, output } = run(d);
    expect(code).toBe(2);
    expect(output).toMatch(/^\s+coordinates\s+FAIL\s/m);
    expect(output).toMatch(/^\s+movement\s+FAIL\s/m);
    expect(output).toMatch(/FAIL: \d+ of 17 checks/);
    expect(reports(d)).toHaveLength(1);
  });

  it('exits 1 without runner recordings and writes nothing', () => {
    const d = withAuthor();
    const { code, output } = run(d);
    expect(code).toBe(1);
    expect(output).toContain('runner:pace-practice');
    expect(reports(d)).toEqual([]);
  });
});
