import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELD_TYPES } from '@xapply/answerer';
import { parsePage, type Document } from './dom.js';
import { readStep, stepKey } from './form-step.js';
import type { ReadField, StepRead } from './types.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../apply/fixtures');
// Rows of the README table: | file | kind | source | scrubbed |
const rows = readFileSync(join(dir, 'README.md'), 'utf8')
  .split('\n')
  .filter((l) => /^\|\s*\S+\.html\s*\|/.test(l))
  .map((l) => l.split('|').map((c) => c.trim()))
  .map(([, file, kind]) => ({ file: file ?? '', kind: kind ?? '' }));
const load = (file: string) => parsePage(readFileSync(join(dir, file), 'utf8'));
const byKind = (kind: string) => rows.filter((r) => r.kind === kind);

/** Every selector a read hands out, so each can be checked against the page. */
function selectorsOf(r: StepRead): string[] {
  if (r.kind === 'none') return [];
  const out: string[] = [];
  for (const f of r.fields) {
    out.push(f.selector, ...(f.optionSelectors ?? []));
    out.push(...(f.resumeChoices ?? []).map((c) => c.selector));
  }
  if (r.kind === 'step' && r.next) out.push(r.next.selector);
  return out;
}
const textOf = (doc: Document, sel: string): string => {
  const el = doc.querySelector(sel) as {
    textContent: string | null;
    getAttribute(n: string): string | null;
  } | null;
  return `${el?.textContent ?? ''} ${el?.getAttribute('aria-label') ?? ''}`;
};
const step = (r: StepRead) => {
  if (r.kind !== 'step') throw new Error(`expected a step, got ${r.kind}`);
  return r;
};
const fieldsOf = (r: StepRead): ReadField[] =>
  r.kind === 'none' ? [] : r.fields;

describe('fixtures', () => {
  it('lists every fixture file', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    expect(files.sort()).toEqual(rows.map((r) => r.file).sort());
  });

  it.each(byKind('job'))('$file has no form', ({ file }) => {
    expect(readStep(load(file))).toEqual({ kind: 'none' });
  });

  it.each(byKind('step'))(
    '$file reads as a step with fields and a next',
    ({ file }) => {
      const r = step(readStep(load(file)));
      expect(r.fields.length).toBeGreaterThan(0);
      expect(r.unknown).toEqual([]);
      expect(r.next).not.toBeNull();
      for (const f of r.fields) {
        expect(FIELD_TYPES).toContain(f.question.type);
        expect(f.question.label).not.toBe('');
        expect(f.question.label).not.toMatch(/\*$/);
      }
    },
  );

  it.each(byKind('review'))('$file reads as review', ({ file }) => {
    const r = readStep(load(file));
    expect(r.kind).toBe('review');
    if (r.kind === 'review') expect(r.unknown).toEqual([]);
  });

  it.each(rows)('$file: next is never a Submit button', ({ file }) => {
    const doc = load(file);
    const r = readStep(doc);
    if (r.kind !== 'step' || !r.next) return;
    expect(textOf(doc, r.next.selector)).not.toMatch(/submit/i);
  });

  it.each(rows)(
    '$file: every selector matches exactly one element',
    ({ file }) => {
      const doc = load(file);
      for (const sel of selectorsOf(readStep(doc))) {
        expect([sel, doc.querySelectorAll(sel).length]).toEqual([sel, 1]);
      }
    },
  );

  it.each(rows)('$file: field keys are unique and stable', ({ file }) => {
    const a = readStep(load(file));
    const keys = fieldsOf(a).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(stepKey(readStep(load(file)))).toBe(stepKey(a));
  });
});

