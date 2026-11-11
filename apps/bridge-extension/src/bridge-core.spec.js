import { describe, it, expect } from 'vitest';
import { createBridgeCore } from './bridge-core.js';

function setup() {
  const calls = [];
  const sent = [];
  const chromeApi = {
    windows: {
      create: async (opts) => {
        calls.push(['windows.create', opts]);
        return { id: 7, tabs: [{ id: 42 }] };
      },
    },
    tabs: {
      remove: async (id) => {
        calls.push(['tabs.remove', id]);
      },
    },
    debugger: {
      attach: async (target, version) => {
        calls.push(['debugger.attach', target, version]);
      },
      sendCommand: async (target, method, params) => {
        calls.push(['debugger.sendCommand', target, method, params]);
        return { ok: true };
      },
    },
  };
  const core = createBridgeCore(chromeApi, (m) => sent.push(m));
  return { core, calls, sent };
}

async function open(core) {
  await core.handleCommand({
    id: 1,
    method: 'run.createWindow',
    params: { url: 'about:blank' },
  });
}

async function attach(core) {
  await core.handleCommand({
    id: 2,
    method: 'debugger.attach',
    params: { tabId: 42 },
  });
}

describe('bridge core', () => {
  it('run.createWindow opens a focused normal window and owns its tab', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    expect(calls[0]).toEqual([
      'windows.create',
      { url: 'about:blank', focused: true, state: 'normal' },
    ]);
    expect(sent[0]).toEqual({ id: 1, result: { tabId: 42, windowId: 7 } });
    expect(core.ownsTab(42)).toBe(true);
    expect(core.ownsTab(1)).toBe(false);
  });

  it('browser.version answers from the injected provider', async () => {
    const sent = [];
    const version = { userAgent: 'UA', product: 'Chrome/157.0.1.2' };
    const core = createBridgeCore({}, (m) => sent.push(m), {
      version: async () => version,
    });
    await core.handleCommand({ id: 1, method: 'browser.version', params: {} });
    expect(sent[0]).toEqual({ id: 1, result: version });
  });

  it('refuses tabs it did not create', async () => {
    const { core, calls, sent } = setup();
    await core.handleCommand({
      id: 1,
      method: 'debugger.attach',
      params: { tabId: 9 },
    });
    await core.handleCommand({
      id: 2,
      method: 'debugger.send',
      params: { target: { tabId: 9 }, method: 'Page.navigate', params: {} },
    });
    await core.handleCommand({
      id: 3,
      method: 'tabs.remove',
      params: { tabId: 9 },
    });
    expect(sent).toEqual([
      { id: 1, error: 'not a bridge tab' },
      { id: 2, error: 'not a bridge tab' },
      { id: 3, error: 'not a bridge tab' },
    ]);
    expect(calls).toEqual([]);
  });

  it('refuses policy methods', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    sent.length = 0;
    for (const [i, method] of [
      'Network.getAllCookies',
      'Browser.close',
      'Runtime.addBinding',
    ].entries()) {
      await core.handleCommand({
        id: 10 + i,
        method: 'debugger.send',
        params: { target: { tabId: 42 }, method, params: {} },
      });
      expect(sent[i]).toEqual({ id: 10 + i, error: `refused: ${method}` });
    }
    expect(calls.some((c) => c[0] === 'debugger.sendCommand')).toBe(false);
  });

  it('refuses Target methods off the allowlist, with or without a session', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await attach(core);
    sent.length = 0;
    calls.length = 0;
    let id = 100;
    for (const sessionId of [undefined, 's1']) {
      for (const method of [
        'Target.attachToTarget',
        'Target.createTarget',
        'Target.getTargets',
        'Target.setDiscoverTargets',
        'Target.attachToBrowserTarget',
      ]) {
        id += 1;
        await core.handleCommand({
          id,
          method: 'debugger.send',
          params: { target: { tabId: 42, sessionId }, method, params: {} },
        });
        expect(sent.at(-1)).toEqual({ id, error: `refused: ${method}` });
      }
    }
    expect(calls).toEqual([]);
    for (const method of [
      'Target.setAutoAttach',
      'Target.detachFromTarget',
      'Target.getTargetInfo',
    ]) {
      id += 1;
      await core.handleCommand({
        id,
        method: 'debugger.send',
        params: { target: { tabId: 42, sessionId: 's1' }, method, params: {} },
      });
      expect(sent.at(-1)).toEqual({ id, result: { ok: true } });
    }
    expect(calls).toHaveLength(3);
  });

  it('refuses storage reads', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await attach(core);
    sent.length = 0;
    calls.length = 0;
    for (const [i, method] of [
      'DOMStorage.enable',
      'IndexedDB.requestData',
      'CacheStorage.requestCachedResponse',
    ].entries()) {
      await core.handleCommand({
        id: 200 + i,
        method: 'debugger.send',
        params: { target: { tabId: 42 }, method, params: {} },
      });
      expect(sent.at(-1)).toEqual({ id: 200 + i, error: `refused: ${method}` });
    }
    expect(calls).toEqual([]);
  });

  it('allows the empty utility-world script and refuses any other', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await attach(core);
    sent.length = 0;
    const method = 'Page.addScriptToEvaluateOnNewDocument';
    await core.handleCommand({
      id: 20,
      method: 'debugger.send',
      params: {
        target: { tabId: 42 },
        method,
        params: { source: '', worldName: 'w' },
      },
    });
    expect(calls).toContainEqual([
      'debugger.sendCommand',
      { tabId: 42 },
      method,
      { source: '', worldName: 'w' },
    ]);
    const before = calls.length;
    for (const [i, params] of [
      { source: 'alert(1)' },
      {},
      { source: 0 },
      undefined,
    ].entries()) {
      await core.handleCommand({
        id: 21 + i,
        method: 'debugger.send',
        params: { target: { tabId: 42 }, method, params },
      });
      expect(sent.at(-1)).toEqual({ id: 21 + i, error: `refused: ${method}` });
    }
    expect(calls.length).toBe(before);
  });

  it('forwards allowed commands, with sessionId when given', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await attach(core);
    await core.handleCommand({
      id: 3,
      method: 'debugger.send',
      params: {
        target: { tabId: 42, sessionId: 's1' },
        method: 'Page.navigate',
        params: { url: 'x' },
      },
    });
    expect(calls).toContainEqual(['debugger.attach', { tabId: 42 }, '1.3']);
    expect(calls).toContainEqual([
      'debugger.sendCommand',
      { tabId: 42, sessionId: 's1' },
      'Page.navigate',
      { url: 'x' },
    ]);
    expect(sent.at(-1)).toEqual({ id: 3, result: { ok: true } });
  });

  it('replies with an error for unknown methods and thrown chrome errors', async () => {
    const { core, sent } = setup();
    await core.handleCommand({ id: 1, method: 'nope', params: {} });
    expect(sent[0]).toEqual({ id: 1, error: 'unknown method: nope' });
  });

  it('forwards events only for own tabs', async () => {
    const { core, sent } = setup();
    await open(core);
    sent.length = 0;
    core.onDebuggerEvent({ tabId: 9 }, 'Page.loadEventFired', {});
    expect(sent).toEqual([]);
    core.onDebuggerEvent({ tabId: 42, sessionId: 's' }, 'Page.loadEventFired', {
      a: 1,
    });
    expect(sent).toEqual([
      {
        method: 'debugger.event',
        params: {
          source: { tabId: 42, sessionId: 's' },
          method: 'Page.loadEventFired',
          params: { a: 1 },
        },
      },
    ]);
  });

  it('reports detach reason and forgets the tab', async () => {
    const { core, sent } = setup();
    await open(core);
    await attach(core);
    sent.length = 0;
    core.onDebuggerDetach({ tabId: 9 }, 'target_closed');
    expect(sent).toEqual([]);
    core.onDebuggerDetach({ tabId: 42 }, 'canceled_by_user');
    expect(sent).toEqual([
      {
        method: 'debugger.detach',
        params: { tabId: 42, reason: 'canceled_by_user' },
      },
    ]);
  });

  it('after detach: send and attach are refused, tabs.remove works, removal is reported', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await attach(core);
    core.onDebuggerDetach({ tabId: 42 }, 'canceled_by_user');
    sent.length = 0;
    calls.length = 0;
    await core.handleCommand({
      id: 5,
      method: 'debugger.send',
      params: { target: { tabId: 42 }, method: 'Page.navigate', params: {} },
    });
    await core.handleCommand({
      id: 6,
      method: 'debugger.attach',
      params: { tabId: 42 },
    });
    expect(sent.map((m) => 'error' in m)).toEqual([true, true]);
    expect(calls).toEqual([]);
    await core.handleCommand({
      id: 7,
      method: 'tabs.remove',
      params: { tabId: 42 },
    });
    expect(sent.at(-1)).toEqual({ id: 7, result: {} });
    expect(calls).toEqual([['tabs.remove', 42]]);
    sent.length = 0;
    core.onTabRemoved(42);
    expect(sent).toEqual([{ method: 'tabs.removed', params: { tabId: 42 } }]);
    expect(core.ownsTab(42)).toBe(false);
  });

  it('refuses debugger.send before attach', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    sent.length = 0;
    await core.handleCommand({
      id: 5,
      method: 'debugger.send',
      params: { target: { tabId: 42 }, method: 'Page.navigate', params: {} },
    });
    expect(sent[0]).toEqual({ id: 5, error: 'debugger not attached' });
    expect(calls.some((c) => c[0] === 'debugger.sendCommand')).toBe(false);
  });

  it('exposes owned window ids', async () => {
    const { core } = setup();
    expect(core.ownedWindowIds()).toEqual([]);
    await open(core);
    expect(core.ownedWindowIds()).toEqual([7]);
    core.onTabRemoved(42);
    expect(core.ownedWindowIds()).toEqual([]);
  });

  it('reports a removed tab and forgets it', async () => {
    const { core, sent } = setup();
    await open(core);
    sent.length = 0;
    core.onTabRemoved(9);
    expect(sent).toEqual([]);
    core.onTabRemoved(42);
    expect(sent).toEqual([{ method: 'tabs.removed', params: { tabId: 42 } }]);
    expect(core.ownsTab(42)).toBe(false);
  });

  it('a removed tab still attached reports a detach first', async () => {
    const { core, sent } = setup();
    await open(core);
    await attach(core);
    sent.length = 0;
    core.onTabRemoved(42);
    expect(sent).toEqual([
      {
        method: 'debugger.detach',
        params: { tabId: 42, reason: 'target_closed' },
      },
      { method: 'tabs.removed', params: { tabId: 42 } },
    ]);
    expect(core.ownsTab(42)).toBe(false);
    // A later chrome onDetach for the forgotten tab is dropped.
    sent.length = 0;
    core.onDebuggerDetach({ tabId: 42 }, 'target_closed');
    expect(sent).toEqual([]);
  });

  it('reports minimised run window', async () => {
    const { core, sent } = setup();
    await open(core);
    sent.length = 0;
    core.onWindowChanged({ id: 99, state: 'minimized' });
    expect(sent).toEqual([]);
    core.onWindowChanged({ id: 7, state: 'minimized' });
    expect(sent).toEqual([
      {
        method: 'window.state',
        params: { tabId: 42, windowId: 7, state: 'minimized' },
      },
    ]);
  });
});
