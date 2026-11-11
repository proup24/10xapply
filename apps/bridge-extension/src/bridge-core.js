import { isRefused } from './policy.js';

const NOT_OWNED = 'not a bridge tab';

/**
 * Wire logic of the bridge, kept free of real chrome.* so it can be tested.
 * chromeApi is { windows, tabs, debugger }; send(obj) writes one JSON message
 * to the relay.
 *
 * Only tabs created by run.createWindow are owned. Everything else is refused
 * here, independently of the relay.
 *
 * onWindowChanged(win) takes `{ id, state }` (a chrome Window works) and sends
 * window.state when win.id is the window of an owned tab.
 */
export function createBridgeCore(chromeApi, send) {
  const owned = new Map(); // tabId -> windowId

  const ownsTab = (tabId) => owned.has(tabId);

  const commands = {
    async 'run.createWindow'(params) {
      const win = await chromeApi.windows.create({
        url: params?.url,
        focused: true,
        state: 'normal',
      });
      const tabId = win?.tabs?.[0]?.id;
      if (typeof win?.id !== 'number' || typeof tabId !== 'number') {
        throw new Error('window has no tab');
      }
      owned.set(tabId, win.id);
      return { tabId, windowId: win.id };
    },

    async 'tabs.remove'(params) {
      if (!ownsTab(params?.tabId)) throw new Error(NOT_OWNED);
      await chromeApi.tabs.remove(params.tabId);
      return {};
    },

    async 'debugger.attach'(params) {
      if (!ownsTab(params?.tabId)) throw new Error(NOT_OWNED);
      await chromeApi.debugger.attach({ tabId: params.tabId }, '1.3');
      return {};
    },

    async 'debugger.send'(params) {
      const target = params?.target;
      if (!ownsTab(target?.tabId)) throw new Error(NOT_OWNED);
      const method = params.method;
      if (typeof method !== 'string') throw new Error('bad method');
      if (isRefused(method)) throw new Error(`refused: ${method}`);
      const chromeTarget =
        target.sessionId === undefined
          ? { tabId: target.tabId }
          : { tabId: target.tabId, sessionId: target.sessionId };
      return chromeApi.debugger.sendCommand(chromeTarget, method, params.params);
    },
  };

  async function handleCommand(msg) {
    const handler = Object.hasOwn(commands, msg?.method)
      ? commands[msg.method]
      : null;
    if (!handler) {
      send({ id: msg?.id, error: `unknown method: ${msg?.method}` });
      return;
    }
    try {
      const result = await handler(msg.params);
      send({ id: msg.id, result: result ?? {} });
    } catch (e) {
      send({ id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function onDebuggerEvent(source, method, params) {
    if (!ownsTab(source?.tabId)) return;
    send({ method: 'debugger.event', params: { source, method, params } });
  }

  function onDebuggerDetach(source, reason) {
    if (!ownsTab(source?.tabId)) return;
    send({ method: 'debugger.detach', params: { tabId: source.tabId, reason } });
    owned.delete(source.tabId);
  }

  function onTabRemoved(tabId) {
    if (!ownsTab(tabId)) return;
    send({ method: 'tabs.removed', params: { tabId } });
    owned.delete(tabId);
  }

  function onWindowChanged(win) {
    for (const [tabId, windowId] of owned) {
      if (windowId === win?.id) {
        send({ method: 'window.state', params: { tabId, windowId, state: win.state } });
      }
    }
  }

  return { handleCommand, ownsTab, onDebuggerEvent, onDebuggerDetach, onTabRemoved, onWindowChanged };
}
