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
