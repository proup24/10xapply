import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import {
  buildCommand,
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
