// A token-protected CDP relay. Patchright connects to /cdp and sees a whole
// browser's CDP endpoint; the bridge extension connects to /extension and
// forwards CDP through chrome.debugger for the run windows it created.
//
// Ported from Playwright's CDPRelayServer (playwright-core 1.65.0,
// src/tools/mcp/cdpRelay.ts; the tab model is in browser-model.ts), speaking
// the bridge's wire protocol (apps/bridge-extension/src/bridge-core.js), with
// the spec's additions: a token on both sides, one client of each kind, the
// refused-method policy and method-name-only logging.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { RecorderBatch } from '../pace/recording.js';
import { BrowserModel, type Json } from './browser-model.js';
import { isRefused, isRefusedOnSession } from './policy.js';

export type BridgeEvent =
  | { kind: 'detached'; tabId: number; reason: string }
  | { kind: 'window-minimized'; tabId: number }
  | { kind: 'extension-disconnected' };

export interface RelayOptions {
  port: number;
  token: string;
  log?: (line: string) => void;
}

export interface Relay {
  cdpUrl: string; // ws://127.0.0.1:<port>/cdp?token=<token>
  waitForExtension(timeoutMs: number): Promise<boolean>;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
  /**
   * Crashes the run tab through the extension, for `bridge check --crash`.
   * Patchright cannot do it: its CDP session needs Target.attachToBrowserTarget,
   * which the relay refuses.
   */
  crashRunTab(): Promise<void>;
  /** The run tab's viewport in CSS px (Page.getLayoutMetrics), or null. */
  viewport(): Promise<{ width: number; height: number } | null>;
  /**
   * Runs `open` (a click that opens the run tab's file chooser), awaits
   * `choose` once it has opened, then sets `files` (paths on the Chrome
   * side) on the chooser's input, in-process.
   */
  uploadOnChooser(
    files: string[],
    open: () => Promise<void>,
    choose: () => Promise<void>,
  ): Promise<void>;
  /**
   * Starts the extension's timing-only recorder; `salt` stays in memory.
   * `mode: 'runner'` narrows it to the tabs the bridge opened, so the
   * author's own browsing during a runner sitting is not recorded.
   */
  startRecording(salt: string, opts?: { mode?: 'runner' }): Promise<void>;
  stopRecording(): Promise<void>;
  onRecorderBatch(fn: (b: RecorderBatch) => void): () => void;
  stop(): Promise<void>;
}

export class RelayPortInUseError extends Error {
  constructor(port: number) {
    super(`relay port ${port} is in use; is another runner running?`);
    this.name = 'RelayPortInUseError';
  }
}

const HOST = '127.0.0.1';
/** How long an upload waits for the file chooser after the click. */
const CHOOSER_TIMEOUT_MS = 10_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_CONFLICT = 4409;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// The practice and typing pages: a fixed set, read once at start. A request
// path is only ever compared against these keys, never used to build a path.
const STATIC_PAGES: ReadonlyMap<string, Buffer> = new Map(
  ['practice', 'typing'].map((name) => [
    `/${name}/`,
    readFileSync(
      fileURLToPath(new URL(`./static/${name}/index.html`, import.meta.url)),
    ),
  ]),
);

