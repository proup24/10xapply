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
function fakePace(
  calls: string[],
  s: PageState = {},
  withins: (string | null)[] = [],
): Pace {
  /** The `within` each targeted action got, by selector, or null. */
  const w = (o?: { within?: Locator }) =>
    void withins.push(o?.within ? selOf(o.within) : null);
  return {
    mood: 1,
    defaulted: [],
    click: async (t, o) => {
      w(o);
      const sel = selOf(t);
      calls.push(`click ${sel}`);
      if (s.inert?.includes(sel)) return;
      // A label[for] press checks its input.
      const box = s.pressFor?.[sel] ?? sel;
      s.checked = { ...s.checked, [box]: !(s.checked?.[box] ?? false) };
    },
    type: async (f, text, o) => {
      w(o);
      const sel = selOf(f);
      calls.push(`type ${sel} ${text}`);
      if (s.deaf?.includes(sel)) return;
      s.values = { ...s.values, [sel]: (s.values?.[sel] ?? '') + text };
    },
    clear: async (f, o) => {
      w(o);
      const sel = selOf(f);
      calls.push(`clear ${sel}`);
      if (s.sticky?.includes(sel)) return;
      s.values = { ...s.values, [sel]: '' };
    },
    glance: async (f, o) => {
      w(o);
      calls.push(`glance ${selOf(f)}`);
    },
    pick: async (c, i, o) => {
      w(o);
      calls.push(`pick ${selOf(c)} ${i}`);
    },
    upload: async (b, p, o) => {
      w(o);
      calls.push(`upload ${selOf(b)} ${p}`);
    },
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
  /** A press target (a label) -> the input whose state it changes. */
  pressFor?: Record<string, string>;
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

  it('a phone prefilled in another layout is only glanced at', async () => {
    const { calls, result } = await run(field('text'), '7700 900123', {
      values: { '#f': '7700900123' },
    });
    expect(calls).toEqual(['glance #f']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('a short number that differs only by punctuation is not the same', async () => {
    const a = await run(field('number'), '1.5', { values: { '#f': '15' } });
    expect(a.calls).toEqual(['clear #f', 'type #f 1.5']);
    expect(a.result).toEqual({ ok: true, changedFromLinkedIn: true });
    const b = await run(field('text'), '3-5', { values: { '#f': '35' } });
    expect(b.calls).toEqual(['clear #f', 'type #f 3-5']);
    const state: PageState = { values: {} };
    const calls: string[] = [];
    const pace = fakePace(calls, state);
    const dropDot: Pace = {
      ...pace,
      type: async (f) => {
        calls.push(`type ${selOf(f)}`);
        state.values = { ...state.values, '#f': '15' };
      },
    };
    const c = await fillField(field('text'), '1.5', {
      pace: dropDot,
      page: fakePage(state),
      resume,
    });
    expect(c).toEqual({ ok: false, reason: 'not-taken' });
  });

  it('a phone the field reformats after typing is taken', async () => {
    const state: PageState = { values: {} };
    const calls: string[] = [];
    const pace = fakePace(calls, state);
    const page = fakePage(state);
    const reformat: Pace = {
      ...pace,
      type: async (f, text) => {
        await pace.type(f, text);
        state.values = { ...state.values, '#f': '7700 900 123' };
      },
    };
    const result = await fillField(field('text'), '7700900123', {
      pace: reformat,
      page,
      resume,
    });
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('a phone that lost its plus or a digit is not the same', async () => {
    const a = await run(field('text'), '+44 7700900123', {
      values: { '#f': '447700900123' },
    });
    expect(a.calls[0]).toBe('clear #f');
    expect(a.result).toEqual({ ok: true, changedFromLinkedIn: true });
    const b = await run(field('text'), '7700 900123', {
      values: { '#f': '770090012' },
    });
    expect(b.calls[0]).toBe('clear #f');
    const c = await run(field('text'), '+447700900123', {
      deaf: ['#f'],
      values: { '#f': '' },
    });
    expect(c.result).toEqual({ ok: false, reason: 'not-taken' });
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
    // No label to press: the radio itself.
    expect(calls).toEqual(['glance #r2']);
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

  it('presses the radio label and reads checked state from the input', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
      optionPressSelectors: ['label[for="r1"]', 'label[for="r2"]'],
    });
    const { calls, result } = await run(f, 'No', {
      checked: { '#r1': true },
      pressFor: { 'label[for="r1"]': '#r1', 'label[for="r2"]': '#r2' },
    });
    expect(calls).toEqual(['click label[for="r2"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('a radio label press that does not check the input → no-option', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
      optionPressSelectors: ['label[for="r1"]', 'label[for="r2"]'],
    });
    const { calls, result } = await run(f, 'No');
    expect(calls).toEqual(['click label[for="r2"]']);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it("glances at the checked radio's label", async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
      optionPressSelectors: ['label[for="r1"]', 'label[for="r2"]'],
    });
    const { calls, result } = await run(f, 'No', {
      checked: { '#r2': true },
    });
    expect(calls).toEqual(['glance label[for="r2"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
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

  it('presses a checkbox on its label and verifies through the input', async () => {
    const f = field('checkbox', { pressSelector: 'label[for="f"]' });
    const { calls, result } = await run(f, 'Yes', {
      pressFor: { 'label[for="f"]': '#f' },
    });
    expect(calls).toEqual(['click label[for="f"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('a checkbox label press that does not change the input → no-option', async () => {
    const f = field('checkbox', { pressSelector: 'label[for="f"]' });
    const { calls, result } = await run(f, 'Yes');
    expect(calls).toEqual(['click label[for="f"]']);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it("glances at a checkbox's label when it is already right", async () => {
    const f = field('checkbox', { pressSelector: 'label[for="f"]' });
    const { calls } = await run(f, 'Yes', { checked: { '#f': true } });
    expect(calls).toEqual(['glance label[for="f"]']);
  });

  it('presses checkbox-group labels and verifies each through its input', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B'],
      optionSelectors: ['#a', '#b'],
      optionPressSelectors: ['label[for="a"]', 'label[for="b"]'],
    });
    const { calls, result } = await run(f, ['B'], {
      pressFor: { 'label[for="a"]': '#a', 'label[for="b"]': '#b' },
    });
    expect(calls).toEqual(['click label[for="b"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('a checkbox-group label press that does not take → no-option', async () => {
    const f = field('checkbox-group', {
      options: ['A', 'B'],
      optionSelectors: ['#a', '#b'],
      optionPressSelectors: ['label[for="a"]', 'label[for="b"]'],
    });
    const { calls, result } = await run(f, ['B']);
    expect(calls).toEqual(['click label[for="b"]']);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
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

  /** A resume choice: input `#<id>`, pressed on `label[for="<id>"]`. */
  const choice = (fileName: string, id: string) => ({
    fileName,
    selector: `#${id}`,
    pressSelector: `label[for="${id}"]`,
  });
  const presses = (...ids: string[]): Record<string, string> =>
    Object.fromEntries(ids.map((id) => [`label[for="${id}"]`, `#${id}`]));

  it('a different resume checked live: presses the same-name label, verifies, changed', async () => {
    const f = field('file', {
      resumeChoices: [choice('old.pdf', 'old'), choice('cv.pdf', 'cv')],
    });
    const { calls, result } = await run(f, 'cv.pdf', {
      checked: { '#old': true },
      pressFor: presses('old', 'cv'),
    });
    expect(calls).toEqual(['click label[for="cv"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('glances at the same-name resume checked live', async () => {
    const f = field('file', { resumeChoices: [choice('cv.pdf', 'cv')] });
    const { calls, result } = await run(f, 'cv.pdf', {
      checked: { '#cv': true },
    });
    expect(calls).toEqual(['glance label[for="cv"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('with duplicate names, glances at the second when it is the checked one', async () => {
    const f = field('file', {
      resumeChoices: [choice('cv.pdf', 'cv1'), choice('cv.pdf', 'cv2')],
    });
    const { calls, result } = await run(f, 'cv.pdf', {
      checked: { '#cv2': true },
      pressFor: presses('cv1', 'cv2'),
    });
    expect(calls).toEqual(['glance label[for="cv2"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('with duplicate names and none checked, presses the first and verifies it', async () => {
    const f = field('file', {
      resumeChoices: [choice('cv.pdf', 'cv1'), choice('cv.pdf', 'cv2')],
    });
    const { calls, result } = await run(f, 'cv.pdf', {
      pressFor: presses('cv1', 'cv2'),
    });
    expect(calls).toEqual(['click label[for="cv1"]']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
  });

  it('a resume press that does not check its input → no-option', async () => {
    const f = field('file', { resumeChoices: [choice('cv.pdf', 'cv')] });
    // No pressFor: the label press leaves the input unchecked.
    const { calls, result } = await run(f, 'cv.pdf');
    expect(calls).toEqual(['click label[for="cv"]']);
    expect(result).toEqual({ ok: false, reason: 'no-option' });
  });

  it('uploads when no listed resume matches, changed when another was checked live', async () => {
    const f = field('file', { resumeChoices: [choice('old.pdf', 'old')] });
    const { calls, result } = await run(f, 'cv.pdf', {
      checked: { '#old': true },
    });
    expect(calls).toEqual(['upload #f C:\\x\\cv.pdf']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: true });
  });

  it('uploads unchanged when the listed resume is not checked live', async () => {
    const f = field('file', { resumeChoices: [choice('old.pdf', 'old')] });
    const { calls, result } = await run(f, 'cv.pdf');
    expect(calls).toEqual(['upload #f C:\\x\\cv.pdf']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
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

  describe('within', () => {
    const cases: [string, ReadField, string | string[], PageState][] = [
      ['types', field('text'), 'Ada', {}],
      ['clears and types', field('text'), 'Ada', { values: { '#f': 'Bob' } }],
      ['glances', field('text'), 'Ada', { values: { '#f': 'Ada' } }],
      ['picks', field('select', { options: ['A', 'B'] }), 'B', {}],
      [
        'clicks a radio',
        field('radio', { options: ['A', 'B'], optionSelectors: ['#a', '#b'] }),
        'B',
        { checked: { '#b': false } },
      ],
      [
        'clicks group boxes',
        field('checkbox-group', {
          options: ['A', 'B'],
          optionSelectors: ['#a', '#b'],
        }),
        ['A', 'B'],
        {},
      ],
      ['ticks a checkbox', field('checkbox'), 'Yes', {}],
      [
        'types and clicks a suggestion',
        field('typeahead', { suggestions: '#list' }),
        'Paris',
        { suggestions: { '#list': { Paris: '#opt' } } },
      ],
      [
        'clears a typeahead with no suggestion',
        field('typeahead', { suggestions: '#list' }),
        'Paris',
        {},
      ],
      [
        'clicks a listed resume',
        field('file', {
          resumeChoices: [
            { fileName: 'cv.pdf', selector: '#cv', pressSelector: '#cv' },
          ],
        }),
        'cv.pdf',
        {},
      ],
      ['uploads', field('file'), 'cv.pdf', {}],
    ];

    for (const [name, f, value, state] of cases) {
      it(`passes the form box to every pace action when it ${name}`, async () => {
        const calls: string[] = [];
        const withins: (string | null)[] = [];
        const st = structuredClone(state);
        await fillField(f, value, {
          pace: fakePace(calls, st, withins),
          page: fakePage(st),
          resume,
          within: '#dlg',
        });
        expect(withins.length).toBeGreaterThan(0);
        expect(withins).toHaveLength(calls.length);
        expect(withins.every((w) => w === '#dlg')).toBe(true);
      });
    }

    it('passes no box when the ctx has none', async () => {
      const calls: string[] = [];
      const withins: (string | null)[] = [];
      const st: PageState = {};
      await fillField(field('text'), 'Ada', {
        pace: fakePace(calls, st, withins),
        page: fakePage(st),
        resume,
      });
      expect(withins).toEqual([null]);
    });
  });
});