describe('readStep on the fixtures', () => {
  it('reads the contact step (names, phone, email)', () => {
    const r = step(readStep(load('step-contact.html')));
    expect(r.title).toBe('Apply to Jobgether');
    expect(r.progress).toBeNull();
    expect(r.errors).toEqual([]);
    expect(
      r.fields.map((f) => [
        f.question.type,
        f.question.label,
        f.question.required,
      ]),
    ).toEqual([
      ['text', 'First name', true],
      ['text', 'Last name', true],
      ['select', 'Phone country code', false],
      ['text', 'Mobile phone number', false],
      ['select', 'Email address', true],
    ]);
    const [first, , country] = r.fields;
    expect(first?.key).toBe(
      'easyApplyFieldFocus_ea.q::38394671922::FIRST_NAME::firstName.validation',
    );
    expect(first?.selector).toBe('#_r_1k_');
    // The live counter ("7 of 100 characters") is not help text.
    expect(first?.question.helpText).toBeUndefined();
    // ...but its total is the field's limit.
    expect(first?.question.maxLength).toBe(100);
    expect(r.fields[1]?.question.maxLength).toBe(50);
    expect(country?.key).toBe('_r_1m_');
    expect(country?.question.options?.[0]).toBe('Andorra (+376)');
    expect(country?.pageIndexes?.[0]).toBe(1);
    expect(country?.pageIndexes?.length).toBe(
      country?.question.options?.length,
    );
    expect(r.next?.label).toBe('next');
  });

  it('reads the question step: select, radios and text', () => {
    const r = step(readStep(load('step-questions.html')));
    expect(r.fields.map((f) => f.question.type)).toEqual([
      'select',
      'radio',
      'radio',
      'text',
      'text',
      'text',
      'text',
    ]);
    const [english, spain] = r.fields;
    expect(english?.question.label).toBe(
      'What is your level of proficiency in English?',
    );
    expect(english?.question.required).toBe(true);
    expect(english?.question.options).toEqual([
      'None',
      'Conversational',
      'Professional',
      'Native or bilingual',
    ]);
    expect(english?.pageIndexes).toEqual([1, 2, 3, 4]);
    expect(spain?.question.label).toBe(
      'Are you legally authorized to work in Spain?',
    );
    expect(spain?.question.options).toEqual(['Yes', 'No']);
    expect(spain?.optionSelectors).toEqual(['#_r_4c_', '#_r_4e_']);
    // LinkedIn's radio questions carry no marker; they are always required.
    expect(spain?.question.required).toBe(true);
    expect(r.fields[2]?.question.required).toBe(true);
    expect(spain?.key).toBe(
      'easyApplyFieldFocus_ea_validation_p2_0_32633232164',
    );
    expect(r.next?.label).toBe('review');
  });

  it('reads the location question as plain text (no listbox)', () => {
    const r = step(readStep(load('step-questions-location.html')));
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0]?.question).toEqual({
      label: 'What is your current location?',
      type: 'text',
      required: false,
    });
    expect(r.fields[0]?.selector).toBe('#_r_48_');
  });

  it('reads the resume step as one file field', () => {
    const doc = load('step-resume.html');
    const r = step(readStep(doc));
    expect(r.fields).toHaveLength(1);
    const [resume] = r.fields;
    expect(resume?.question.type).toBe('file');
    expect(resume?.question.required).toBe(true);
    expect(resume?.resumeChoices).toHaveLength(19);
    expect(resume?.resumeChoices?.[3]).toEqual({
      fileName: 'resume.2026.fs.pdf',
      selector: '#_r_25_',
      selected: false,
    });
    // pace.upload clicks the button that opens the file chooser.
    expect(textOf(doc, resume?.selector ?? '')).toMatch(/upload resume/i);
    expect(r.next?.label).toBe('next');
  });

  it('reads the one-page form: review with its contact and resume fields', () => {
    const r = readStep(load('review-one-page.html'));
    expect(r.kind).toBe('review');
    expect(fieldsOf(r).map((f) => [f.question.type, f.question.label])).toEqual(
      [
        ['select', 'Email'],
        ['select', 'Phone country code'],
        ['text', 'Phone'],
        ['file', 'Resume'],
      ],
    );
  });

  it.each(['review.html', 'review-save-prompt.html'])(
    '%s has no fields (the Follow checkbox is not a question)',
    (file) => {
      expect(readStep(load(file))).toEqual({
        kind: 'review',
        fields: [],
        unknown: [],
      });
    },
  );
});

const form = (
  inner: string,
  footer = '<button><span><span>Next</span></span></button>',
) =>
  parsePage(
    `<body><input id="search" role="combobox" aria-label="Search"><dialog><button aria-label="Dismiss"></button><header id="dialog-header"><h2>Apply to Acme</h2></header><div data-testid="dialog-content">${inner}</div><footer>${footer}</footer></dialog></body>`,
  );
