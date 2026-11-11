import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import './recorder-capture.js';

const {
  capture,
  pageInfo,
  pathPattern,
  makeCtxOf,
  jobIdOf,
  jobKeyOf,
  findDescEl,
  makeRecorder,
} = globalThis.__paceCapture;

function dom(html, pathname = '/jobs/view/4012345678/') {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
  const win = Object.assign(window, {});
  const loc = { pathname, search: '' };
  const fakeWin = {
    location: loc,
    screenX: 1,
    screenY: 2,
    outerWidth: 1000,
    outerHeight: 800,
    innerWidth: 990,
    innerHeight: 700,
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 1.25,
  };
  return { document, win, fakeWin, ctxOf: makeCtxOf(fakeWin) };
}

const ev = (type, target, extra = {}) => ({
  type,
  target,
  timeStamp: 10,
  isTrusted: true,
  ...extra,
});

describe('capture', () => {
  it('keydown records only the key class', () => {
    const { document, ctxOf } = dom('<input id="i">');
    const t = document.querySelector('input');
    const a = capture(ev('keydown', t, { key: 'a' }), ctxOf, null);
    expect(a.key).toBe('other');
    expect(capture(ev('keydown', t, { key: ' ' }), ctxOf, null).key).toBe(
      'space',
    );
    expect(capture(ev('keyup', t, { key: 'Backspace' }), ctxOf, null).key).toBe(
      'backspace',
    );
    expect(JSON.stringify(a)).not.toContain('"a"');
  });

  it('never copies text', () => {
    const { document, ctxOf } = dom(
      '<label>Secret</label><label>Secret <button id="b" class="cls">Apply now</button></label>',
    );
    const out = capture(
      ev('click', document.querySelector('button'), { clientX: 5 }),
      ctxOf,
      null,
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain('Apply');
    expect(json).not.toContain('Secret');
    expect(json).not.toContain('cls');
    expect(json).not.toContain('"b"');
  });

  it('target kinds', () => {
    const { document, ctxOf } = dom(`
      <input type="text"><input type="email"><input type="tel"><input type="number">
      <textarea></textarea><select><option>x</option></select>
      <input type="radio" name="r"><input type="checkbox"><input type="file">
      <button>b</button><div role="button">d</div><a href="/x">l</a><p>p</p>`);
    const kinds = [...document.body.children].map(
      (el) => capture(ev('click', el), ctxOf, null).target.kind,
    );
    expect(kinds).toEqual([
      'text',
      'text',
      'text',
      'number',
      'textarea',
      'select',
      'radio',
      'checkbox',
      'file',
      'button',
      'button',
      'link',
      'other',
    ]);
  });

  it('a click on a span inside a button targets the button', () => {
    const { document, ctxOf } = dom('<button><span>x</span></button>');
    const out = capture(
      ev('click', document.querySelector('span')),
      ctxOf,
      null,
    );
    expect(out.target.kind).toBe('button');
  });

  it('focusin records hasValue only', () => {
    const { document, ctxOf } = dom(
      '<input type="text" value="x"><input type="text">',
    );
    const [full, empty] = document.querySelectorAll('input');
    full.value = 'x';
    const out = capture(ev('focusin', full), ctxOf, null);
    expect(out.target).toEqual({ kind: 'text', hasValue: true });
    expect(JSON.stringify(out)).not.toContain('"x"');
    expect(capture(ev('focusin', empty), ctxOf, null).target.hasValue).toBe(
      false,
    );
  });

  it('change on select records options and picked', () => {
    const { document, ctxOf } = dom(
      '<select><option>a</option><option>b</option><option>c</option><option>d</option></select>',
    );
    const sel = document.querySelector('select');
    sel.selectedIndex = 2;
    const out = capture(ev('change', sel), ctxOf, null);
    expect(out.target).toEqual({ kind: 'select', options: 4, picked: 2 });
  });

  it('radio group counts same-name radios', () => {
    const { document, ctxOf } = dom(`
      <input type="radio" name="g"><input type="radio" name="g"><input type="radio" name="g">
      <input type="radio" name="other">`);
    const radios = document.querySelectorAll('input');
    expect(capture(ev('focusin', radios[1]), ctxOf, null).target.options).toBe(
      3,
    );
    expect(capture(ev('change', radios[1]), ctxOf, null).target).toEqual({
      kind: 'radio',
      options: 3,
      picked: 1,
    });
  });

  it('marks targets inside the description', () => {
    const { document, ctxOf } = dom(
      '<div id="job-details"><a>x</a></div><a>y</a>',
    );
    const desc = findDescEl(document);
    const [inside, outside] = document.querySelectorAll('a');
    expect(capture(ev('click', inside), ctxOf, desc).target.inDescription).toBe(
      true,
    );
    expect(
      capture(ev('click', outside), ctxOf, desc).target,
    ).not.toHaveProperty('inDescription');
  });

  it('records pointer, wheel and unknown events', () => {
    const { document, ctxOf } = dom('<p>x</p>');
    const p = document.querySelector('p');
    const m = capture(
      ev('pointermove', p, {
        clientX: 1,
        clientY: 2,
        screenX: 3,
        screenY: 4,
        movementX: 5,
        movementY: 6,
        pointerType: 'mouse',
        isTrusted: false,
      }),
      ctxOf,
      null,
    );
    expect(m).toMatchObject({
      type: 'pointermove',
      trusted: false,
      x: 1,
      y: 2,
      sx: 3,
      sy: 4,
      mx: 5,
      my: 6,
      pointerType: 'mouse',
    });
    expect(
      capture(ev('wheel', p, { deltaY: 100, deltaMode: 0 }), ctxOf, null),
    ).toMatchObject({ dy: 100, dm: 0 });
    expect(capture(ev('input', p), ctxOf, null)).toBeNull();
  });
});

describe('target box', () => {
  const withRect = (el, rect) => {
    el.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 40,
      ...rect,
    });
  };

  it('click on a 100x40 button centre gives w, h, ox, oy', () => {
    const { document, ctxOf } = dom('<button id="b">Apply now</button>');
    const b = document.querySelector('button');
    withRect(b, {});
    const out = capture(
      ev('click', b, { clientX: 60, clientY: 40, button: 0 }),
      ctxOf,
      null,
    );
    expect(out.target).toMatchObject({ kind: 'button', w: 100, h: 40 });
    expect(out.ox).toBe(0.5);
    expect(out.oy).toBe(0.5);
  });

  it('uses the interactive ancestor of the event target', () => {
    const { document, ctxOf } = dom('<button><span>x</span></button>');
    withRect(document.querySelector('button'), {});
    const out = capture(
      ev('pointerdown', document.querySelector('span'), {
        clientX: 10,
        clientY: 20,
      }),
      ctxOf,
      null,
    );
    expect(out.target.w).toBe(100);
    expect(out.ox).toBe(0);
    expect(out.oy).toBe(0);
  });

  it('pointerover carries the size but no press offset', () => {
    const { document, ctxOf } = dom('<button>b</button>');
    const b = document.querySelector('button');
    withRect(b, {});
    const out = capture(ev('pointerover', b, { clientX: 60 }), ctxOf, null);
    expect(out.target.w).toBe(100);
    expect(out).not.toHaveProperty('ox');
    expect(out).not.toHaveProperty('oy');
  });

  it('pointermove carries no w, h, ox or oy', () => {
    const { document, ctxOf } = dom('<button>b</button>');
    const b = document.querySelector('button');
    let calls = 0;
    b.getBoundingClientRect = () => {
      calls++;
      return { left: 0, top: 0, width: 100, height: 40 };
    };
    const out = capture(
      ev('pointermove', b, { clientX: 5, clientY: 5 }),
      ctxOf,
      null,
    );
    expect(out.target).not.toHaveProperty('w');
    expect(out.target).not.toHaveProperty('h');
    expect(out).not.toHaveProperty('ox');
    expect(out).not.toHaveProperty('oy');
    expect(calls).toBe(0);
  });

  it('a zero-size rect gives no fields', () => {
    const { document, ctxOf } = dom('<button>b</button>');
    const b = document.querySelector('button');
    withRect(b, { width: 0 });
    const out = capture(
      ev('click', b, { clientX: 10, clientY: 20 }),
      ctxOf,
      null,
    );
    expect(out.target).toEqual({ kind: 'button' });
    expect(out).not.toHaveProperty('ox');
    withRect(b, { height: 0 });
    const out2 = capture(ev('click', b, { clientX: 10 }), ctxOf, null);
    expect(out2.target).toEqual({ kind: 'button' });
  });

  it('still contains no text', () => {
    const { document, ctxOf } = dom(
      '<button id="secret-id" class="secret-cls">Secret label</button>',
    );
    const b = document.querySelector('button');
    withRect(b, {});
    const json = JSON.stringify(
      capture(ev('mousedown', b, { clientX: 60, clientY: 40 }), ctxOf, null),
    );
    expect(json).not.toMatch(/Secret|secret/);
  });
});

