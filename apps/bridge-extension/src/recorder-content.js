// Content script of the timing recorder, registered only while a recording
// command runs. Streams event timing and shape to the background over a port.
// Passive capture-phase listeners; never preventDefault, never stopPropagation,
// never writes to the DOM. Loaded after recorder-capture.js (same isolated world).
(() => {
  const {
    EVENT_TYPES,
    capture,
    pageInfo,
    jobIdOf,
    jobKeyOf,
    findDescEl,
    makeCtxOf,
  } = globalThis.__paceCapture;
  const FLUSH_MS = 500;
  const MAX_BUFFER = 5000;

  const pageId = globalThis.crypto.randomUUID();
  const ctxOf = makeCtxOf(window);
  const port = chrome.runtime.connect({ name: 'recorder' });

  let salt = null; // from the background; held in memory only
  let buffer = [];
  let descEl = null;
  let pageSent = false;
  let lastHeight = null; // desc height of the last page info sent
  let key = { id: undefined, value: null }; // jobKey cache, by job id
  let timer = null;

  const onEvent = (event) => {
    if (buffer.length >= MAX_BUFFER) return;
    const rec = capture(event, ctxOf, descEl);
    if (rec) buffer.push(rec);
  };

  // A page record goes out first, then again when the description's height
  // changes by more than 20% (or the description appears). Checked per flush.
  function pageIfChanged() {
    descEl = findDescEl(document);
    const info = pageInfo(window, document, descEl);
    const h = info.desc?.height ?? null;
    const first = !pageSent;
    const appeared = lastHeight === null && h !== null;
    const resized =
      lastHeight !== null &&
      h !== null &&
      Math.abs(h - lastHeight) > lastHeight * 0.2;
    if (!first && !appeared && !resized) return undefined;
    pageSent = true;
    if (h !== null) lastHeight = h;
    return info;
  }

  async function currentKey() {
    const id = jobIdOf(location.pathname, location.search);
    if (id === null) return null;
    if (key.id !== id) key = { id, value: await jobKeyOf(salt, id) };
    return key.value;
  }

  async function flush() {
    if (salt === null) return;
    const events = buffer;
    buffer = [];
    const page = pageIfChanged();
    if (events.length === 0 && !page) return;
    const batch = { pageId, jobKey: await currentKey(), events };
    if (page) batch.page = page;
    try {
      port.postMessage(batch);
    } catch {
      stop();
    }
  }

  // On pagehide there is no time to hash: send what is cached for this job.
  function flushNow() {
    if (salt === null || buffer.length === 0) return;
    const id = jobIdOf(location.pathname, location.search);
    const batch = {
      pageId,
      jobKey: id !== null && key.id === id ? key.value : null,
      events: buffer,
    };
    buffer = [];
    try {
      port.postMessage(batch);
    } catch {
      // port already closed
    }
  }

  function stop() {
    clearInterval(timer);
    for (const type of EVENT_TYPES)
      window.removeEventListener(type, onEvent, true);
    window.removeEventListener('pagehide', flushNow, true);
    buffer = [];
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
