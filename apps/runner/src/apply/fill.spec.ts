import { describe, expect, it } from 'vitest';
import type { Locator } from 'patchright-core';
import type { Pace } from '../pace/pace.js';
import type { ReadField } from '../linkedin/types.js';
import { fillField, type FillPage, type Resume } from './fill.js';

/** A stand-in locator that only remembers its selector. */
const loc = (sel: string) => ({ sel }) as unknown as Locator;
const selOf = (l: Locator) => (l as unknown as { sel: string }).sel;

/**
 * Records each call and plays it onto the fake page's state: a click
 * toggles the box (unless the selector is inert), typing appends, clearing
 * empties.
 */
function fakePace(calls: string[], s: PageState = {}): Pace {
  return {
    mood: 1,
    defaulted: [],
    click: async (t) => {
      const sel = selOf(t);
      calls.push(`click ${sel}`);
      if (s.inert?.includes(sel)) return;
      s.checked = { ...s.checked, [sel]: !(s.checked?.[sel] ?? false) };
    },
    type: async (f, text) => {
      const sel = selOf(f);
      calls.push(`type ${sel} ${text}`);
      if (s.deaf?.includes(sel)) return;
      s.values = { ...s.values, [sel]: (s.values?.[sel] ?? '') + text };
    },
    clear: async (f) => {
      const sel = selOf(f);
      calls.push(`clear ${sel}`);
      if (s.sticky?.includes(sel)) return;
      s.values = { ...s.values, [sel]: '' };
    },
    glance: async (f) => void calls.push(`glance ${selOf(f)}`),
    pick: async (c, i) => void calls.push(`pick ${selOf(c)} ${i}`),
    upload: async (b, p) => void calls.push(`upload ${selOf(b)} ${p}`),
    scroll: async (a) => void calls.push(`scroll ${selOf(a)}`),
    read: async () => void calls.push('read'),
    pause: async () => void calls.push('pause'),
    maybe: () => false,
  };
}

interface PageState {
  values?: Record<string, string>;
  checked?: Record<string, boolean>;
  selected?: Record<string, string | null>;
  /** listSelector -> option text -> the option's selector */
  suggestions?: Record<string, Record<string, string>>;
  /** Selectors a click doesn't change. */
  inert?: string[];
  /** Selectors typing doesn't change. */
  deaf?: string[];
  /** Selectors clearing doesn't empty. */
  sticky?: string[];
}

function fakePage(s: PageState): FillPage {
  return {
    locator: loc,
    value: async (sel) => s.values?.[sel] ?? '',
    checked: async (sel) => s.checked?.[sel] ?? false,
    selectedText: async (sel) => s.selected?.[sel] ?? null,
    suggestion: async (list, text) => s.suggestions?.[list]?.[text] ?? null,
  };
}

const resume: Resume = {
  fileName: 'cv.pdf',
  windowsPath: 'C:\\x\\cv.pdf',
};

function field(
  type: ReadField['question']['type'],
  extra: Partial<ReadField> & { options?: string[] } = {},
): ReadField {
  const { options, ...rest } = extra;
  return {
    key: 'k',
    selector: '#f',
    question: {
      label: 'L',
      type,
      required: true,
      ...(options ? { options } : {}),
    },
    ...rest,
  };
}

async function run(
  f: ReadField,
  value: string | string[],
  state: PageState = {},
) {
  const calls: string[] = [];
  const result = await fillField(f, value, {
    pace: fakePace(calls, state),
    page: fakePage(state),
    resume,
  });
  return { calls, result };
}

