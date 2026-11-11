// Content script of the timing recorder, registered only while a recording
// command runs. Streams event timing and shape to the background over a port.
// Passive capture-phase listeners; never preventDefault, never stopPropagation,
// never writes to the DOM. Loaded after recorder-capture.js (same isolated world).
// On LinkedIn it is injected on every page (the site is a single-page app), and
// the recorder captures and sends nothing outside /jobs/, checked per event.
(() => {
  const { EVENT_TYPES, NON_COMPOSED_TYPES, jobKeyOf, makeRecorder } = globalThis.__paceCapture;
  const FLUSH_MS = 500;

  const port = chrome.runtime.connect({ name: 'recorder' });
  let salt = null; // from the background; held in memory only
  let timer = null;
  const listened = []; // shadow roots carrying our listeners
  const onEvent = (event) => recorder.onEvent(event);
  // Non-composed events (change, scroll) stay inside an open shadow root, so
  // each root the recorder notes gets the same passive capture listeners. The
  // recorder calls this once per root and records an event once even if it
  // also reaches the window.
  const onRoot = (root) => {
    listened.push(root);
    for (const type of NON_COMPOSED_TYPES)
      root.addEventListener(type, onEvent, { capture: true, passive: true });
  };
  const recorder = makeRecorder({
    onRoot,
    win: window,
    doc: document,
    pageId: globalThis.crypto.randomUUID(),
    hash: (id) => jobKeyOf(salt, id),
  });

  function post(batches) {
    for (const batch of batches) port.postMessage(batch);
  }

  async function flush() {
    if (salt === null) return;
    const batches = await recorder.flush();
    try {
      post(batches);
    } catch {
      stop();
    }
  }

  // On pagehide there is no time to hash: send with the cached jobKeys.
  function flushNow() {
    if (salt === null) return;
    try {
      post(recorder.flushNow());
    } catch {
      // port already closed
    }
  }

  function stop() {
    clearInterval(timer);
    for (const type of EVENT_TYPES)
      window.removeEventListener(type, onEvent, true);
    window.removeEventListener('pagehide', flushNow, true);
    for (const root of listened)
      for (const type of NON_COMPOSED_TYPES)
        root.removeEventListener(type, onEvent, true);
    listened.length = 0;
    recorder.clear();
    salt = null;
  }

  for (const type of EVENT_TYPES) {
    window.addEventListener(type, onEvent, { capture: true, passive: true });
  }
  window.addEventListener('pagehide', flushNow, {
    capture: true,
    passive: true,
  });

  port.onDisconnect.addListener(stop);
  port.onMessage.addListener((msg) => {
    if (salt !== null || typeof msg?.salt !== 'string') return;
    salt = msg.salt;
    timer = setInterval(() => void flush(), FLUSH_MS);
    void flush();
  });
})();
