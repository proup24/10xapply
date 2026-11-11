import net from 'node:net';
import { WebSocket } from 'ws';
import { EXTENSION_TIMEOUT_MS, connectBridge, type Bridge } from './bridge.js';

const TOKEN = 'test-token-0123456789abcdef';

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function fakeExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${TOKEN}`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return ws;
}

const fakeCdp = (() =>
  Promise.resolve({
    contexts: () => [],
    close: () => Promise.resolve(),
  })) as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(50);
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
    await sleep(100);
    expect(bridge.stopReason()).toBe('debugger detached: canceled_by_user');
  });

  it('records a minimised window', async () => {
    const { bridge, ext } = await connected();
    ext.send(
      JSON.stringify({
        method: 'window.state',
        params: { tabId: 1, state: 'minimized' },
      }),
    );
    await sleep(100);
    expect(bridge.stopReason()).toBe('run window minimized');
  });

  it('records an extension disconnect', async () => {
    const { bridge, ext } = await connected();
    ext.close();
    await sleep(100);
    expect(bridge.stopReason()).toBe('extension disconnected');
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
    await sleep(50);
    sockets.push(await fakeExtension(relayPort));
    const bridge = (await p) as Bridge;
    await expect(bridge.close()).resolves.toBeUndefined();
    await expect(bridge.close()).resolves.toBeUndefined();
  });
});