describe('fillField', () => {
  it('types into an empty text field', async () => {
    const { calls, result } = await run(field('text'), 'Ada');
    expect(calls).toEqual(['type #f Ada']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('types into a number field', async () => {
    const { calls, result } = await run(field('number'), '5');
    expect(calls).toEqual(['type #f 5']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('types a textarea answer with its newline', async () => {
    const { calls } = await run(field('textarea'), 'one\ntwo');
    expect(calls).toEqual(['type #f one\ntwo']);
  });

  it('maps typographic characters before typing', async () => {
    const { calls } = await run(field('text'), 'it\u2019s \u2014 ok\u2026');
    expect(calls).toEqual(["type #f it's - ok..."]);
  });

  it('refuses an untypeable answer before any pace call', async () => {
    const { calls, result } = await run(field('text'), 'caf\u00e9');
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'not-typeable' });
  });

  it('a newline in a text field is not-typeable, before any pace call', async () => {
    for (const type of ['text', 'number', 'typeahead'] as const) {
      const { calls, result } = await run(
        field(type, { suggestions: '#list' }),
        'one\ntwo',
      );
      expect(calls).toEqual([]);
      expect(result).toEqual({ ok: false, reason: 'not-typeable' });
    }
  });

  it('typed text the field did not take is not-taken, and is cleared', async () => {
    const { calls, result } = await run(field('text'), 'Ada', {
      deaf: ['#f'],
    });
    expect(calls).toEqual(['type #f Ada', 'clear #f']);
    expect(result).toEqual({ ok: false, reason: 'not-taken' });
  });

  it('a clear that left text behind is not-taken, and nothing is typed', async () => {
    const { calls, result } = await run(field('text'), 'Ada', {
      values: { '#f': 'old' },
      sticky: ['#f'],
    });
    expect(calls).toEqual(['clear #f']);
    expect(result).toEqual({ ok: false, reason: 'not-taken' });
  });

  it('a typeahead whose typed text did not take is not-taken', async () => {
    const { calls, result } = await run(
      field('typeahead', { suggestions: '#list' }),
      'Lisbon',
      { deaf: ['#f'], suggestions: { '#list': { Lisbon: '#opt' } } },
    );
    expect(calls).toEqual(['type #f Lisbon', 'clear #f']);
    expect(result).toEqual({ ok: false, reason: 'not-taken' });
  });

  it('a typeahead whose clear left text behind is not-taken', async () => {
    const { calls, result } = await run(
      field('typeahead', { suggestions: '#list' }),
      'Lisbon',
      {
        values: { '#f': 'Porto' },
        sticky: ['#f'],
        suggestions: { '#list': { Lisbon: '#opt' } },
      },
    );
    expect(calls).toEqual(['clear #f']);
    expect(result).toEqual({ ok: false, reason: 'not-taken' });
  });

  it('prefilled match glances', async () => {
    const { calls, result } = await run(field('text'), 'it\u2019s', {
      values: { '#f': "it's" },
    });
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('prefilled differs clears and marks changed', async () => {
    const { calls, result } = await run(field('text'), '555 0100', {
      values: { '#f': '555 0199' },
    });
    expect(calls).toEqual(['clear #f', 'type #f 555 0100']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('picks a select option by its index', async () => {
    const f = field('select', { options: ['a@x.io', 'b@x.io'] });
    const { calls, result } = await run(f, 'b@x.io', {
      selected: { '#f': null },
    });
    expect(calls).toEqual(['pick #f 1']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('glances at a select already on the answer', async () => {
    const f = field('select', { options: ['a@x.io', 'b@x.io'] });
    const { calls, result } = await run(f, 'b@x.io', {
      selected: { '#f': 'b@x.io' },
    });
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('marks a select changed when LinkedIn had another option', async () => {
    const f = field('select', { options: ['a@x.io', 'b@x.io'] });
    const { calls, result } = await run(f, 'b@x.io', {
      selected: { '#f': 'a@x.io' },
    });
    expect(calls).toEqual(['pick #f 1']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('does not count a placeholder as LinkedIn’s choice', async () => {
    const f = field('select', { options: ['a@x.io', 'b@x.io'] });
    const { result } = await run(f, 'b@x.io', {
      selected: { '#f': 'Select an option' },
    });
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('select option missing → no-option', async () => {
    const f = field('select', { options: ['a@x.io'] });
    const { calls, result } = await run(f, 'c@x.io');
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('picks a select option by the page’s own index', async () => {
    const f = field('select', { options: ['a', 'b'], pageIndexes: [1, 2] });
    const { calls, result } = await run(f, 'b');
    expect(calls).toEqual(['pick #f 2']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('clicks the answer’s own radio, not by page order', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'No');
    expect(calls).toEqual(['click #r2']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('fails a radio the click did not check', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'No', { inert: ['#r2'] });
    expect(calls).toEqual(['click #r2']);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('glances at a radio already on the answer', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'No', {
      checked: { '#r2': true },
    });
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('marks a radio changed when LinkedIn had another one', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'No', {
      checked: { '#r1': true },
    });
    expect(calls).toEqual(['click #r2']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('radio option missing → no-option', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'Maybe');
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('ticks and unticks a checkbox group to match the answer', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B', 'C'],
      optionSelectors: ['#a', '#b', '#c'],
    });
    const { calls, result } = await run(f, ['A', 'C'], {
      checked: { '#b': true, '#c': true },
    });
    expect(calls).toEqual(['click #a', 'click #b']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('ticks an empty checkbox group without marking it changed', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B'],
      optionSelectors: ['#a', '#b'],
    });
    const { calls, result } = await run(f, 'B');
    expect(calls).toEqual(['click #b']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('glances at a checkbox group already on the answer', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B'],
      optionSelectors: ['#a', '#b'],
    });
    const { calls, result } = await run(f, ['B'], {
      checked: { '#b': true },
    });
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('checkbox-group option missing → no-option', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B'],
      optionSelectors: ['#a', '#b'],
    });
    const { calls, result } = await run(f, ['A', 'Z']);
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('ticks a checkbox for Yes', async () => {
    const { calls, result } = await run(field('checkbox'), 'Yes');
    expect(calls).toEqual(['click #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('ticks a checkbox for true', async () => {
    const { calls } = await run(field('checkbox'), 'true');
    expect(calls).toEqual(['click #f']);
  });

  it('glances at a checkbox already in the answer’s state', async () => {
    const { calls, result } = await run(field('checkbox'), 'No');
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('unticks a checkbox LinkedIn ticked and marks it changed', async () => {
    const { calls, result } = await run(field('checkbox'), 'No', {
      checked: { '#f': true },
    });
    expect(calls).toEqual(['click #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('refuses a checkbox answer that is neither yes nor no', async () => {
    const { calls, result } = await run(field('checkbox'), 'Sometimes');
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('types into a typeahead and clicks the suggestion', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const { calls, result } = await run(f, 'London', {
      suggestions: { '#list': { London: '#opt-london' } },
    });
    expect(calls).toEqual(['type #f London', 'click #opt-london']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('typeahead without suggestion → no-suggestion, field cleared', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const state: PageState = {};
    const first = await run(f, 'London', state);
    expect(first.calls).toEqual(['type #f London', 'clear #f']);
    expect(first.result).toEqual({ ok: false, reason: 'no-suggestion' });
    expect(state.values?.['#f']).toBe('');

    // The list shows up on a later try: the same answer types again.
    state.suggestions = { '#list': { London: '#opt-london' } };
    const second = await run(f, 'London', state);
    expect(second.calls).toEqual(['type #f London', 'click #opt-london']);
    expect(second.result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('never glances at a typeahead holding the answer’s text', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const { calls, result } = await run(f, 'London', {
      values: { '#f': 'London' },
      suggestions: { '#list': { London: '#opt-london' } },
    });
    expect(calls).toEqual(['clear #f', 'type #f London', 'click #opt-london']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('clears a typeahead holding other text and marks it changed', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const { calls, result } = await run(f, 'London', {
      values: { '#f': 'Paris' },
      suggestions: { '#list': { London: '#opt-london' } },
    });
    expect(calls).toEqual(['clear #f', 'type #f London', 'click #opt-london']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('picks a listed resume with the same name', async () => {
    const f = field('file', {
      resumeChoices: [
        { fileName: 'old.pdf', selector: '#old', selected: true },
        { fileName: 'cv.pdf', selector: '#cv', selected: false },
      ],
    });
    const { calls, result } = await run(f, 'cv.pdf');
    expect(calls).toEqual(['click #cv']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('glances at a listed resume already selected', async () => {
    const f = field('file', {
      resumeChoices: [{ fileName: 'cv.pdf', selector: '#cv', selected: true }],
    });
    const { calls, result } = await run(f, 'cv.pdf');
    expect(calls).toEqual(['glance #cv']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('uploads when no listed resume matches', async () => {
    const f = field('file', {
      resumeChoices: [
        { fileName: 'old.pdf', selector: '#old', selected: true },
      ],
    });
    const { calls, result } = await run(f, 'cv.pdf');
    expect(calls).toEqual(['upload #f C:\\x\\cv.pdf']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('uploads when LinkedIn lists no resume', async () => {
    const { calls, result } = await run(field('file'), 'cv.pdf');
    expect(calls).toEqual(['upload #f C:\\x\\cv.pdf']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('refuses to upload without a resume path', async () => {
    const calls: string[] = [];
    const result = await fillField(field('file'), 'cv.pdf', {
      pace: fakePace(calls),
      page: fakePage({}),
      resume: { fileName: 'cv.pdf', windowsPath: '' },
    });
    expect(calls).toEqual([]);
    expect(result).toEqual({ ok: false, reason: 'no-resume' });
  });
});
