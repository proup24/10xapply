import { chromium, type Page } from 'patchright-core';
import type { RunnerConfig } from '../config.js';
import type { RecorderBatch } from '../pace/recording.js';
import { startRelay } from '../relay/relay.js';

export interface Bridge {
  openRunWindow(): Promise<Page>;
  /** Why the run must stop, or null. Set by detach, minimise or disconnect. */
  stopReason(): string | null;
  /** Crashes the run tab on purpose, for `bridge check --crash`. */
  crashRunTab(): Promise<void>;
  /** The run tab's viewport in CSS px, for the pace module. Runs no script. */
  viewport(): Promise<{ width: number; height: number } | null>;
  /**
   * Runs `open` (pace's click on an upload button), awaits `choose` once the
   * chooser has opened, then sets `file`, a path on the Windows side,
   * through the relay so Chrome fires a trusted `change`.
   */
  uploadOnChooser(
    file: string,
    open: () => Promise<void>,
    choose: () => Promise<void>,
  ): Promise<void>;
  startRecording(salt: string): Promise<void>;
  stopRecording(): Promise<void>;
  onRecorderBatch(fn: (b: RecorderBatch) => void): () => void;
  /** Closes the run page, disconnects Patchright, stops the relay. Never throws. */
  close(): Promise<void>;
}

export const EXTENSION_TIMEOUT_MS = 45_000;

export const UNAVAILABLE_MESSAGE =
  'the bridge extension did not connect within 45 s: is Chrome open, is the extension loaded, and is WSL networking mirrored?';

const quietly = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch {
    // Teardown must never throw.
  }
};

export async function connectBridge(
  cfg: RunnerConfig,
  deps: {
    connectOverCDP?: typeof chromium.connectOverCDP;
    timeoutMs?: number;
  } = {},
): Promise<Bridge | { unavailable: string }> {
  const connectOverCDP =
    deps.connectOverCDP ?? chromium.connectOverCDP.bind(chromium);
  const relay = await startRelay({ port: cfg.relayPort, token: cfg.token });

  let reason: string | null = null;
  const off = relay.onEvent((e) => {
    if (reason !== null) return;
    if (e.kind === 'detached') reason = `debugger detached: ${e.reason}`;
    else if (e.kind === 'window-minimized') reason = 'run window minimized';
    else reason = 'extension disconnected';
  });

  let browser: Awaited<ReturnType<typeof connectOverCDP>> | null = null;
  const pages: Page[] = [];

  const close = async (): Promise<void> => {
    off();
    for (const page of pages.splice(0)) {
      await quietly(() => page.close());
    }
    if (browser) {
      const b = browser;
      browser = null;
      // A connectOverCDP browser's close() only drops the CDP connection;
      // it never sends Browser.close (which the relay refuses anyway).
      await quietly(() => b.close());
    }
    await quietly(() => relay.stop());
  };

  try {
    if (
      !(await relay.waitForExtension(deps.timeoutMs ?? EXTENSION_TIMEOUT_MS))
    ) {
      await close();
      return { unavailable: UNAVAILABLE_MESSAGE };
    }
    browser = await connectOverCDP(relay.cdpUrl);
  } catch (e) {
    await close();
    throw e;
  }

  return {
    async openRunWindow(): Promise<Page> {
      if (!browser) throw new Error('bridge is closed');
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      pages.push(page);
      return page;
    },
    stopReason: () => reason,
    crashRunTab: () => relay.crashRunTab(),
    viewport: () => relay.viewport(),
    uploadOnChooser: (file, open, choose) =>
      relay.uploadOnChooser([file], open, choose),
    startRecording: (salt) => relay.startRecording(salt),
    stopRecording: () => relay.stopRecording(),
    onRecorderBatch: (fn) => relay.onRecorderBatch(fn),
    close,
  };
}
