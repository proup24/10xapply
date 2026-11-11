// Pure capture helpers for the timing recorder. They turn DOM events into
// timing-and-shape records. They never copy typed text, key values, page
// text, labels, option labels, element ids or classes, or full URLs.
//
// This file is a classic content script (content scripts cannot import ESM)
// and is also imported by Vitest. Either way it exposes its functions on one
// namespaced global, globalThis.__paceCapture, and exports nothing.
//
// The record shapes mirror apps/runner/src/pace/recording.ts:
//   RecordedEvent { t, type, trusted, x?, y?, sx?, sy?, mx?, my?, button?,
//     pointerType?, dy?, dm?, key?: 'space'|'backspace'|'other',
//     target: { kind, hasValue?, options?, picked?, inDescription? },
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
  const DESC_SELECTORS = [
    '#job-details',
    '[class*="jobs-description"]',
    'article',
  ];
  const INTERACTIVE = 'a,button,[role="button"],input,textarea,select';

  const isElement = (n) => !!n && typeof n.tagName === 'string';

  /** Path with the query and hash dropped and id-like segments as :id. */
  function pathPattern(pathname) {
    const path = String(pathname ?? '').split(/[?#]/)[0];
    return path
      .split('/')
      .map((seg) => (/\d{5,}/.test(seg) ? ':id' : seg))
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

  function findDescEl(doc) {
    for (const sel of DESC_SELECTORS) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** ctxOf(target) => { path, dialog, progress } for an event target. */
  function makeCtxOf(win) {
    return (target) => {
      const path = pathPattern(win.location.pathname);
      const dialog = isElement(target)
        ? (target.closest('[role="dialog"]') ?? null)
        : null;
      let progress = null;
      const bar = dialog?.querySelector('[role="progressbar"]');
      const now = Number(bar?.getAttribute('aria-valuenow'));
      if (
        bar &&
        bar.getAttribute('aria-valuenow') !== null &&
        Number.isFinite(now)
      ) {
        progress = now;
      }
      return { path, dialog: dialog !== null, progress };
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
    const root = el.form ?? el.ownerDocument;
    const name = el.getAttribute('name');
    return [...root.querySelectorAll('input')].filter(
      (i) =>
        (i.getAttribute('type') ?? '').toLowerCase() === 'radio' &&
        i.getAttribute('name') === name,
    );
  }

  function targetOf(raw, type, descEl) {
    if (!isElement(raw)) return { kind: 'other' };
    const el = raw.closest(INTERACTIVE) ?? raw;
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
    if (descEl?.contains(el)) target.inDescription = true;
    return target;
  }

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
      if (type.startsWith('pointer')) out.pointerType = event.pointerType;
    } else if (type === 'wheel') {
      out.dy = event.deltaY;
      out.dm = event.deltaMode;
    } else if (type === 'keydown' || type === 'keyup') {
      out.key = keyClass(event.key);
    }
    out.target = targetOf(event.target, type, descEl);
    out.ctx = ctxOf(event.target);
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

  globalThis.__paceCapture = Object.freeze({
    EVENT_TYPES,
    capture,
    pageInfo,
    pathPattern,
    jobIdOf,
    jobKeyOf,
    findDescEl,
    makeCtxOf,
  });
})();
