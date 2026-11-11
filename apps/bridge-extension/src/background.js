import { RELAY_PORT, TOKEN } from './config.js';
import { createBridgeCore } from './bridge-core.js';

let ws = null;
let pingTimer = null;

const send = (msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

// The real browser version, so Browser.getVersion is not a bridge giveaway.
async function version() {
  const userAgent = navigator.userAgent;
  let full = '';
  try {
    const { fullVersionList = [] } =
      await navigator.userAgentData.getHighEntropyValues(['fullVersionList']);
    const entry =
      fullVersionList.find((b) => b.brand === 'Google Chrome') ??
      fullVersionList.find((b) => b.brand === 'Chromium');
    full = entry?.version ?? '';
  } catch {
    // fall through to the user agent
  }
  if (!full) full = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? '';
  return { userAgent, product: `Chrome/${full}` };
}

const core = createBridgeCore(
  {
    windows: chrome.windows,
    tabs: chrome.tabs,
    debugger: chrome.debugger,
    scripting: chrome.scripting,
  },
  send,
  { version, onRecording: () => updateBadge() },
);

let connected = false;

// "rec" while recording, "on" while connected, empty otherwise.
function updateBadge() {
  const text = !connected ? '' : core.isRecording() ? 'rec' : 'on';
  chrome.action?.setBadgeText?.({ text });
}

function setBadge(on) {
  connected = on;
  updateBadge();
}

// A restarted service worker starts disconnected: clear a stale "on", and any
// recorder script left registered from before the restart.
setBadge(false);
chrome.scripting
  .unregisterContentScripts({ ids: ['pace-recorder'] })
  .catch(() => undefined);

// Recorder content scripts connect here. Only 'recorder' ports, only while
// recording. The salt goes to the page's content script in memory; batches are
// forwarded to the relay untouched.
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== 'recorder' ||
    port.sender?.id !== chrome.runtime.id ||
    !core.isRecording()
  ) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((batch) => {
    if (!core.isRecording()) {
      port.disconnect();
      return;
    }
    if (batch && typeof batch === 'object') {
      send({ method: 'recorder.batch', params: batch });
    }
  });
  port.postMessage({ salt: core.recorderSalt() });
});

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
    void core.stopRecorder();
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
