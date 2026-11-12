import { describe, expect, it } from 'vitest';
import type { Locator } from 'patchright-core';
import type { Pace } from '../pace/pace.js';
import type { ReadField } from '../linkedin/types.js';
import { fillField, type FillPage, type Resume } from './fill.js';

/** A stand-in locator that only remembers its selector. */
const loc = (sel: string) => ({ sel }) as unknown as Locator;
const selOf = (l: Locator) => (l as unknown as { sel: string }).sel;

function fakePace(calls: string[]): Pace {
  return {
    mood: 1,
    defaulted: [],
    click: async (t) => void calls.push(`click ${selOf(t)}`),
    type: async (f, text) => void calls.push(`type ${selOf(f)} ${text}`),
    clear: async (f) => void calls.push(`clear ${selOf(f)}`),
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
    pace: fakePace(calls),
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

  it('picks a radio by its index', async () => {
    const f = field('radio', {
      options: ['Yes', 'No'],
      optionSelectors: ['#r1', '#r2'],
    });
    const { calls, result } = await run(f, 'No');
    expect(calls).toEqual(['pick #f 1']);
    expect(result).toEqual({ ok: true, changedFromLinkedIn: false });
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
    expect(calls).toEqual(['pick #f 1']);
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

  it('typeahead without suggestion → no-suggestion', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const { calls, result } = await run(f, 'London');
    expect(calls).toEqual(['type #f London']);
    expect(result).toEqual({ ok: false, reason: 'no-suggestion' });
  });

  it('glances at a typeahead already on the answer', async () => {
    const f = field('typeahead', { suggestions: '#list' });
    const { calls } = await run(f, 'London', {
      values: { '#f': 'London' },
    });
    expect(calls).toEqual(['glance #f']);
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