describe('ctx', () => {
  it('dialog is true inside [role=dialog] and progress reads aria-valuenow', () => {
    const { document, ctxOf } = dom(
      '<div role="dialog"><div role="progressbar" aria-valuenow="40"></div><button>n</button></div><button>o</button>',
    );
    const [inside, outside] = document.querySelectorAll('button');
    expect(capture(ev('click', inside), ctxOf, null).ctx).toEqual({
      path: '/jobs/view/:id/',
      dialog: true,
      progress: 40,
    });
    expect(capture(ev('click', outside), ctxOf, null).ctx).toMatchObject({
      dialog: false,
      progress: null,
    });
  });

  it('progress is null without a progressbar', () => {
    const { document, ctxOf } = dom(
      '<div role="dialog"><button>n</button></div>',
    );
    expect(
      capture(ev('click', document.querySelector('button')), ctxOf, null).ctx
        .progress,
    ).toBeNull();
  });

  it('a non-element target (window) gives a plain ctx', () => {
    const { ctxOf } = dom('');
    const out = capture(ev('scroll', {}), ctxOf, null);
    expect(out.target).toEqual({ kind: 'other' });
    expect(out.ctx.dialog).toBe(false);
  });
});

describe('pathPattern', () => {
  it('replaces ids and drops the query', () => {
    expect(pathPattern('/jobs/view/4012345678/')).toBe('/jobs/view/:id/');
    expect(pathPattern('/jobs/search/?currentJobId=123')).toBe('/jobs/search/');
    expect(pathPattern('/jobs/view/senior-engineer-at-acme-4012345678/')).toBe(
      '/jobs/view/:id/',
    );
  });
});

