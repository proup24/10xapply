import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '../relay/relay.js';
import type { Writer } from '../pace/writer.js';
import { recordCommand, type RecordDeps } from './pace.js';

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
