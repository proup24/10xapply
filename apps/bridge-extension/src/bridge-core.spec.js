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

  it('refuses tabs it did not create', async () => {
    const { core, calls, sent } = setup();
    await core.handleCommand({ id: 1, method: 'debugger.attach', params: { tabId: 9 } });
    await core.handleCommand({
      id: 2,
      method: 'debugger.send',
      params: { target: { tabId: 9 }, method: 'Page.navigate', params: {} },
    });
    await core.handleCommand({ id: 3, method: 'tabs.remove', params: { tabId: 9 } });
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
    for (const [i, method] of ['Network.getAllCookies', 'Browser.close', 'Runtime.addBinding'].entries()) {
      await core.handleCommand({
        id: 10 + i,
        method: 'debugger.send',
        params: { target: { tabId: 42 }, method, params: {} },
      });
      expect(sent[i]).toEqual({ id: 10 + i, error: `refused: ${method}` });
    }
    expect(calls.some((c) => c[0] === 'debugger.sendCommand')).toBe(false);
  });

  it('forwards allowed commands, with sessionId when given', async () => {
    const { core, calls, sent } = setup();
    await open(core);
    await core.handleCommand({ id: 2, method: 'debugger.attach', params: { tabId: 42 } });
    await core.handleCommand({
      id: 3,
      method: 'debugger.send',
      params: { target: { tabId: 42, sessionId: 's1' }, method: 'Page.navigate', params: { url: 'x' } },
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
    core.onDebuggerEvent({ tabId: 42, sessionId: 's' }, 'Page.loadEventFired', { a: 1 });
    expect(sent).toEqual([
      {
        method: 'debugger.event',
        params: { source: { tabId: 42, sessionId: 's' }, method: 'Page.loadEventFired', params: { a: 1 } },
      },
    ]);
  });

  it('reports detach reason and forgets the tab', async () => {
    const { core, sent } = setup();
    await open(core);
    sent.length = 0;
    core.onDebuggerDetach({ tabId: 9 }, 'target_closed');
    expect(sent).toEqual([]);
    core.onDebuggerDetach({ tabId: 42 }, 'canceled_by_user');
    expect(sent).toEqual([
      { method: 'debugger.detach', params: { tabId: 42, reason: 'canceled_by_user' } },
    ]);
    expect(core.ownsTab(42)).toBe(false);
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

  it('reports minimised run window', async () => {
    const { core, sent } = setup();
    await open(core);
    sent.length = 0;
    core.onWindowChanged({ id: 99, state: 'minimized' });
    expect(sent).toEqual([]);
    core.onWindowChanged({ id: 7, state: 'minimized' });
    expect(sent).toEqual([
      { method: 'window.state', params: { tabId: 42, windowId: 7, state: 'minimized' } },
    ]);
  });
});