describe('job key', () => {
  it('finds the job id from the path, currentJobId or run', () => {
    expect(jobIdOf('/jobs/view/4012345678/', '')).toBe('4012345678');
    expect(jobIdOf('/jobs/view/some-title-4012345678/', '')).toBe('4012345678');
    expect(jobIdOf('/jobs/search/', '?currentJobId=99')).toBe('99');
    expect(jobIdOf('/practice', '?run=r1')).toBe('r1');
    expect(jobIdOf('/page', '')).toBeNull();
  });

  it('is 12 hex characters of SHA-256(salt + id) and the id does not appear', async () => {
    const k = await jobKeyOf('salt', '4012345678');
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(k).not.toContain('4012345678');
    expect(await jobKeyOf('salt', '4012345678')).toBe(k);
    expect(await jobKeyOf('other', '4012345678')).not.toBe(k);
  });
});

describe('pageInfo', () => {
  it('with no description gives desc null', () => {
    const { document, fakeWin } = dom('<p>x</p>');
    const info = pageInfo(fakeWin, document, null);
    expect(info.desc).toBeNull();
    expect(info.ctx).toEqual({
      path: '/jobs/view/:id/',
      dialog: false,
      progress: null,
    });
    expect(info.screen).toEqual({ width: 1920, height: 1080 });
    expect(info.dpr).toBe(1.25);
  });

  it('with a description gives its length and height, not its text', () => {
    const { document, fakeWin } = dom(
      '<div id="job-details">Hello world</div>',
    );
    const el = findDescEl(document);
    el.getBoundingClientRect = () => ({ height: 321 });
    const info = pageInfo(fakeWin, document, el);
    expect(info.desc).toEqual({ chars: 11, height: 321 });
    expect(JSON.stringify(info)).not.toContain('Hello');
  });
});

// A fake event that crosses shadow roots the way a real one does: target is
// retargeted to the outermost host, composedPath()[0] is the real target.
function composedEv(type, real, extra = {}) {
  const path = [];
  for (let n = real; n;) {
    path.push(n);
    if (n.parentNode) n = n.parentNode;
    else n = n.host ?? null;
  }
  let target = real;
  for (const n of path) if (n.host) target = n.host;
  return { ...ev(type, target, extra), composedPath: () => path };
}

function shadowDom(
  inner,
  outer = '<div role="dialog"><div id="host"></div></div>',
) {
  const d = dom(outer);
  const root = d.document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = inner;
  return { ...d, root };
}

