import net from 'node:net';
import { WebSocket } from 'ws';
import { EXTENSION_TIMEOUT_MS, connectBridge, type Bridge } from './bridge.js';

const TOKEN = 'test-token-0123456789abcdef';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A free port below Linux's ephemeral range (32768+). Outgoing connections,
// including the fake extension's retries, pick source ports from that range,
// and a port from there can be taken, or even self-connected, before the
// relay binds it.
async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const s = net.createServer();
    const ok = await new Promise<boolean>((r) => {
      s.once('error', () => r(false));
      s.listen(port, '127.0.0.1', () => r(true));
    });
    if (!ok) continue;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }
}

// The relay starts inside connectBridge, so the first connection attempts
// may be refused until it listens: retry every 10 ms for up to 2 s.
async function fakeExtension(port: number): Promise<WebSocket> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      return ws;
    } catch (e) {
      ws.terminate();
      const refused = (e as NodeJS.ErrnoException).code === 'ECONNREFUSED';
      if (!refused || Date.now() > deadline) throw e;
      await sleep(10);
    }
  }
}

// Waits for the bridge to record a stop, polling every 5 ms for up to 2 s:
// the event, not a guessed delay, ends the wait.
async function stopReasonOf(bridge: Bridge): Promise<string | null> {
  const deadline = Date.now() + 2000;
  while (bridge.stopReason() === null && Date.now() < deadline) await sleep(5);
  return bridge.stopReason();
}

const fakeCdp = (() =>
  Promise.resolve({
    contexts: () => [],
    close: () => Promise.resolve(),
  })) as never;

describe('connectBridge', () => {
  const open: { close(): Promise<void> }[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    for (const b of open.splice(0)) await b.close();
  });

  async function connected(): Promise<{ bridge: Bridge; ext: WebSocket }> {
    const relayPort = await freePort();
    const p = connectBridge(
      { relayPort, token: TOKEN },
      { connectOverCDP: fakeCdp, timeoutMs: 5000 },
    );
    const ext = await fakeExtension(relayPort);
    sockets.push(ext);
    const bridge = await p;
    if ('unavailable' in bridge) throw new Error(bridge.unavailable);
    open.push(bridge);
    return { bridge, ext };
  }

  it('has a 45 s default timeout', () => {
    expect(EXTENSION_TIMEOUT_MS).toBe(45_000);
  });

  it('reports unavailable when the extension never connects', async () => {
    const relayPort = await freePort();
    const r = await connectBridge(
      { relayPort, token: TOKEN },
      { connectOverCDP: fakeCdp, timeoutMs: 50 },
    );
    expect(r).toEqual({
      unavailable:
        'the bridge extension did not connect within 45 s: is Chrome open, is the extension loaded, and is WSL networking mirrored?',
    });
  });

  it('records a debugger detach as the stop reason', async () => {
    const { bridge, ext } = await connected();
    expect(bridge.stopReason()).toBeNull();
    ext.send(
      JSON.stringify({
        method: 'debugger.detach',
        params: { tabId: 1, reason: 'canceled_by_user' },
      }),
    );
    expect(await stopReasonOf(bridge)).toBe(
      'debugger detached: canceled_by_user',
    );
  });

  it('records a hand-closed run tab', async () => {
    const relayPort = await freePort();
    let cdpSocket: WebSocket | null = null;
    const p = connectBridge(
      { relayPort, token: TOKEN },
      {
        // A raw CDP client standing in for Patchright: it opens one tab.
        connectOverCDP: (async (url: string) => {
          const ws = new WebSocket(url);
          cdpSocket = ws;
          await new Promise<void>((res, rej) => {
            ws.once('open', () => res());
            ws.once('error', rej);
          });
          return { contexts: () => [], close: () => Promise.resolve() };
        }) as never,
        timeoutMs: 5000,
      },
    );
    const ext = await fakeExtension(relayPort);
    sockets.push(ext);
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        method: string;
        params: { method?: string };
      };
      if (msg.id === undefined) return;
      const result =
        msg.method === 'run.createWindow'
          ? { tabId: 5, windowId: 6 }
          : msg.params.method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'T-5', type: 'page' } }
            : {};
      ext.send(JSON.stringify({ id: msg.id, result }));
    });
    const bridge = await p;
    if ('unavailable' in bridge) throw new Error(bridge.unavailable);
    open.push(bridge);
    const cdp = cdpSocket as unknown as WebSocket;
    sockets.push(cdp);
    const replied = new Promise<void>((res) =>
      cdp.on('message', (data) => {
        if ((JSON.parse(data.toString()) as { id?: number }).id === 1) res();
      }),
    );
    cdp.send(
      JSON.stringify({ id: 1, method: 'Target.createTarget', params: {} }),
    );
    await replied;
    expect(bridge.stopReason()).toBeNull();
    ext.send(JSON.stringify({ method: 'tabs.removed', params: { tabId: 5 } }));
    expect(await stopReasonOf(bridge)).toBe('debugger detached: tab closed');
  });

  it('records a minimised window', async () => {
    const { bridge, ext } = await connected();
    ext.send(
      JSON.stringify({
        method: 'window.state',
        params: { tabId: 1, state: 'minimized' },
      }),
    );
    expect(await stopReasonOf(bridge)).toBe('run window minimized');
  });

  it('records an extension disconnect', async () => {
    const { bridge, ext } = await connected();
    ext.close();
    expect(await stopReasonOf(bridge)).toBe('extension disconnected');
  });

  it('starts the recorder in runner mode', async () => {
    const { bridge, ext } = await connected();
    const seen: unknown[] = [];
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        method: string;
        params: unknown;
      };
      if (msg.id === undefined) return;
      seen.push([msg.method, msg.params]);
      ext.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    await bridge.startRecording('salt-1');
    expect(seen).toEqual([
      ['recorder.start', { salt: 'salt-1', mode: 'runner' }],
    ]);
  });

  it('close never throws, even when the browser close fails', async () => {
    const relayPort = await freePort();
    const p = connectBridge(
      { relayPort, token: TOKEN },
      {
        connectOverCDP: (() =>
          Promise.resolve({
            contexts: () => [],
            close: () => Promise.reject(new Error('refused: Browser.close')),
          })) as never,
        timeoutMs: 5000,
      },
    );
    sockets.push(await fakeExtension(relayPort));
    const bridge = (await p) as Bridge;
    await expect(bridge.close()).resolves.toBeUndefined();
    await expect(bridge.close()).resolves.toBeUndefined();
  });
});