/** Splits a request target without `URL`, which throws on targets like `//`. */
function parseTarget(target: string | undefined): {
  pathname: string;
  search: string; // raw, with the leading '?', or ''
  params: URLSearchParams;
} {
  const [beforeFragment = ''] = (target ?? '/').split('#');
  const q = beforeFragment.indexOf('?');
  return {
    pathname: q < 0 ? beforeFragment : beforeFragment.slice(0, q),
    search: q < 0 ? '' : beforeFragment.slice(q),
    params: new URLSearchParams(q < 0 ? '' : beforeFragment.slice(q + 1)),
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time token check; hashing gives both sides the same length. */
function tokenMatches(given: string | null, expected: Buffer): boolean {
  return timingSafeEqual(digest(given ?? ''), expected) && given !== null;
}

/** A method name safe to log; anything odd is logged as `?`. */
function logName(method: unknown): string {
  return typeof method === 'string' && /^[A-Za-z][\w.]*$/.test(method)
    ? method
    : '?';
}

function parse(data: RawData): Json | null {
  try {
    const value: unknown = JSON.parse(data.toString());
    return value && typeof value === 'object' ? (value as Json) : null;
  } catch {
    return null;
  }
}

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? (() => undefined);
  const expectedToken = digest(opts.token);

  let ext: WebSocket | null = null;
  let cdp: WebSocket | null = null;
  let stopped = false;
  let nextExtId = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(e: BridgeEvent) => void>();
  const extWaiters = new Set<(ok: boolean) => void>();
  const batchListeners = new Set<(b: RecorderBatch) => void>();

  // ─── Outputs ───────────────────────────────────────────────────────────

  function emit(e: BridgeEvent): void {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch {
        // A listener's failure must not break the relay.
      }
    }
  }

  function sendToCdp(message: Json): void {
    if (cdp?.readyState !== WebSocket.OPEN) return;
    if (typeof message.method === 'string')
      log(`-> ${logName(message.method)}`);
    cdp.send(JSON.stringify(message));
  }

  function callExtension(method: string, params: Json): Promise<unknown> {
    if (ext?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('extension not connected'));
    }
    const id = ++nextExtId;
    ext.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject }),
    );
  }

  // Asked once per extension connection, on the first Browser.getVersion.
  let versionAnswer: Promise<Json | null> | null = null;

  function browserVersion(): Promise<Json> {
    versionAnswer ??= callExtension('browser.version', {}).then(
      (v) => {
        const r = (v ?? {}) as Json;
        return typeof r.userAgent === 'string' && typeof r.product === 'string'
          ? {
              protocolVersion: '1.3',
              product: r.product,
              userAgent: r.userAgent,
              revision: '',
              jsVersion: '',
            }
          : null;
      },
      () => null,
    );
    return versionAnswer.then(
      (v) =>
        v ?? {
          protocolVersion: '1.3',
          product: 'Chrome/Extension-Bridge',
          userAgent: 'CDP-Bridge-Server/1.0.0',
        },
    );
  }

  const model = new BrowserModel(callExtension, sendToCdp);

  // ─── CDP client → relay ────────────────────────────────────────────────

  async function handleCdpCommand(
    method: string,
    params: unknown,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (isRefused(method, params)) throw new Error(`refused: ${method}`);
    // On a tab or child session only allowlisted Target.* methods pass.
    if (sessionId !== undefined && isRefusedOnSession(method, params)) {
      throw new Error(`refused: ${method}`);
    }
    if (sessionId === undefined) {
      switch (method) {
        case 'Browser.getVersion':
          return browserVersion();
        case 'Browser.setDownloadBehavior':
          return {};
      }
    }
    return model.handleCommand(method, params, sessionId);
  }

  async function onCdpMessage(data: RawData): Promise<void> {
    const msg = parse(data);
    if (!msg) return;
    const { id, method, params } = msg;
    const sessionId =
      typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
    log(`<- ${logName(method)}`);
    try {
      if (typeof method !== 'string') throw new Error('bad method');
      const result = await handleCdpCommand(method, params, sessionId);
      sendToCdp({ id, sessionId, result: result ?? {} });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendToCdp({ id, sessionId, error: { code: -32000, message } });
    }
  }

  // ─── Extension → relay ─────────────────────────────────────────────────

  function onExtensionEvent(method: unknown, params: Json): void {
    const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
    switch (method) {
      case 'debugger.event': {
        const source = (params.source ?? {}) as Json;
        const crashed = model.onDebuggerEvent(
          source,
          params.method,
          params.params,
        );
        if (crashed === 'tab-crashed' && typeof source.tabId === 'number') {
          emit({ kind: 'detached', tabId: source.tabId, reason: 'crashed' });
        }
        return;
      }
      case 'debugger.detach':
        if (tabId === undefined) return;
        if (model.onDebuggerDetach(tabId)) {
          emit({
            kind: 'detached',
            tabId,
            reason: String(params.reason ?? ''),
          });
        }
        return;
      case 'tabs.removed':
        // A run tab closed by hand is a stop, even when Chrome reports the
        // removal before (or without) the debugger detach.
        if (tabId !== undefined && model.onTabRemoved(tabId)) {
          emit({ kind: 'detached', tabId, reason: 'tab closed' });
        }
        return;
      case 'window.state':
        // Sent on every bounds or focus change; only minimising matters.
        if (params.state === 'minimized' && tabId !== undefined) {
          emit({ kind: 'window-minimized', tabId });
        }
        return;
      case 'recorder.batch': {
        // Only the method name is logged: batches are the author's timing data.
        log(`<- ext ${logName(method)}`);
        if (!Array.isArray(params.events)) return;
        for (const fn of batchListeners) {
          try {
            fn(params as unknown as RecorderBatch);
          } catch {
            // A listener's failure must not break the relay.
          }
        }
        return;
      }
      // 'ping' keeps the socket alive and needs no answer.
    }
  }

  function onExtensionMessage(data: RawData): void {
    const msg = parse(data);
    if (!msg) return;
    if (typeof msg.id === 'number') {
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) call.reject(new Error(String(msg.error)));
      else call.resolve(msg.result);
      return;
    }
    onExtensionEvent(msg.method, (msg.params ?? {}) as Json);
  }

  // ─── Connections ───────────────────────────────────────────────────────

  function acceptExtension(ws: WebSocket): void {
    ext = ws;
    versionAnswer = null;
    ws.on('message', onExtensionMessage);
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (ext !== ws) return;
      ext = null;
      for (const call of pending.values())
        call.reject(new Error('extension disconnected'));
      pending.clear();
      if (stopped) return;
      model.reset();
      emit({ kind: 'extension-disconnected' });
      // As Playwright does: without the extension the CDP client is done.
      if (cdp?.readyState === WebSocket.OPEN)
        cdp.close(1000, 'extension disconnected');
    });
    for (const resolve of extWaiters) resolve(true);
    extWaiters.clear();
  }

  function acceptCdp(ws: WebSocket): void {
    cdp = ws;
    ws.on('message', (data) => void onCdpMessage(data));
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (cdp !== ws) return;
      cdp = null;
      // Sessions belong to the CDP client. Unlike Playwright, the extension
      // stays connected: it serves the next run too.
      model.reset();
    });
  }

  const server = http.createServer((req, res) => {
    const { pathname, search } = parseTarget(req.url);
    const live = req.method === 'GET' && !stopped;
    const page = live ? STATIC_PAGES.get(pathname) : undefined;
    const slashed = `${pathname}/`;
    if (live && !page && STATIC_PAGES.has(slashed)) {
      // `/typing` -> `/typing/`, keeping the query (printable ASCII only).
      res.writeHead(301, {
        location: slashed + (/^[\x21-\x7e]*$/.test(search) ? search : ''),
      });
      res.end();
      return;
    }
    if (!page) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(page);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = parseTarget(req.url);
    const kind =
      url.pathname === '/cdp'
        ? 'cdp'
        : url.pathname === '/extension'
          ? 'ext'
          : null;
    if (!kind || stopped) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!tokenMatches(url.params.get('token'), expectedToken)) {
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      if ((kind === 'cdp' ? cdp : ext) !== null) {
        ws.close(CLOSE_CONFLICT, 'already connected');
        return;
      }
      if (kind === 'cdp') acceptCdp(ws);
      else acceptExtension(ws);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE' ? new RelayPortInUseError(opts.port) : err,
      );
    });
    server.listen({ port: opts.port, host: HOST }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    cdpUrl: `ws://${HOST}:${port}/cdp?token=${encodeURIComponent(opts.token)}`,

    waitForExtension(timeoutMs: number): Promise<boolean> {
      if (ext) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (ok: boolean) => {
          clearTimeout(timer);
          extWaiters.delete(done);
          resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        extWaiters.add(done);
      });
    },

    onEvent(fn: (e: BridgeEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async crashRunTab(): Promise<void> {
      await model.crashRunTab();
    },

    viewport(): Promise<{ width: number; height: number } | null> {
      return model.viewport();
    },

    uploadOnChooser(
      files: string[],
      open: () => Promise<void>,
      choose: () => Promise<void>,
    ): Promise<void> {
      return model.uploadOnChooser(files, open, choose, CHOOSER_TIMEOUT_MS);
    },

    async startRecording(
      salt: string,
      opts: { mode?: 'runner' } = {},
    ): Promise<void> {
      await callExtension(
        'recorder.start',
        opts.mode ? { salt, mode: opts.mode } : { salt },
      );
    },

    async stopRecording(): Promise<void> {
      await callExtension('recorder.stop', {});
    },

    onRecorderBatch(fn: (b: RecorderBatch) => void): () => void {
      batchListeners.add(fn);
      return () => batchListeners.delete(fn);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      listeners.clear();
      batchListeners.clear();
      for (const resolve of [...extWaiters]) resolve(false);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