describe('shadow DOM', () => {
  it('a target inside an open shadow root in a dialog gives dialog, kind and shadow', () => {
    const { root, ctxOf } = shadowDom('<button><span>Next</span></button>');
    const out = capture(
      composedEv('click', root.querySelector('span')),
      ctxOf,
      null,
    );
    expect(out.target.kind).toBe('button');
    expect(out.target.shadow).toBe(true);
    expect(out.ctx.dialog).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Next');
  });

  it('a light-DOM target has no shadow field', () => {
    const { document, ctxOf } = dom('<button>b</button>');
    const out = capture(
      composedEv('click', document.querySelector('button')),
      ctxOf,
      null,
    );
    expect(out.target).not.toHaveProperty('shadow');
  });

  it('a dialog inside the shadow root counts too', () => {
    const { root, ctxOf } = shadowDom(
      '<div aria-modal="true"><input type="text"></div>',
      '<div id="host"></div>',
    );
    const out = capture(
      composedEv('focusin', root.querySelector('input')),
      ctxOf,
      null,
    );
    expect(out.target.kind).toBe('text');
    expect(out.ctx.dialog).toBe(true);
  });

  it('dialog[open] and [role=alertdialog] are dialogs', () => {
    const { document, ctxOf } = dom(
      '<dialog open><button>a</button></dialog><div role="alertdialog"><button>b</button></div>',
    );
    for (const b of document.querySelectorAll('button'))
      expect(capture(ev('click', b), ctxOf, null).ctx.dialog).toBe(true);
  });

  it('inDescription crosses shadow roots', () => {
    const { document, ctxOf } = dom(
      '<div id="job-details"><div id="host"></div></div>',
    );
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<a>x</a>';
    const out = capture(
      composedEv('click', root.querySelector('a')),
      ctxOf,
      findDescEl(document),
    );
    expect(out.target.inDescription).toBe(true);
  });

  it('radio groups count within the shadow root', () => {
    const { root, ctxOf } = shadowDom(
      '<input type="radio" name="g"><input type="radio" name="g">',
    );
    const r = root.querySelectorAll('input')[1];
    expect(capture(composedEv('change', r), ctxOf, null).target).toMatchObject({
      kind: 'radio',
      options: 2,
      picked: 1,
    });
  });
});

describe('progress', () => {
  it('a <progress value=50 max=100> in the dialog gives 50', () => {
    const { document, ctxOf } = dom(
      '<div role="dialog"><progress value="50" max="100"></progress><button>n</button></div>',
    );
    expect(
      capture(ev('click', document.querySelector('button')), ctxOf, null).ctx
        .progress,
    ).toBe(50);
  });

  it('a <progress> without max uses max 1', () => {
    const { document, ctxOf } = dom(
      '<div role="dialog"><progress value="0.25"></progress><button>n</button></div>',
    );
    expect(
      capture(ev('click', document.querySelector('button')), ctxOf, null).ctx
        .progress,
    ).toBe(25);
  });

  it("a progress in the dialog host's shadow tree counts", () => {
    const { document, ctxOf } = dom('<div role="dialog" id="d"></div>');
    const root = document.getElementById('d').attachShadow({ mode: 'open' });
    root.innerHTML =
      '<progress value="3" max="4"></progress><button>n</button>';
    expect(
      capture(composedEv('click', root.querySelector('button')), ctxOf, null)
        .ctx.progress,
    ).toBe(75);
  });
});

describe('findDescEl', () => {
  it('tries the selectors in order', () => {
    expect(
      findDescEl(
        dom('<article></article><div class="x-job-details-y"></div>').document,
      ).tagName,
    ).toBe('DIV');
    expect(
      findDescEl(
        dom(
          '<article></article><section data-testid="JobDescription"></section>',
        ).document,
      ).tagName,
    ).toBe('SECTION');
  });

  it('searches the given shadow roots', () => {
    const { root, document } = shadowDom('<div id="job-details">x</div>');
    expect(findDescEl(document)).toBeNull();
    expect(findDescEl(document, [root])).toBe(root.firstChild);
  });
});