const only = (inner: string) => {
  const r = step(readStep(form(inner)));
  expect(r.unknown).toEqual([]);
  expect(r.fields).toHaveLength(1);
  return r.fields[0] as ReadField;
};

describe('readStep type mapping', () => {
  it.each(['text', 'email', 'tel', 'url'])('input[type=%s] is text', (t) => {
    const f = only(
      `<label for="a"><div>Field</div></label><input id="a" type="${t}">`,
    );
    expect(f.question).toEqual({
      label: 'Field',
      type: 'text',
      required: false,
    });
    expect(f.selector).toBe('#a');
  });

  it('a combobox input with a listbox is typeahead', () => {
    const f = only(
      '<input id="c" type="text" role="combobox" aria-autocomplete="list" aria-controls="lb" aria-label="City"><div role="listbox" id="lb"></div>',
    );
    expect(f.question.type).toBe('typeahead');
    expect(f.suggestions).toBe('#lb');
  });

  it.each([
    '<input id="n" type="number" aria-label="Years">',
    '<input id="n" type="text" inputmode="numeric" aria-label="Years">',
  ])('%s is number', (html) => {
    expect(only(html).question.type).toBe('number');
  });

  it('textarea is textarea, with maxlength', () => {
    const f = only(
      '<label for="t">Cover</label><textarea id="t" maxlength="500"></textarea>',
    );
    expect(f.question).toEqual({
      label: 'Cover',
      type: 'textarea',
      required: false,
      maxLength: 500,
    });
  });

  it('select is select, without the placeholder', () => {
    const f = only(
      '<label for="s">Pick</label><select id="s"><option value="">Select an option</option><option value="a">A</option><option value="b">B</option></select>',
    );
    expect(f.question.options).toEqual(['A', 'B']);
    expect(f.pageIndexes).toEqual([1, 2]);
  });

  it('a fieldset of radios is radio, aimed at the fieldset', () => {
    const f = only(
      '<fieldset role="radiogroup" aria-describedby="error-message-g"><div><div><input id="y" type="radio" name="g" aria-label="Relocate?"><label for="y"></label></div><div><p>Yes</p></div></div><div><div><input id="n" type="radio" name="g" aria-label="Relocate?"><label for="n"></label></div><div><p>No</p></div></div></fieldset>',
    );
    expect(f.question).toEqual({
      label: 'Relocate?',
      type: 'radio',
      required: true,
      options: ['Yes', 'No'],
    });
    expect(f.optionSelectors).toEqual(['#y', '#n']);
    // No easyApplyFieldFocus_ wrapper: the fieldset holds the radios pace.pick looks for.
    expect(f.selector).toBe('fieldset[aria-describedby="error-message-g"]');
  });

  it('splits one fieldset holding two radio names into two fields', () => {
    const opt = (id: string, name: string, q: string, text: string) =>
      `<div><div><input id="${id}" type="radio" name="${name}" aria-label="${q}"><label for="${id}"></label></div><div><p>${text}</p></div></div>`;
    const r = step(
      readStep(
        form(
          `<fieldset id="fs"><div id="g1">${opt('a1', 'g1', 'Relocate?', 'Yes')}${opt('a2', 'g1', 'Relocate?', 'No')}</div><div id="g2">${opt('b1', 'g2', 'Remote?', 'Never')}${opt('b2', 'g2', 'Remote?', 'Sometimes')}${opt('b3', 'g2', 'Remote?', 'Always')}</div></fieldset>`,
        ),
      ),
    );
    expect(r.unknown).toEqual([]);
    expect(
      r.fields.map((f) => [
        f.question.label,
        f.question.options,
        f.optionSelectors,
        f.selector,
      ]),
    ).toEqual([
      ['Relocate?', ['Yes', 'No'], ['#a1', '#a2'], '#g1'],
      [
        'Remote?',
        ['Never', 'Sometimes', 'Always'],
        ['#b1', '#b2', '#b3'],
        '#g2',
      ],
    ]);
  });

  it('sends radio names in one fieldset it cannot tell apart to unknown', () => {
    const r = step(
      readStep(
        form(
          '<fieldset id="fs"><legend>Pick</legend><div id="g1"><input id="a1" type="radio" name="g1"><label for="a1">Yes</label><input id="a2" type="radio" name="g1"><label for="a2">No</label></div><div id="g2"><input id="b1" type="radio" name="g2"><label for="b1">Yes</label><input id="b2" type="radio" name="g2"><label for="b2">No</label></div></fieldset>',
        ),
      ),
    );
    expect(r.fields).toEqual([]);
    expect(r.unknown).toHaveLength(2);
  });

  it('sends a radio group with no option text to unknown', () => {
    const r = step(
      readStep(
        form(
          '<fieldset id="fs" role="radiogroup"><input id="y" type="radio" name="g" aria-label="Relocate?"><input id="n" type="radio" name="g" aria-label="Relocate?"></fieldset>',
        ),
      ),
    );
    expect(r.fields).toEqual([]);
    expect(r.unknown).toEqual([
      { tag: 'input', role: null, inputType: 'radio' },
    ]);
  });

  it('a fieldset of several checkboxes is checkbox-group', () => {
    const f = only(
      '<fieldset id="fs"><legend>Stacks*</legend><input id="a" type="checkbox"><label for="a">Node</label><input id="b" type="checkbox"><label for="b">Go</label></fieldset>',
    );
    expect(f.question).toEqual({
      label: 'Stacks',
      type: 'checkbox-group',
      required: true,
      options: ['Node', 'Go'],
    });
    expect(f.optionSelectors).toEqual(['#a', '#b']);
    expect(f.selector).toBe('#fs');
  });

  it('one checkbox is checkbox', () => {
    const f = only(
      '<input id="t" type="checkbox"><label for="t">I agree</label>',
    );
    expect(f.question).toEqual({
      label: 'I agree',
      type: 'checkbox',
      required: false,
    });
  });

  it('input[type=file] is file', () => {
    const f = only('<input id="f" type="file" aria-label="Cover letter">');
    expect(f.question.type).toBe('file');
    expect(f.selector).toBe('#f');
  });

  it('a resume fieldset is file, aimed at its upload button', () => {
    const r = step(
      readStep(
        form(
          '<fieldset role="radiogroup"><input id="r1" type="radio" name="g" aria-label="cv.PDF"><input id="r2" type="radio" name="g" aria-label="cv.docx"></fieldset><button componentkey="up-1"><span><span>Upload resume</span></span></button><input id="file" type="file">',
        ),
      ),
    );
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0]?.selector).toBe('button[componentkey="up-1"]');
    expect(r.fields[0]?.resumeChoices?.map((c) => c.fileName)).toEqual([
      'cv.PDF',
      'cv.docx',
    ]);
    expect(r.fields[0]?.question.required).toBe(true);
  });

  it('keeps a cover letter upload beside the resume as its own field', () => {
    const r = step(
      readStep(
        form(
          '<section><fieldset role="radiogroup"><input id="r1" type="radio" name="g" aria-label="cv.pdf"></fieldset><button componentkey="up-1">Upload resume</button><input id="rf" type="file"></section><section><button componentkey="up-2">Upload cover letter</button><input id="cl" type="file" aria-label="Cover letter"></section>',
        ),
      ),
    );
    expect(r.unknown).toEqual([]);
    expect(
      r.fields.map((f) => [f.question.type, f.question.label, f.selector]),
    ).toEqual([
      ['file', 'Resume', 'button[componentkey="up-1"]'],
      ['file', 'Cover letter', '#cl'],
    ]);
  });

  it('never aims a resume field at the cover letter upload button', () => {
    const r = step(
      readStep(
        form(
          '<section><fieldset role="radiogroup"><input id="r1" type="radio" name="g" aria-label="cv.pdf"></fieldset></section><section><button componentkey="up-2">Upload cover letter</button><input id="cl" type="file" aria-label="Cover letter"></section>',
        ),
      ),
    );
    const resume =
      r.kind === 'step'
        ? r.fields.find((f) => f.question.label === 'Resume')
        : undefined;
    expect(resume?.selector).not.toBe('button[componentkey="up-2"]');
    expect(
      r.kind === 'step' && r.fields.some((f) => f.selector === '#cl'),
    ).toBe(true);
  });

  it('sends a control whose only selector is ambiguous to unknown', () => {
    const r = step(
      readStep(
        form(
          '<input type="text" aria-label="Twin"><input type="text" aria-label="Twin"><input type="radio" name="g" aria-label="Q"><input type="radio" name="g" aria-label="Q">',
        ),
      ),
    );
    expect(r.fields).toEqual([]);
    expect(r.unknown.map((u) => u.inputType)).toEqual([
      'text',
      'text',
      'radio',
    ]);
  });

  it('an input[type=range] is unknown', () => {
    const r = step(
      readStep(form('<input id="r" type="range" aria-label="Level">')),
    );
    expect(r.fields).toEqual([]);
    expect(r.unknown).toEqual([
      { tag: 'input', role: null, inputType: 'range' },
    ]);
  });

  it('leaves out hidden inputs, the Follow checkbox and page chrome', () => {
    const r = step(
      readStep(
        form(
          '<input type="hidden" name="x"><div hidden><input id="h" type="text"></div><input id="f" type="checkbox" aria-label="Follow Acme to stay up to date with their page">',
        ),
      ),
    );
    expect(r.fields).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});

