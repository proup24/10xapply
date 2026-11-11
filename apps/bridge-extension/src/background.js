import { RELAY_PORT, TOKEN } from './config.js';
import { createBridgeCore } from './bridge-core.js';

let ws = null;
let pingTimer = null;

const send = (msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

const core = createBridgeCore(
  { windows: chrome.windows, tabs: chrome.tabs, debugger: chrome.debugger },
  send,
);

function setBadge(on) {
  chrome.action?.setBadgeText?.({ text: on ? 'on' : '' });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/extension?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    setBadge(true);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ method: 'ping', params: {} }), 20_000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    void core.handleCommand(msg);
  };
  ws.onclose = () => {
    setBadge(false);
    clearInterval(pingTimer);
    ws = null;
  };
  ws.onerror = () => ws?.close();
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
  connect();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'reconnect') connect();
});
// The service worker may be restarted by Chrome; reconnect whenever it wakes.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
connect();

chrome.debugger.onEvent.addListener(core.onDebuggerEvent);
chrome.debugger.onDetach.addListener(core.onDebuggerDetach);
chrome.tabs.onRemoved.addListener((tabId) => core.onTabRemoved(tabId));
chrome.windows.onBoundsChanged.addListener((win) => core.onWindowChanged(win));
// A minimised window may not fire onBoundsChanged; check on focus changes too.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    core.onWindowChanged(await chrome.windows.get(windowId));
  } catch {
    // window already gone
  }
});
