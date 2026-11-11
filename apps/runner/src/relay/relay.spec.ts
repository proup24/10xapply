import net from 'node:net';
import { WebSocket } from 'ws';
import {
  RelayPortInUseError,
  startRelay,
  type BridgeEvent,
  type Relay,
} from './relay.js';

const TOKEN = 'test-token-0123456789abcdef';

type Json = Record<string, unknown>;

/** A ws client that records every message and its close code. */
class Client {
  readonly messages: Json[] = [];
  readonly closed: Promise<number>;
  private waiters: {
    pred: (m: Json) => boolean;
    resolve: (m: Json) => void;
  }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Json;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code) => resolve(code)),
    );
  }

  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(pred: (m: Json) => boolean): Promise<Json> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
}

/** A fake bridge extension that answers relay commands. */
class FakeExtension extends Client {
  readonly commands: Json[] = [];
  handlers: Record<string, (params: Json) => unknown> = {
    'run.createWindow': () => ({ tabId: 42, windowId: 7 }),
    'debugger.attach': () => ({}),
    'tabs.remove': () => ({}),
    'debugger.send': (p) =>
      p.method === 'Target.getTargetInfo'
        ? { targetInfo: { targetId: 'T-42', type: 'page', url: 'about:blank' } }
        : {},
  };

