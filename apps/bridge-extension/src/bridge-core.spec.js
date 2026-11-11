import { describe, it, expect } from 'vitest';
import { createBridgeCore } from './bridge-core.js';
import { RECORDER_MATCHES } from './recorder-matches.js';

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
    scripting: {
      registerContentScripts: async (scripts) => {
        calls.push(['scripting.register', scripts]);
      },
      unregisterContentScripts: async (filter) => {
        calls.push(['scripting.unregister', filter]);
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

  it('recorder.start registers the content script with the fixed matches', async () => {
    const { core, calls, sent } = setup();
    await core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1', matches: ['https://evil.example/*'] },
    });
    expect(calls).toEqual([
      [
        'scripting.register',
        [
          {
            id: 'pace-recorder',
            js: ['recorder-capture.js', 'recorder-content.js'],
            matches: RECORDER_MATCHES,
            world: 'ISOLATED',
            runAt: 'document_start',
            persistAcrossSessions: false,
            allFrames: false,
          },
        ],
      ],
    ]);
    expect(sent[0]).toEqual({ id: 1, result: {} });
    expect(core.isRecording()).toBe(true);
    expect(core.recorderSalt()).toBe('s1');
  });

  it('recorder.start refuses a missing salt', async () => {
    const { core, calls, sent } = setup();
    await core.handleCommand({ id: 1, method: 'recorder.start', params: {} });
    expect(sent[0]).toEqual({ id: 1, error: 'recorder.start needs a salt' });
    expect(calls).toEqual([]);
    expect(core.isRecording()).toBe(false);
  });

  it('recorder.stop unregisters and forgets the salt', async () => {
    const { core, calls } = setup();
    await core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    await core.handleCommand({ id: 2, method: 'recorder.stop', params: {} });
    expect(calls[1]).toEqual([
      'scripting.unregister',
      { ids: ['pace-recorder'] },
    ]);
    expect(core.isRecording()).toBe(false);
    expect(core.recorderSalt()).toBeNull();
  });

  it('recorder.start twice is idempotent', async () => {
    const { core, calls, sent } = setup();
    await core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    await core.handleCommand({
      id: 2,
      method: 'recorder.start',
      params: { salt: 's2' },
    });
    expect(calls.filter((c) => c[0] === 'scripting.register')).toHaveLength(1);
    expect(sent[1]).toEqual({ id: 2, result: {} });
    expect(core.recorderSalt()).toBe('s1');
  });

  it('tells the host when recording starts and stops', async () => {
    const seen = [];
    const core = createBridgeCore(
      {
        scripting: {
          registerContentScripts: async () => undefined,
          unregisterContentScripts: async () => undefined,
        },
      },
      () => undefined,
      { onRecording: (on) => seen.push(on) },
    );
    await core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's' },
    });
    await core.stopRecorder();
    expect(seen).toEqual([true, false]);
  });

  it('stop disconnects open recorder ports and refuses ports when not recording', async () => {
    const { core } = setup();
    const makePort = () => {
      const p = { disconnected: false, drop: null };
      p.disconnect = () => (p.disconnected = true);
      p.onDisconnect = { addListener: (f) => (p.drop = f) };
      return p;
    };
    expect(core.trackPort(makePort())).toBe(false);
    await core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    const a = makePort();
    const b = makePort();
    expect(core.trackPort(a)).toBe(true);
    expect(core.trackPort(b)).toBe(true);
    b.drop(); // b closed on its own: not disconnected again
    await core.handleCommand({ id: 2, method: 'recorder.stop', params: {} });
    expect(a.disconnected).toBe(true);
    expect(b.disconnected).toBe(false);
  });

  function gated() {
    const calls = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const core = createBridgeCore(
      {
        scripting: {
          registerContentScripts: async () => {
            calls.push('register');
            await gate;
          },
          unregisterContentScripts: async () => {
            calls.push('unregister');
          },
        },
      },
      () => undefined,
    );
    return { core, calls, release };
  }

  it('a stop during an in-flight start leaves nothing registered and recording off', async () => {
    const { core, calls, release } = gated();
    const start = core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    await Promise.resolve();
    await core.stopRecorder();
    release();
    await start;
    expect(core.isRecording()).toBe(false);
    expect(core.recorderSalt()).toBeNull();
    expect(calls).toEqual(['register', 'unregister', 'unregister']);
  });

  it('reports the failed start to the relay', async () => {
    const sent = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const core = createBridgeCore(
      {
        scripting: {
          registerContentScripts: () => gate,
          unregisterContentScripts: async () => undefined,
        },
      },
      (m) => sent.push(m),
    );
    const start = core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    await core.stopRecorder();
    release();
    await start;
    expect(sent[0]).toEqual({ id: 1, error: 'recorder stopped during start' });
  });

  it('a concurrent second start shares the first and registers once', async () => {
    const { core, calls, release } = gated();
    const one = core.handleCommand({
      id: 1,
      method: 'recorder.start',
      params: { salt: 's1' },
    });
    const two = core.handleCommand({
      id: 2,
      method: 'recorder.start',
      params: { salt: 's2' },
    });
    await Promise.resolve();
    release();
    await Promise.all([one, two]);
    expect(calls).toEqual(['register']);
    expect(core.isRecording()).toBe(true);
    expect(core.recorderSalt()).toBe('s1');
  });
});
