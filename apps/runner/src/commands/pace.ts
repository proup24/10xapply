import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { UNAVAILABLE_MESSAGE, EXTENSION_TIMEOUT_MS } from '../bridge/bridge.js';
import { loadConfig, type RunnerConfig } from '../config.js';
import { PACE_DIR } from '../pace/paths.js';
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
function sittingIdNow(): string {
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
