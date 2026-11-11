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
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;
  const sock = new WebSocket(
    `ws://127.0.0.1:${RELAY_PORT}/extension?token=${encodeURIComponent(TOKEN)}`,
  );
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    setBadge(true);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ method: 'ping', params: {} }), 20_000);
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    void core.handleCommand(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setBadge(false);
    clearInterval(pingTimer);
    ws = null;
  };
  sock.onerror = () => sock.close();
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
// A minimised window may not fire onBoundsChanged; on any focus change
// (including WINDOW_ID_NONE) re-read each run window and report its state.
chrome.windows.onFocusChanged.addListener(async () => {
  for (const id of core.ownedWindowIds()) {
    try {
      core.onWindowChanged(await chrome.windows.get(id));
    } catch {
      // window already gone
    }
  }
});
