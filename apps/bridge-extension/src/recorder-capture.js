// Capture helpers for the timing recorder. They turn DOM events into
// timing-and-shape records, and makeRecorder batches them per job. They never
// copy typed text, key values, page text, labels, option labels, element ids
// or classes, or full URLs. They only read the DOM, never write to it.
//
// LinkedIn renders parts of the job pane and the Easy Apply modal inside open
// shadow roots, so the real target is composedPath()[0] and every ancestor
// walk crosses shadow roots (closestAcross).
//
// This file is a classic content script (content scripts cannot import ESM)
// and is also imported by Vitest. Either way it exposes its functions on one
// namespaced global, globalThis.__paceCapture, and exports nothing.
//
// The record shapes mirror apps/runner/src/pace/recording.ts:
//   RecordedEvent { t, type, trusted, x?, y?, sx?, sy?, mx?, my?, button?,
//     pointerType?, dy?, dm?, key?: 'space'|'backspace'|'other',
//     ox?, oy?,  (press point inside the target box, 0..1, 3 decimals)
//     target: { kind, hasValue?, options?, picked?, inDescription?,
//       shadow?,  (true when the real target is inside a shadow root)
//       w?, h? },  (target box size, CSS px, integers)
//     ctx: { path, dialog, progress } }
//   PageInfo { t, ctx, desc: { chars, height } | null, win, screen, dpr }
(() => {
  const EVENT_TYPES = [
    'pointermove',
    'pointerover',
    'pointerdown',
    'pointerup',
    'mousemove',
    'mousedown',
    'mouseup',
    'click',
    'wheel',
    'keydown',
    'keyup',
    'focusin',
    'change',
    'scroll',
  ];
  // Not composed: these never leave an open shadow root, so the window
  // listeners miss them and each noted root needs its own listeners.
  const NON_COMPOSED_TYPES = ['change', 'scroll'];
  const DESC_SELECTORS = [
    '#job-details',
    '[class*="jobs-description"]',
    '[class*="job-details"]',
    '[data-testid*="description" i]',
    'article',
  ];
  const INTERACTIVE = 'a,button,[role="button"],input,textarea,select';
  const DIALOG =
    '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]';

  const isElement = (n) => !!n && typeof n.tagName === 'string';
  const isShadowRoot = (n) => !!n && n.nodeType === 11 && isElement(n.host);

  /** The parent element, stepping from a shadow root's top to its host. */
  function parentAcross(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode?.();
    return isShadowRoot(root) ? root.host : null;
  }

  /** Like el.closest(), but crosses open shadow roots. `test` is a selector or a predicate. */
  function closestAcross(el, test) {
    const match = typeof test === 'string' ? (n) => n.matches(test) : test;
    for (let n = el; n; n = parentAcross(n)) if (match(n)) return n;
    return null;
  }

  /** The element the event really hit: composedPath()[0], not the retargeted host. */
  function realTarget(event) {
    const path =
      typeof event.composedPath === 'function' ? event.composedPath() : [];
    return isElement(path[0]) ? path[0] : event.target;
  }

  /**
   * True when this page may be recorded, checked per event: on LinkedIn only
   * under /jobs/, and on 127.0.0.1 only the relay's practice and typing pages
   * (any other local app stays unrecorded).
   */
  function recordable(loc) {
    const path = String(loc.pathname ?? '');
    if (loc.hostname === 'www.linkedin.com') return path.startsWith('/jobs/');
    if (loc.hostname === '127.0.0.1')
      return /^\/(practice|typing)(\/|$)/.test(path);
    return true;
  }

  // Path segments kept as they are. They name pages, never a person, a
  // search or a place; every other segment is replaced.
  const KNOWN_SEGMENTS = new Set([
    'jobs',
    'view',
    'search',
    'search-results',
    'collections',
    'recommended',
    'apply',
    'practice',
    'typing',
    'are_you_a_bot_interactions',
  ]);

  /**
   * Path with the query and hash dropped. Known segments stay; a segment with
   * a number in it (an id, or a slug ending in one) becomes :id, and any other
   * segment (keywords, a city, a title) becomes :slug.
   */
  function pathPattern(pathname) {
    const path = String(pathname ?? '').split(/[?#]/)[0];
    return path
      .split('/')
      .map((seg) => {
        if (seg === '' || KNOWN_SEGMENTS.has(seg)) return seg;
        if (/^\d+$/.test(seg) || /\d{5,}/.test(seg)) return ':id';
        return ':slug';
      })
      .join('/');
  }

  /** The job id this page is about, or null. Never leaves the content script. */
  function jobIdOf(pathname, search) {
    const params = new URLSearchParams(search ?? '');
    const view = /^\/jobs\/view\/(?:[^/]*-)?(\d+)/.exec(pathname ?? '');
    if (view) return view[1];
    const current = params.get('currentJobId');
    if (current) return current;
    return params.get('run') || null;
  }

  /** First 12 hex characters of SHA-256(salt + id). */
  async function jobKeyOf(salt, id) {
    const bytes = new TextEncoder().encode(salt + id);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  }

  /** The job description element in the document or the given shadow roots, or null. */
  function findDescEl(doc, roots = []) {
    for (const sel of DESC_SELECTORS) {
      for (const scope of [doc, ...roots]) {
        const el = scope.querySelector(sel);
        if (el) return el;
      }
    }
    return null;
  }

  /** Percent done of the dialog's progress bar (light DOM or its shadow tree), or null. */
  function progressOf(dialog) {
    for (const scope of [dialog, dialog.shadowRoot]) {
      if (!scope) continue;
      const bar = scope.querySelector('[role="progressbar"][aria-valuenow]');
      const now = Number(bar?.getAttribute('aria-valuenow'));
      if (bar && Number.isFinite(now)) return now;
      const meter = scope.querySelector('progress[value]');
      const value = Number(meter?.getAttribute('value'));
      if (meter && Number.isFinite(value)) {
        const max = Number(meter.getAttribute('max'));
        return Math.round((value / (max || 1)) * 100);
      }
    }
    return null;
  }

  /** ctxOf(target) => { path, dialog, progress } for an event's real target. */
  function makeCtxOf(win) {
    return (target) => {
      const path = pathPattern(win.location.pathname);
      const dialog = isElement(target) ? closestAcross(target, DIALOG) : null;
      return {
        path,
        dialog: dialog !== null,
        progress: dialog ? progressOf(dialog) : null,
      };
    };
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button')
      return 'button';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['text', 'email', 'tel', 'search', 'url', 'password'].includes(type))
        return 'text';
      if (type === 'number') return 'number';
      if (type === 'radio' || type === 'checkbox' || type === 'file')
        return type;
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
    }
    return 'other';
  }

  function radioGroup(el) {
    const tree = el.getRootNode?.();
    const root = el.form ?? (isShadowRoot(tree) ? tree : el.ownerDocument);
    const name = el.getAttribute('name');
    return [...root.querySelectorAll('input')].filter(
      (i) =>
        (i.getAttribute('type') ?? '').toLowerCase() === 'radio' &&
        i.getAttribute('name') === name,
    );
  }

  const BOX_TYPES = /^(pointer|mouse)(down|up)$|^click$|^pointerover$/;
  const PRESS_TYPES = /^(pointer|mouse)(down|up)$|^click$/;

  /** The interactive element an event targets, or null for a non-element. */
  const interactiveOf = (raw) =>
    isElement(raw) ? (closestAcross(raw, INTERACTIVE) ?? raw) : null;

  /** Box size and press offset: numbers only, and only for the listed types. */
  function boxOf(el, event) {
    if (typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const box = { w: Math.round(r.width), h: Math.round(r.height) };
    if (PRESS_TYPES.test(event.type)) {
      const round3 = (v) => Math.round(v * 1000) / 1000;
      const ox = round3((event.clientX - r.left) / r.width);
      const oy = round3((event.clientY - r.top) / r.height);
      if (Number.isFinite(ox) && Number.isFinite(oy)) {
        box.ox = ox;
        box.oy = oy;
      }
    }
    return box;
  }

  function targetOf(raw, type, descEl) {
    if (!isElement(raw)) return { kind: 'other' };
    const el = interactiveOf(raw);
    const kind = kindOf(el);
    const target = { kind };
    if (
      type === 'focusin' &&
      ['text', 'textarea', 'number', 'select'].includes(kind)
    ) {
      target.hasValue = String(el.value ?? '') !== '';
    }
    if (kind === 'select') {
      target.options = el.options.length;
      if (type === 'change') target.picked = el.selectedIndex;
    } else if (kind === 'radio') {
      const group = radioGroup(el);
      target.options = group.length;
      if (type === 'change') target.picked = group.indexOf(el);
    }
    if (descEl && closestAcross(el, (n) => n === descEl))
      target.inDescription = true;
    if (isShadowRoot(raw.getRootNode?.())) target.shadow = true;
    return target;
  }

  // Any other pointerType (a page-made event can carry any string) is ''.
  const POINTER_TYPES = ['mouse', 'pen', 'touch'];

  const keyClass = (key) =>
    key === ' ' ? 'space' : key === 'Backspace' ? 'backspace' : 'other';

  /** One DOM event as a RecordedEvent, or null for an event type we do not record. */
  function capture(event, ctxOf, descEl) {
    const type = event.type;
    if (!EVENT_TYPES.includes(type)) return null;
    const out = {
      t: globalThis.performance.timeOrigin + event.timeStamp,
      type,
      trusted: event.isTrusted === true,
    };
    if (/^(pointer|mouse)/.test(type) || type === 'click') {
      Object.assign(out, {
        x: event.clientX,
        y: event.clientY,
        sx: event.screenX,
        sy: event.screenY,
        mx: event.movementX,
        my: event.movementY,
      });
      if (/down$|up$|^click$/.test(type)) out.button = event.button;
      if (type.startsWith('pointer')) {
        out.pointerType = POINTER_TYPES.includes(event.pointerType)
          ? event.pointerType
          : '';
      }
    } else if (type === 'wheel') {
      out.dy = event.deltaY;
      out.dm = event.deltaMode;
    } else if (type === 'keydown' || type === 'keyup') {
      out.key = keyClass(event.key);
    }
    const raw = realTarget(event);
    out.target = targetOf(raw, type, descEl);
    if (BOX_TYPES.test(type)) {
      const el = interactiveOf(raw);
      const box = el ? boxOf(el, event) : null;
      if (box) {
        out.target.w = box.w;
        out.target.h = box.h;
        if (box.ox !== undefined) {
          out.ox = box.ox;
          out.oy = box.oy;
        }
      }
    }
    out.ctx = ctxOf(raw);
    return out;
  }

  function pageInfo(win, doc, descEl) {
    return {
      t: globalThis.performance.timeOrigin + globalThis.performance.now(),
      ctx: {
        path: pathPattern(win.location.pathname),
        dialog: false,
        progress: null,
      },
      desc: descEl
        ? {
            chars: (descEl.textContent ?? '').length,
            height: descEl.getBoundingClientRect().height,
          }
        : null,
      win: {
        screenX: win.screenX,
        screenY: win.screenY,
        outerWidth: win.outerWidth,
        outerHeight: win.outerHeight,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
      },
      screen: { width: win.screen.width, height: win.screen.height },
      dpr: win.devicePixelRatio,
    };
  }

  /**
   * The recorder's state for one document: buffers captured events with the
   * job id current when each was captured, and turns them into batches split
   * by job. A page record goes out first, and again when the path pattern or
   * the job changes, when the description appears, or when its height changes
   * by more than 20%. The description is looked up again on every flush, in
   * the document and in the open shadow roots that recent events passed
   * through (at most MAX_ROOTS). `hash(id)` gives the jobKey for a job id; job
   * ids never leave this object. `onRoot(root)`, if given, is called once per
   * open shadow root the first time one is seen, so the caller can listen for
   * the non-composed types on it; an event that reaches both such a listener
   * and the window listener is recorded once.
   */
  function makeRecorder({ win, doc, pageId, hash, onRoot }) {
    const MAX_BUFFER = 5000;
    const MAX_ROOTS = 8;
    const MAX_KEYS = 200;
    const ctxOf = makeCtxOf(win);
    const keys = new Map(); // job id -> jobKey
    const seenRoots = new WeakSet(); // roots already passed to onRoot
    const handled = new WeakSet(); // events already recorded
    let roots = []; // open shadow roots seen on event paths, newest last
    let buffer = []; // { id, rec }
    let descEl = null;
    let last = null; // { path, id, height } of the last page record sent

    const jobId = () => jobIdOf(win.location.pathname, win.location.search);

    function noteRoots(event) {
      if (typeof event.composedPath !== 'function') return;
      for (const n of event.composedPath()) {
        if (!isShadowRoot(n)) continue;
        // A root evicted below keeps whatever listener onRoot attached
        // (harmless: events there still pass the same gates), and is not
        // announced again if it is seen later.
        if (!seenRoots.has(n)) {
          seenRoots.add(n);
          if (typeof onRoot === 'function') onRoot(n);
        }
        if (roots.includes(n)) continue;
        roots.push(n);
        if (roots.length > MAX_ROOTS) roots.shift();
      }
    }

    function onEvent(event) {
      if (!recordable(win.location) || buffer.length >= MAX_BUFFER) return;
      if (handled.has(event)) return;
      handled.add(event);
      noteRoots(event);
      const rec = capture(event, ctxOf, descEl);
      if (rec) buffer.push({ id: jobId(), rec });
    }

    /** { id, info } when a page record is due, else null. */
    function pageIfChanged() {
      if (!recordable(win.location)) return null;
      roots = roots.filter((r) => r.host.isConnected !== false);
      descEl = findDescEl(doc, roots);
      const info = pageInfo(win, doc, descEl);
      const id = jobId();
      const h = info.desc?.height ?? null;
      const due =
        last === null ||
        last.path !== info.ctx.path ||
        last.id !== id ||
        (last.height === null && h !== null) ||
        (last.height !== null &&
          h !== null &&
          Math.abs(h - last.height) > last.height * 0.2);
      if (!due) {
        if (h === null) last.height = null;
        return null;
      }
      last = { path: info.ctx.path, id, height: h };
      return { id, info };
    }

    /** Consecutive buffered events grouped by job id, oldest first. */
    function takeGroups() {
      const groups = [];
      for (const { id, rec } of buffer) {
        const g = groups.at(-1);
        if (g && g.id === id) g.events.push(rec);
        else groups.push({ id, events: [rec] });
      }
      buffer = [];
      return groups;
    }

    async function keyOf(id) {
      if (id === null) return null;
      if (!keys.has(id)) {
        if (keys.size >= MAX_KEYS) keys.clear();
        keys.set(id, await hash(id));
      }
      return keys.get(id);
    }

    /** All due batches, split by job. */
    async function flush() {
      const groups = takeGroups();
      const page = pageIfChanged();
      if (page) {
        const g = groups.at(-1);
        if (g && g.id === page.id) g.page = page.info;
        else groups.push({ id: page.id, events: [], page: page.info });
      }
      const batches = [];
      for (const g of groups) {
        const batch = { pageId, jobKey: await keyOf(g.id), events: g.events };
        if (g.page) batch.page = g.page;
        batches.push(batch);
      }
      return batches;
    }

    /** Buffered events now, without hashing: jobKeys come from the cache, else null. */
    function flushNow() {
      return takeGroups().map((g) => ({
        pageId,
        jobKey: g.id !== null && keys.has(g.id) ? keys.get(g.id) : null,
        events: g.events,
      }));
    }

    function clear() {
      buffer = [];
      roots = [];
    }

    return { onEvent, flush, flushNow, clear };
  }

  globalThis.__paceCapture = Object.freeze({
    EVENT_TYPES,
    NON_COMPOSED_TYPES,
    capture,
    pageInfo,
    pathPattern,
    recordable,
    jobIdOf,
    jobKeyOf,
    findDescEl,
    makeCtxOf,
    makeRecorder,
  });
})();