describe('makeRecorder', () => {
  function setup(
    html = '<button>b</button>',
    path = '/jobs/search-results/',
    search = '?currentJobId=111111',
    hash = async (id) => `k${id}`,
  ) {
    const d = dom(html, path);
    d.fakeWin.location.hostname = 'www.linkedin.com';
    d.fakeWin.location.search = search;
    const rec = makeRecorder({
      win: d.fakeWin,
      doc: d.document,
      pageId: 'p1',
      hash,
    });
    return { ...d, rec, loc: d.fakeWin.location };
  }

  it('captures nothing off /jobs/ on linkedin', async () => {
    const { rec, loc, document } = setup('<button>b</button>', '/feed/', '');
    rec.onEvent(ev('click', document.querySelector('button')));
    expect(await rec.flush()).toEqual([]);
    expect(rec.flushNow()).toEqual([]);
    loc.pathname = '/jobs/collections/';
    rec.onEvent(ev('click', document.querySelector('button')));
    const batches = await rec.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(1);
  });

  it('captures on the other recorder pages whatever the path', async () => {
    const { rec, loc, document } = setup(
      '<button>b</button>',
      '/practice',
      '?run=r1',
    );
    loc.hostname = '127.0.0.1';
    rec.onEvent(ev('click', document.querySelector('button')));
    const [b] = await rec.flush();
    expect(b).toMatchObject({ pageId: 'p1', jobKey: 'kr1' });
    expect(b.events).toHaveLength(1);
  });

  it('sends a page first, then again on a jobKey change', async () => {
    const { rec, loc } = setup();
    const first = await rec.flush();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ jobKey: 'k111111', events: [] });
    expect(first[0].page.ctx.path).toBe('/jobs/search-results/');
    expect(await rec.flush()).toEqual([]);
    loc.search = '?currentJobId=222222';
    const second = await rec.flush();
    expect(second).toHaveLength(1);
    expect(second[0].jobKey).toBe('k222222');
    expect(second[0].page).toBeDefined();
  });

  it('sends a page again on a path pattern change', async () => {
    const { rec, loc } = setup('', '/jobs/view/4012345678/', '');
    await rec.flush();
    loc.pathname = '/jobs/view/4012345678/apply/';
    const [b] = await rec.flush();
    expect(b.page.ctx.path).toBe('/jobs/view/:id/apply/');
  });

  it('sends a page when the description appears, and finds it again each flush', async () => {
    const { rec, document } = setup('<div id="pane"></div>');
    const [first] = await rec.flush();
    expect(first.page.desc).toBeNull();
    const desc = document.createElement('div');
    desc.setAttribute('id', 'job-details');
    desc.textContent = 'About the job';
    desc.getBoundingClientRect = () => ({ height: 400 });
    document.getElementById('pane').appendChild(desc);
    const [second] = await rec.flush();
    expect(second.page.desc).toEqual({ chars: 13, height: 400 });
    expect(JSON.stringify(second)).not.toContain('About');
    expect(await rec.flush()).toEqual([]);
    desc.getBoundingClientRect = () => ({ height: 600 });
    const [third] = await rec.flush();
    expect(third.page.desc.height).toBe(600);
  });

  it('finds a description inside a shadow root seen on an event path', async () => {
    const { rec, document } = setup('<div id="host"></div>');
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="jobs-description__content">x</div><a>y</a>';
    root.firstChild.getBoundingClientRect = () => ({ height: 50 });
    const [first] = await rec.flush();
    expect(first.page.desc).toBeNull();
    rec.onEvent(composedEv('pointermove', root.querySelector('a')));
    const [second] = await rec.flush();
    expect(second.page.desc).toEqual({ chars: 1, height: 50 });
    expect(second.events[0].target.shadow).toBe(true);
  });

  it('splits a batch whose events straddle a job change', async () => {
    const { rec, loc, document } = setup();
    await rec.flush();
    const b = document.querySelector('button');
    rec.onEvent(ev('click', b));
    loc.search = '?currentJobId=222222';
    rec.onEvent(ev('click', b));
    rec.onEvent(ev('keydown', b, { key: 'x' }));
    const batches = await rec.flush();
    expect(batches.map((x) => [x.jobKey, x.events.length, !!x.page])).toEqual([
      ['k111111', 1, false],
      ['k222222', 2, true],
    ]);
  });

  it('flushNow sends cached keys only, split by job', async () => {
    const { rec, loc, document } = setup();
    await rec.flush();
    const b = document.querySelector('button');
    rec.onEvent(ev('click', b));
    loc.search = '?currentJobId=333333';
    rec.onEvent(ev('click', b));
    expect(rec.flushNow().map((x) => [x.jobKey, x.events.length])).toEqual([
      ['k111111', 1],
      [null, 1],
    ]);
    expect(rec.flushNow()).toEqual([]);
  });

  it('the batches carry no text, ids or classes', async () => {
    const { rec, root } = (() => {
      const s = setup(
        '<div role="dialog" class="secret-cls"><div id="host"></div></div><div id="job-details">Secret words</div>',
        '/jobs/search-results/',
        '?currentJobId=111111',
        (id) => jobKeyOf('salt', id),
      );
      const root = s.document
        .getElementById('host')
        .attachShadow({ mode: 'open' });
      root.innerHTML =
        '<label>Secret label<input type="text" id="secret-id" value="Secret value"></label>';
      return { ...s, root };
    })();
    const input = root.querySelector('input');
    input.value = 'Secret value';
    rec.onEvent(composedEv('focusin', input));
    rec.onEvent(composedEv('keydown', input, { key: 'S' }));
    const json = JSON.stringify(await rec.flush());
    expect(json).not.toMatch(/secret|Secret|111111|"S"/);
  });
});