describe('readStep labels', () => {
  it('reads required from a trailing *, the attribute or aria-required', () => {
    const r = step(
      readStep(
        form(
          '<label for="a">A *</label><input id="a"><input id="b" aria-label="B" required><input id="c" aria-label="C" aria-required="true">',
        ),
      ),
    );
    expect(
      r.fields.map((f) => [f.question.label, f.question.required]),
    ).toEqual([
      ['A', true],
      ['B', true],
      ['C', true],
    ]);
  });

  it('reads help text from aria-describedby, without the counter', () => {
    const f = only(
      '<input id="a" aria-label="Site" aria-describedby="a-info"><div id="a-info"><p>Your portfolio link</p><p aria-live="polite"><span aria-hidden="true">0/100</span><span>0 of 100 characters</span></p></div>',
    );
    expect(f.question.helpText).toBe('Your portfolio link');
    // No maxlength attribute: the counter's total is the limit.
    expect(f.question.maxLength).toBe(100);
  });

  it('prefers the maxlength attribute over the counter', () => {
    const f = only(
      '<input id="a" aria-label="Site" maxlength="40" aria-describedby="a-info"><div id="a-info"><span>0 of 100 characters</span></div>',
    );
    expect(f.question.maxLength).toBe(40);
  });
});

describe('readStep buttons and states', () => {
  it('is none without the Easy Apply dialog', () => {
    expect(readStep(parsePage('<body><input id="a"></body>'))).toEqual({
      kind: 'none',
    });
  });

  it('is review when any dialog button says submit, even beside Next', () => {
    const r = readStep(
      form(
        '<input id="a" aria-label="A">',
        '<button><span><span>Next</span></span></button><button aria-label="Submit application"><span><span>Send</span></span></button>',
      ),
    );
    expect(r.kind).toBe('review');
  });

  it('reads Review as next with label review', () => {
    const r = step(
      readStep(
        form(
          '<input id="a" aria-label="A">',
          '<button componentkey="b"><span><span>Back</span></span></button><button componentkey="r"><span><span>Review</span></span></button>',
        ),
      ),
    );
    expect(r.next).toEqual({
      selector: 'button[componentkey="r"]',
      label: 'review',
    });
  });

  it('has a null next with only Back', () => {
    const r = step(
      readStep(form('<input id="a" aria-label="A">', '<button>Back</button>')),
    );
    expect(r.next).toBeNull();
  });

  it('reads error texts', () => {
    const r = step(
      readStep(
        form(
          '<input id="a" aria-label="A" aria-describedby="error-message-a"><div id="error-message-a" role="alert">Enter a valid answer</div>',
        ),
      ),
    );
    expect(r.errors).toEqual(['Enter a valid answer']);
    expect(r.fields[0]?.question.helpText).toBeUndefined();
  });
});

describe('stepKey', () => {
  it('changes when a field is added', () => {
    const one = readStep(form('<input id="a" aria-label="A">'));
    const two = readStep(
      form('<input id="a" aria-label="A"><input id="b" aria-label="B">'),
    );
    expect(stepKey(two)).not.toBe(stepKey(one));
  });

  it('ignores field order', () => {
    const ab = readStep(
      form('<input id="a" aria-label="A"><input id="b" aria-label="B">'),
    );
    const ba = readStep(
      form('<input id="b" aria-label="B"><input id="a" aria-label="A">'),
    );
    expect(stepKey(ab)).toBe(stepKey(ba));
  });
});