  constructor(ws: WebSocket) {
    super(ws);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Json;
      if (msg.id === undefined) return;
      this.commands.push(msg);
      const handler = this.handlers[msg.method as string];
      if (!handler) {
        this.send({ id: msg.id, error: 'unknown method' });
        return;
      }
      this.send({ id: msg.id, result: handler((msg.params ?? {}) as Json) });
    });
  }

  static async connect(port: number, token = TOKEN): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension?token=${token}`);
    const ext = new FakeExtension(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ext;
  }

  methods(): string[] {
    return this.commands.map((c) => c.method as string);
  }
}

function portOf(relay: Relay): number {
  return Number(new URL(relay.cdpUrl).port);
}

let relays: Relay[] = [];
let logs: string[] = [];

async function start(): Promise<Relay> {
  const relay = await startRelay({
    port: 0,
    token: TOKEN,
    log: (l) => logs.push(l),
  });
  relays.push(relay);
  return relay;
}

/** Relay plus a connected extension and CDP client. */
async function connected() {
  const relay = await start();
  const ext = await FakeExtension.connect(portOf(relay));
  expect(await relay.waitForExtension(1000)).toBe(true);
  const cdp = await Client.open(relay.cdpUrl);
  let nextId = 1;
  const call = async (
    method: string,
    params: Json = {},
    sessionId?: string,
  ) => {
    const id = nextId++;
    cdp.send(
      sessionId ? { id, method, params, sessionId } : { id, method, params },
    );
    return cdp.next((m) => m.id === id);
  };
  return { relay, ext, cdp, call };
}

async function openTarget(ctx: Awaited<ReturnType<typeof connected>>) {
  const reply = await ctx.call('Target.createTarget', { url: 'about:blank' });
  const attached = await ctx.cdp.next(
    (m) => m.method === 'Target.attachedToTarget',
  );
  const sessionId = (attached.params as Json).sessionId as string;
  return { reply, attached, sessionId };
}

beforeEach(() => {
  relays = [];
  logs = [];
});

afterEach(async () => {
  await Promise.all(relays.map((r) => r.stop()));
});

describe('relay', () => {
  it('rejects bad token', async () => {
    const relay = await start();
    const port = portOf(relay);
    for (const query of ['?token=wrong', '']) {
      const ext = await Client.open(`ws://127.0.0.1:${port}/extension${query}`);
      expect(await ext.closed).toBe(4401);
      const cdp = await Client.open(`ws://127.0.0.1:${port}/cdp${query}`);
      expect(await cdp.closed).toBe(4401);
    }
    expect(await relay.waitForExtension(10)).toBe(false);
  });

  it('rejects second client', async () => {
    const relay = await start();
    const port = portOf(relay);
    await FakeExtension.connect(port);
    await Client.open(relay.cdpUrl);
    const ext2 = await Client.open(
      `ws://127.0.0.1:${port}/extension?token=${TOKEN}`,
    );
    expect(await ext2.closed).toBe(4409);
    const cdp2 = await Client.open(relay.cdpUrl);
    expect(await cdp2.closed).toBe(4409);
  });

  it('createTarget opens a run window and announces it', async () => {
    const ctx = await connected();
    const { reply, attached, sessionId } = await openTarget(ctx);
    expect(ctx.ext.methods().slice(0, 2)).toEqual([
      'run.createWindow',
      'debugger.attach',
    ]);
    expect(ctx.ext.commands[0].params).toEqual({ url: 'about:blank' });
    expect(ctx.ext.commands[1].params).toEqual({ tabId: 42 });
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
    const params = attached.params as Json;
    expect((params.targetInfo as Json).targetId).toBe('T-42');
    expect(params.waitingForDebugger).toBe(false);
    expect(reply.result).toEqual({ targetId: 'T-42' });
    // The announcement precedes the reply, as Chrome does.
    expect(ctx.cdp.messages.indexOf(attached)).toBeLessThan(
      ctx.cdp.messages.indexOf(reply),
    );
  });

  it('routes session commands to the right tab', async () => {
    const ctx = await connected();
    const { sessionId } = await openTarget(ctx);
    const reply = await ctx.call('Page.enable', {}, sessionId);
    expect(reply.sessionId).toBe(sessionId);
    expect(reply.result).toEqual({});
    const sent = ctx.ext.commands.find(
      (c) => (c.params as Json).method === 'Page.enable',
    );
    expect(sent?.method).toBe('debugger.send');
    expect(sent?.params).toEqual({
      target: { tabId: 42 },
      method: 'Page.enable',
      params: {},
    });

    // A child session announced by the tab routes with its own sessionId.
    ctx.ext.send({
      method: 'debugger.event',
      params: {
        source: { tabId: 42 },
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'CHILD-1',
          targetInfo: { targetId: 'F-1', type: 'iframe' },
        },
      },
    });
    const event = await ctx.cdp.next(
      (m) =>
        m.method === 'Target.attachedToTarget' &&
        (m.params as Json).sessionId === 'CHILD-1',
    );
    expect(event.sessionId).toBe(sessionId);
    await ctx.call('Runtime.enable', {}, 'CHILD-1');
    const child = ctx.ext.commands.find(
      (c) => (c.params as Json).method === 'Runtime.enable',
    );
    expect((child?.params as Json).target).toEqual({
      tabId: 42,
      sessionId: 'CHILD-1',
    });

    // Root-level Target.closeTarget becomes tabs.remove.
    const closed = await ctx.call('Target.closeTarget', { targetId: 'T-42' });
    expect(closed.result).toEqual({ success: true });
    expect(ctx.ext.commands.at(-1)).toMatchObject({
      method: 'tabs.remove',
      params: { tabId: 42 },
    });
  });

  it('answers root commands locally', async () => {
    const ctx = await connected();
    const version = await ctx.call('Browser.getVersion');
    expect((version.result as Json).protocolVersion).toBe('1.3');
    expect(
      await ctx.call('Browser.setDownloadBehavior', { behavior: 'deny' }),
    ).toMatchObject({
      result: {},
    });
    expect(
      await ctx.call('Target.setAutoAttach', {
        autoAttach: true,
        flatten: true,
      }),
    ).toMatchObject({
      result: {},
    });
    expect(await ctx.call('Target.getTargetInfo')).toMatchObject({
      result: {},
    });
    expect(ctx.ext.commands).toEqual([]);
    expect(
      ctx.cdp.messages.some((m) => m.method === 'Target.attachedToTarget'),
    ).toBe(false);
  });

  it('refuses policy methods', async () => {
    const ctx = await connected();
    const methods = [
      'Network.getAllCookies',
      'Storage.getCookies',
      'Browser.close',
      'Page.addScriptToEvaluateOnNewDocument',
    ];
    for (const method of methods) {
      const reply = await ctx.call(method);
      expect(
        ((reply.error as Json).message as string).startsWith('refused:'),
      ).toBe(true);
      expect((reply.error as Json).message).toBe(`refused: ${method}`);
    }
    expect(ctx.ext.commands).toEqual([]);

    // Also on a tab session.
    const { sessionId } = await openTarget(ctx);
    const before = ctx.ext.commands.length;
    const reply = await ctx.call('Network.getAllCookies', {}, sessionId);
    expect((reply.error as Json).message).toBe(
      'refused: Network.getAllCookies',
    );
    expect(ctx.ext.commands.length).toBe(before);
  });

  it('allows only the empty utility-world script', async () => {
    const ctx = await connected();
    const { sessionId } = await openTarget(ctx);
    const method = 'Page.addScriptToEvaluateOnNewDocument';
    const ok = await ctx.call(
      method,
      { source: '', worldName: 'util' },
      sessionId,
    );
    expect(ok.result).toEqual({});
    const sent = ctx.ext.commands.find(
      (c) => (c.params as Json).method === method,
    );
    expect(sent?.params).toEqual({
      target: { tabId: 42 },
      method,
      params: { source: '', worldName: 'util' },
    });
    const before = ctx.ext.commands.length;
    const bad = await ctx.call(method, { source: 'alert(1)' }, sessionId);
    expect((bad.error as Json).message).toBe(`refused: ${method}`);
    expect(ctx.ext.commands.length).toBe(before);
  });

  it('never forwards root Target methods through a tab', async () => {
    const ctx = await connected();
    await openTarget(ctx);
    const before = ctx.ext.commands.length;
    for (const method of [
      'Target.getTargets',
      'Target.attachToTarget',
      'Target.setDiscoverTargets',
      'Target.getBrowserContexts',
      'Target.getTargetInfo',
      'Target.createBrowserContext',
      'Target.attachToBrowserTarget',
    ]) {
      const reply = await ctx.call(method, { targetId: 'X' });
      if (reply.error) {
        expect((reply.error as Json).message).toBe(
          `not supported by the bridge: ${method}`,
        );
      }
    }
    expect(ctx.ext.commands.length).toBe(before);
    const contexts = await ctx.call('Target.getBrowserContexts');
    expect(contexts.result).toEqual({ browserContextIds: [] });
    const getTargets = await ctx.call('Target.getTargets');
    expect((getTargets.error as Json).message).toBe(
      'not supported by the bridge: Target.getTargets',
    );
    // Non-Target browser-scoped commands still go through the tab.
    await ctx.call('Browser.grantPermissions', { permissions: [] });
    expect(ctx.ext.commands.at(-1)).toMatchObject({
      method: 'debugger.send',
      params: { target: { tabId: 42 }, method: 'Browser.grantPermissions' },
    });
  });

  it('learns child sessions only from the tab tree', async () => {
    const ctx = await connected();
    const { sessionId } = await openTarget(ctx);
    // An attach announced on an unknown session is not adopted.
    ctx.ext.send({
      method: 'debugger.event',
      params: {
        source: { tabId: 42, sessionId: 'STRANGER' },
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'ROGUE',
          targetInfo: { targetId: 'R', type: 'page' },
        },
      },
    });
    // A nested attach on a known child is adopted.
    ctx.ext.send({
      method: 'debugger.event',
      params: {
        source: { tabId: 42 },
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'CHILD',
          targetInfo: { targetId: 'F', type: 'iframe' },
        },
      },
    });
    ctx.ext.send({
      method: 'debugger.event',
      params: {
        source: { tabId: 42, sessionId: 'CHILD' },
        method: 'Target.attachedToTarget',
        params: {
          sessionId: 'GRANDCHILD',
          targetInfo: { targetId: 'G', type: 'iframe' },
        },
      },
    });
    await ctx.cdp.next(
      (m) => (m.params as Json | undefined)?.sessionId === 'GRANDCHILD',
    );
    const rogue = await ctx.call('Runtime.enable', {}, 'ROGUE');
    expect((rogue.error as Json).message).toBe('No target for this session');
    const grand = await ctx.call('Runtime.enable', {}, 'GRANDCHILD');
    expect(grand.result).toEqual({});
    expect(ctx.ext.commands.at(-1)?.params).toMatchObject({
      target: { tabId: 42, sessionId: 'GRANDCHILD' },
    });
    expect(sessionId).toBeTruthy();
  });

  it('emits bridge events', async () => {
    const ctx = await connected();
    const events: BridgeEvent[] = [];
    ctx.relay.onEvent((e) => events.push(e));
    const { sessionId } = await openTarget(ctx);

    ctx.ext.send({
      method: 'debugger.detach',
      params: { tabId: 42, reason: 'canceled_by_user' },
    });
    const detached = await ctx.cdp.next(
      (m) => m.method === 'Target.detachedFromTarget',
    );
    expect(detached.params).toMatchObject({ sessionId, targetId: 'T-42' });

    ctx.ext.send({
      method: 'window.state',
      params: { tabId: 42, windowId: 7, state: 'normal' },
    });
    ctx.ext.send({
      method: 'window.state',
      params: { tabId: 42, windowId: 7, state: 'minimized' },
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));

    ctx.ext.ws.close();
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events).toEqual([
      { kind: 'detached', tabId: 42, reason: 'canceled_by_user' },
      { kind: 'window-minimized', tabId: 42 },
      { kind: 'extension-disconnected' },
    ]);
  });

  it('logs method names only', async () => {
    const ctx = await connected();
    const { sessionId } = await openTarget(ctx);
    await ctx.call('Runtime.evaluate', { expression: 'SECRET' }, sessionId);
    expect(logs).toContain('<- Runtime.evaluate');
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain(TOKEN);
      expect(line).toMatch(/^(<-|->) [A-Za-z.]+$/);
    }
  });

  it('waitForExtension times out', async () => {
    const relay = await start();
    const started = Date.now();
    expect(await relay.waitForExtension(50)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);

    const waiting = relay.waitForExtension(5000);
    const connectedAt = Date.now();
    await FakeExtension.connect(portOf(relay));
    expect(await waiting).toBe(true);
    expect(Date.now() - connectedAt).toBeLessThan(1000);
  });

  it('port in use', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const attempt = startRelay({ port, token: TOKEN });
      await expect(attempt).rejects.toBeInstanceOf(RelayPortInUseError);
      await expect(attempt).rejects.toThrow(
        `relay port ${port} is in use; is another runner running?`,
      );
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    // And a second relay on a relay's port.
    const first = await start();
    await expect(
      startRelay({ port: portOf(first), token: TOKEN }),
    ).rejects.toBeInstanceOf(RelayPortInUseError);
  });

  it('binds 127.0.0.1 and carries the bound port', async () => {
    const relay = await start();
    const url = new URL(relay.cdpUrl);
    expect(url.protocol).toBe('ws:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/cdp');
    expect(url.searchParams.get('token')).toBe(TOKEN);
    expect(portOf(relay)).toBeGreaterThan(0);
  });
});
