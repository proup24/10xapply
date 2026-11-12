import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Locator } from 'patchright-core';
import type { AnswerResult, AnswerValue, FormQuestion } from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import { parsePage, type Document } from '../linkedin/dom.js';
import { readStep } from '../linkedin/form-step.js';
import { DISMISS, EASY_APPLY } from '../linkedin/selectors.js';
import type { Pace } from '../pace/pace.js';
import type { TerminalIO } from '../terminal/author-mode.js';
import { runApply } from './run.js';
import type { ApplyDeps, ApplyPage, ApplyRun } from './types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

const JOB = fixture('job-page.html');
const CONTACT = fixture('step-contact-email-phone.html');
const CONTACT_NAMES = fixture('step-contact.html');
const RESUME = fixture('step-resume.html');
const QUESTIONS = fixture('step-questions.html');
const QUESTIONS_2 = fixture('step-questions-2.html');
const LOCATION = fixture('step-questions-location.html');
const REVIEW = fixture('review.html');
const ONE_PAGE = fixture('review-one-page.html');
const SAVE_PROMPT = fixture('review-save-prompt.html');
/** The save prompt's Discard button (review-save-prompt.html). */
const DISCARD = 'button[componentkey="0b8ffbda-ce8d-4452-bf6a-5d96b318ac9e"]';
const JOB_PATH = '/jobs/view/123/';

// ---------------------------------------------------------------- fake page

const docs = new Map<string, Document>();
const docOf = (html: string) => {
  let d = docs.get(html);
  if (!d) {
    d = parsePage(html);
    docs.set(html, d);
  }
  return d;
};

/** The step's Next or Review selector, read from the fixture itself. */
function nextOf(html: string): string {
  const r = readStep(docOf(html));
  if (r.kind !== 'step' || !r.next) throw new Error('no next in fixture');
  return r.next.selector;
}

interface Screen {
  html: string;
  path?: string;
  /** A pace action on this selector moves to the named screen. */
  on?: Record<string, string>;
}

interface Call {
  op: string;
  sel: string;
  arg?: string | number;
}

/** Every acted-on selector whose element reads as Submit, across all tests. */
const submitHits: string[] = [];
let actionsChecked = 0;

const SUBMIT = /submit/i;
function checkNotSubmit(html: string, sel: string) {
  actionsChecked++;
  for (const el of docOf(html).querySelectorAll(sel)) {
    const text = el.textContent ?? '';
    const label = el.getAttribute('aria-label') ?? '';
    if (SUBMIT.test(text) || SUBMIT.test(label)) submitHits.push(sel);
  }
}

const loc = (sel: string) => ({ sel }) as unknown as Locator;
const selOf = (l: Locator) => (l as unknown as { sel: string }).sel;

interface Harness {
  deps: ApplyDeps;
  calls: Call[];
  /** pace calls only, as `op sel [arg]` strings. */
  acts: () => string[];
  closed: () => boolean;
  asked: string[];
  printed: string[];
  saved: { question: string; answer: string }[];
  loads: () => number;
  answered: FormQuestion[];
}

interface Setup {
  screens: Record<string, Screen>;
  /** The screen goto lands on. */
  start?: string;
  values?: Record<string, string>;
  checked?: Record<string, boolean>;
  answers?: Record<string, Reply | ((bank: FactBank) => Reply)>;
  /** Replies the author types, in order; omit for no author. */
  author?: string[];
  stopWhen?: (calls: Call[]) => string | null;
  saveId?: string;
  openFails?: boolean;
}

type Reply = AnswerValue | { blocked: true };
const BLOCKED: Reply = { blocked: true };

function defaultAnswer(q: FormQuestion): AnswerValue {
  switch (q.type) {
    case 'select':
    case 'radio':
      return q.options?.[0] ?? '';
    case 'checkbox':
      return 'Yes';
    case 'checkbox-group':
      return [q.options?.[0] ?? ''];
    case 'file':
      return 'resume';
    default:
      return 'ok';
  }
}

function result(q: FormQuestion, r: Reply): AnswerResult {
  const base = { questionId: q.id, required: q.required, calls: [] };
  if (typeof r === 'object' && !Array.isArray(r)) {
    return { ...base, status: 'blocked', reason: 'bank-silent', detail: '' };
  }
  return {
    ...base,
    status: 'backed',
    value: r,
    sources: [],
    derivation: 'as-written',
    inferences: [],
    verification: { verdict: 'not-needed', rounds: 0 },
  };
}

const BANK = { answers: [] } as unknown as FactBank;

function harness(s: Setup): Harness {
  const calls: Call[] = [];
  let current = '';
  let closed = false;
  let loads = 0;
  let bank = BANK;
  const values = { ...s.values };
  const checked = { ...s.checked };
  const asked: string[] = [];
  const printed: string[] = [];
  const saved: { question: string; answer: string }[] = [];
  const answered: FormQuestion[] = [];
  const replies = [...(s.author ?? [])];

  const screen = () => {
    const sc = s.screens[current];
    if (!sc) throw new Error(`no screen ${current}`);
    return sc;
  };
  const act = (op: string, l: Locator, arg?: string | number) => {
    const sel = selOf(l);
    checkNotSubmit(screen().html, sel);
    calls.push(arg === undefined ? { op, sel } : { op, sel, arg });
    const to = screen().on?.[sel];
    if (to) current = to;
  };

  const page: ApplyPage = {
    locator: loc,
    value: async (sel) => values[sel] ?? '',
    checked: async (sel) => checked[sel] ?? false,
    selectedText: async () => null,
    suggestion: async () => null,
    goto: async (url) => {
      calls.push({ op: 'goto', sel: url });
      current = s.start ?? 'job';
    },
    path: () => screen().path ?? JOB_PATH,
    html: async () => screen().html,
    close: async () => {
      closed = true;
      calls.push({ op: 'close', sel: '' });
    },
  };
  const pace: Pace = {
    mood: 1,
    defaulted: [],
    click: async (t) => {
      act('click', t);
      const sel = selOf(t);
      checked[sel] = !(checked[sel] ?? false);
    },
    type: async (f, text) => {
      act('type', f, text);
      values[selOf(f)] = (values[selOf(f)] ?? '') + text;
    },
    clear: async (f) => {
      act('clear', f);
      values[selOf(f)] = '';
    },
    glance: async (f) => act('glance', f),
    pick: async (c, i) => act('pick', c, i),
    upload: async (b, p) => act('upload', b, p),
    scroll: async (a) => act('scroll', a),
    read: async (n) => void calls.push({ op: 'read', sel: '', arg: n ?? -1 }),
    pause: async () => void calls.push({ op: 'pause', sel: '' }),
    maybe: () => false,
  };
  const io: TerminalIO | null = s.author
    ? {
        print: (line) => void printed.push(line),
        ask: async (prompt) => {
          asked.push(prompt);
          return replies.shift() ?? '';
        },
      }
    : null;
  let t = 0;
  const deps: ApplyDeps = {
    openPage: async () => {
      if (s.openFails) throw new Error('relay not running');
      return page;
    },
    pace: () => pace,
    stopReason: () => s.stopWhen?.(calls) ?? null,
    answer: async (q, b) => {
      answered.push(q);
      const a = s.answers?.[q.label];
      const r = typeof a === 'function' ? a(b) : a;
      return result(q, r ?? defaultAnswer(q));
    },
    loadBank: () => {
      loads++;
      return bank;
    },
    saveAnswer: (entry) => {
      saved.push(entry);
      const id = s.saveId ?? 'saved-answer';
      bank = { answers: [{ id }] } as unknown as FactBank;
      return { ok: true, id };
    },
    io,
    resume: { fileName: 'resume-2025.pdf', windowsPath: 'C:\\x\\cv.pdf' },
    now: () => (t += 10),
    wait: async (ms) => void calls.push({ op: 'wait', sel: '', arg: ms }),
  };
  const PACE_OPS = new Set([
    'click',
    'type',
    'clear',
    'glance',
    'pick',
    'upload',
    'scroll',
  ]);
  return {
    deps,
    calls,
    acts: () =>
      calls
        .filter((c) => PACE_OPS.has(c.op))
        .map((c) =>
          [c.op, c.sel, c.arg].filter((x) => x !== undefined).join(' '),
        ),
    closed: () => closed,
    asked,
    printed,
    saved,
    loads: () => loads,
    answered,
  };
}

/** job → contact → resume → questions → review → save prompt → closed. */
function fullFlow(): Record<string, Screen> {
  return {
    job: { html: JOB, on: { [EASY_APPLY]: 'contact' } },
    contact: { html: CONTACT, on: { [nextOf(CONTACT)]: 'resume' } },
    resume: { html: RESUME, on: { [nextOf(RESUME)]: 'questions' } },
    questions: { html: QUESTIONS_2, on: { [nextOf(QUESTIONS_2)]: 'review' } },
    ...reviewScreens(),
  };
}
function reviewScreens(): Record<string, Screen> {
  return {
    review: { html: REVIEW, on: { [DISMISS]: 'prompt' } },
    prompt: { html: SAVE_PROMPT, on: { [DISCARD]: 'gone' } },
    gone: { html: JOB },
  };
}
/** job → one step → review. */
function oneStep(step: string): Record<string, Screen> {
  return {
    job: { html: JOB, on: { [EASY_APPLY]: 'step' } },
    step: { html: step, on: { [nextOf(step)]: 'review' } },
    ...reviewScreens(),
  };
}

// ----------------------------------------------------- synthetic form pages

interface Synth {
  fields?: string[];
  next?: 'Next' | 'Review' | null;
  submit?: boolean;
  errors?: string[];
  extra?: string;
}
const textField = (id: string, label: string, required = true) =>
  `<div componentkey="easyApplyFieldFocus_${id}"><label for="${id}">${label}</label>` +
  `<input type="text" id="${id}"${required ? ' required' : ''}></div>`;
function synth(o: Synth): string {
  const next = o.next === undefined ? 'Next' : o.next;
  return (
    '<html><body><dialog data-testid="dialog" aria-labelledby="dialog-header" open>' +
    '<button type="button" aria-label="Dismiss"></button>' +
    '<header id="dialog-header"><h2>Apply to Acme</h2></header>' +
    '<div data-testid="dialog-content">' +
    (o.fields ?? []).join('') +
    (o.extra ?? '') +
    (o.errors ?? []).map((e) => `<div role="alert">${e}</div>`).join('') +
    '</div><footer>' +
    (next ? `<button id="next" type="button">${next}</button>` : '') +
    (o.submit
      ? '<button id="send" type="button">Submit application</button>'
      : '') +
    '</footer></dialog></body></html>'
  );
}

const A = textField('qa', 'Question A');
const B = textField('qb', 'Question B');
const C = textField('qc', 'Question C');
const D = textField('qd', 'Question D');

// -------------------------------------------------------------------- tests

const stopKind = (r: ApplyRun) => r.stop?.kind;

describe('runApply', () => {
  it('reaches review and never clicks a submit selector', async () => {
    const h = harness({ screens: fullFlow() });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.stop).toBeUndefined();
    expect(h.calls[0]).toEqual({
      op: 'goto',
      sel: 'https://www.linkedin.com/jobs/view/123/',
    });
    expect(run.job).toMatchObject({
      title: 'Back End Developer',
      company: 'Zero to One Search | Recruitment Agency',
      source: 'LinkedIn',
    });
    expect(run.job?.description.length).toBeGreaterThan(100);
    expect(h.calls).toContainEqual({
      op: 'read',
      sel: '',
      arg: run.job?.description.length,
    });
    const acts = h.acts();
    expect(acts).toContain(`click ${EASY_APPLY}`);
    expect(acts).toContain('click #_r_3d_'); // the resume with the bank's name
    // Close-out: Dismiss, then Discard on the save prompt, then close.
    expect(acts.slice(-2)).toEqual([`click ${DISMISS}`, `click ${DISCARD}`]);
    expect(h.closed()).toBe(true);
    expect(run.timings.perStepMs).toHaveLength(3);
    expect(run.timings.totalMs).toBeGreaterThan(0);
    expect(run.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('numbers questions s1-q1…', async () => {
    const h = harness({ screens: fullFlow() });
    const run = await runApply('123', h.deps);
    expect(run.questions.map((q) => q.question.id)).toEqual([
      's1-q1',
      's1-q2',
      's1-q3',
      's2-q1',
      's3-q1',
      's3-q2',
      's3-q3',
    ]);
    expect(run.questions.map((q) => q.step)).toEqual([1, 1, 1, 2, 3, 3, 3]);
    expect(run.questions.every((q) => q.by === 'bot')).toBe(true);
    expect(run.questions[0]?.question.stepTitle).toBe(
      'Apply to Zero to One Search | Recruitment Agency',
    );
  });

  it('fills the fields of a one-page form, then stops at its Submit', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'form' } },
        form: { html: ONE_PAGE, on: { [DISMISS]: 'gone' } },
        gone: { html: JOB },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.questions.length).toBeGreaterThan(2);
    expect(run.questions.every((q) => q.step === 1)).toBe(true);
    expect(h.acts().at(-1)).toBe(`click ${DISMISS}`);
    expect(h.closed()).toBe(true);
  });

  it('not Easy Apply', async () => {
    const html = JOB.replaceAll('Easy Apply to this job', 'Apply on site');
    const h = harness({ screens: { job: { html } } });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('not-easy-apply');
    expect(h.acts()).toEqual([]);
    expect(h.closed()).toBe(true);
  });

  it('already applied', async () => {
    const h = harness({
      screens: { job: { html: fixture('job-applied.html') } },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('already-applied');
    expect(h.acts()).toEqual([]);
    expect(h.closed()).toBe(true);
  });

  it('missing description is unexpected-page', async () => {
    const html = JOB.replaceAll('About the job', 'About the role');
    const h = harness({ screens: { job: { html } } });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({
      kind: 'unexpected-page',
      step: null,
      pathPrefix: '/jobs/',
    });
    expect(h.acts()).toEqual([]);
  });

  it('signed out after load', async () => {
    const h = harness({
      screens: {
        job: { html: '<html><body></body></html>', path: '/uas/login' },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({ kind: 'signed-out', pathPrefix: '/uas/' });
    expect(h.acts()).toEqual([]);
    expect(h.closed()).toBe(true);
  });

  it('challenge after a click', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'check' } },
        check: {
          html: '<html><body><iframe src="https://x/captcha/1"></iframe></body></html>',
        },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(stopKind(run)).toBe('security-check');
    expect(h.acts()).toEqual([`click ${EASY_APPLY}`]);
    expect(h.closed()).toBe(true);
  });

  it('no form after the Easy Apply click is unexpected-page', async () => {
    const h = harness({
      screens: { job: { html: JOB, on: { [EASY_APPLY]: 'job' } } },
    });
    const run = await runApply('123', h.deps);
    expect(run.stop).toMatchObject({ kind: 'unexpected-page', step: null });
    // Polled every 500 ms for 10 s.
    expect(h.calls.filter((c) => c.op === 'wait')).toHaveLength(20);
    expect(h.calls.every((c) => c.op !== 'wait' || c.arg === 500)).toBe(true);
  });

  it('unknown field stops', async () => {
    const step = synth({
      fields: [
        A,
        '<div componentkey="easyApplyFieldFocus_dt"><input type="date" id="dt"></div>',
      ],
    });
    const h = harness({ screens: oneStep(step) });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({ kind: 'unknown-field', step: 1 });
    expect(run.unknownFields).toEqual([
      { tag: 'input', role: null, inputType: 'date' },
    ]);
    expect(h.answered).toEqual([]);
    expect(h.acts()).not.toContain('type #qa ok');
    // The form was open: Dismiss before closing.
    expect(h.acts().at(-1)).toBe(`click ${DISMISS}`);
    expect(h.closed()).toBe(true);
  });

  it('step-did-not-change carries page errors', async () => {
    const step = synth({ fields: [A] });
    const stuck = synth({
      fields: [A],
      errors: ['Please enter a valid answer'],
    });
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'step' } },
        step: { html: step, on: { '#next': 'stuck' } },
        stuck: { html: stuck, on: { [DISMISS]: 'gone' } },
        gone: { html: JOB },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({
      kind: 'step-did-not-change',
      step: 1,
      pageErrors: ['Please enter a valid answer'],
    });
    expect(h.closed()).toBe(true);
  });

  it('follow-up field after fill is answered in round 2', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 's0' } },
        s0: { html: synth({ fields: [A] }), on: { '#qa': 's1' } },
        s1: { html: synth({ fields: [A, B] }), on: { '#next': 'review' } },
        ...reviewScreens(),
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.questions.map((q) => [q.question.id, q.question.label])).toEqual(
      [
        ['s1-q1', 'Question A'],
        ['s1-q2', 'Question B'],
      ],
    );
    expect(h.acts().filter((a) => a.startsWith('type'))).toEqual([
      'type #qa ok',
      'type #qb ok',
    ]);
  });

  it('fourth round stops', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 's0' } },
        s0: { html: synth({ fields: [A] }), on: { '#qa': 's1' } },
        s1: { html: synth({ fields: [A, B] }), on: { '#qb': 's2' } },
        s2: { html: synth({ fields: [A, B, C] }), on: { '#qc': 's3' } },
        s3: { html: synth({ fields: [A, B, C, D] }) },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({ kind: 'too-many-rounds', step: 1 });
    expect(run.questions).toHaveLength(3);
    expect(h.acts()).not.toContain('type #qd ok');
  });

  it('blocked required without io → needs-author, field left unfilled', async () => {
    const node = 'How many years of work experience do you have with Node.js?';
    const h = harness({
      screens: oneStep(QUESTIONS_2),
      answers: { [node]: BLOCKED },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('needs-author');
    const last = run.questions.at(-1);
    expect(last).toMatchObject({ by: 'needs-author', filled: null });
    expect(last?.question.label).toBe(node);
    expect(h.acts().some((a) => a.includes('#_r_44_'))).toBe(false);
    // Nothing after it is filled either.
    expect(h.acts().some((a) => a.includes('#_r_47_'))).toBe(false);
    expect(h.closed()).toBe(true);
  });

  it('blocked required radio without io → needs-author', async () => {
    const h = harness({
      screens: oneStep(QUESTIONS_2),
      answers: { 'Do you have a residence permit in Portugal?': BLOCKED },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('needs-author');
    expect(run.questions.at(-1)?.question.type).toBe('radio');
  });

  it('blocked optional without io → blank', async () => {
    const h = harness({
      screens: oneStep(LOCATION),
      answers: { 'What is your current location?': BLOCKED },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.questions[0]).toMatchObject({ by: 'blank', filled: null });
    expect(h.acts().some((a) => a.includes('#_r_48_'))).toBe(false);
  });

  it('a fill LinkedIn refuses is handled like a blocked answer', async () => {
    const h = harness({
      screens: oneStep(QUESTIONS_2),
      answers: { 'Do you have a residence permit in Portugal?': 'Maybe' },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('needs-author');
    expect(run.questions.at(-1)).toMatchObject({
      by: 'needs-author',
      fillProblem: 'no-option',
      filled: null,
    });
  });

  it('author answer is filled and saved, savedAs set', async () => {
    const node = 'How many years of work experience do you have with Node.js?';
    const h = harness({
      screens: oneStep(QUESTIONS_2),
      answers: { [node]: BLOCKED },
      author: ['5', '', ''],
      saveId: 'how-many-years-of-work-experience',
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    const q = run.questions.find((x) => x.question.label === node);
    expect(q).toMatchObject({
      by: 'author',
      filled: '5',
      savedAs: 'how-many-years-of-work-experience',
    });
    expect(h.saved).toEqual([{ question: node, answer: '5' }]);
    expect(h.acts()).toContain('type #_r_44_ 5');
    expect(h.loads()).toBe(2); // once at the start, once after the save
    // Enter at the review page comes before the close-out.
    expect(h.asked.at(-1)).toBe(
      'Review page reached. Press Enter to close the window.',
    );
  });

  it('uses a saved answer later in the same run', async () => {
    const english = 'What is your level of proficiency in English?';
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'one' } },
        one: { html: QUESTIONS_2, on: { [nextOf(QUESTIONS_2)]: 'two' } },
        two: { html: QUESTIONS, on: { [nextOf(QUESTIONS)]: 'review' } },
        ...reviewScreens(),
      },
      answers: {
        [english]: (bank) =>
          bank.answers.some((a) => a.id === 'english')
            ? 'Professional'
            : BLOCKED,
      },
      author: ['3', 'y', ''],
      saveId: 'english',
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    const both = run.questions.filter((q) => q.question.label === english);
    expect(both.map((q) => [q.step, q.by, q.filled])).toEqual([
      [1, 'author', 'Professional'],
      [2, 'bot', 'Professional'],
    ]);
    // The choice is saved as the option's text.
    expect(h.saved).toEqual([{ question: english, answer: 'Professional' }]);
    expect(h.loads()).toBe(2);
    // Asked once for the answer, once to save, once at review.
    expect(h.asked).toHaveLength(3);
  });

  it('several picks are saved joined with "; "', async () => {
    const group =
      '<div componentkey="easyApplyFieldFocus_g"><fieldset id="g">' +
      '<legend>Which stacks?</legend>' +
      '<input type="checkbox" id="c1"><label for="c1">Node</label>' +
      '<input type="checkbox" id="c2"><label for="c2">Go</label>' +
      '</fieldset></div>';
    const h = harness({
      screens: oneStep(synth({ fields: [group] })),
      answers: { 'Which stacks?': BLOCKED },
      author: ['1,2', 'y', ''],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.questions[0]).toMatchObject({
      by: 'author',
      filled: ['Node', 'Go'],
    });
    expect(h.saved).toEqual([
      { question: 'Which stacks?', answer: 'Node; Go' },
    ]);
    expect(h.acts()).toEqual(
      expect.arrayContaining(['click #c1', 'click #c2']),
    );
  });

  it('author stop → stopped', async () => {
    const h = harness({
      screens: oneStep(LOCATION),
      answers: { 'What is your current location?': BLOCKED },
      author: ['s'],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toBeUndefined();
    expect(run.questions[0]).toMatchObject({
      by: 'needs-author',
      filled: null,
    });
    expect(h.acts().some((a) => a.includes('#_r_48_'))).toBe(false);
    expect(h.closed()).toBe(true);
  });

  it('not-typeable backed answer goes to the author', async () => {
    const h = harness({
      screens: oneStep(LOCATION),
      answers: { 'What is your current location?': 'Zürich' },
      author: ['Zurich', 'n', ''],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(h.printed.some((l) => l.includes('not-typeable'))).toBe(true);
    expect(run.questions[0]).toMatchObject({ by: 'author', filled: 'Zurich' });
    expect(run.questions[0]?.savedAs).toBeUndefined();
    expect(h.saved).toEqual([]);
    expect(h.acts()).toContain('type #_r_48_ Zurich');
    expect(h.acts()).not.toContain('type #_r_48_ Zürich');
  });

  it('resumes a part-filled draft', async () => {
    const h = harness({
      screens: oneStep(CONTACT_NAMES),
      values: { '#_r_1k_': 'Ada', '#_r_1l_': 'Old' },
      answers: { 'First name': 'Ada', 'Last name': 'Lovelace' },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(h.acts()).toContain('glance #_r_1k_');
    expect(h.acts()).not.toContain('type #_r_1k_ Ada');
    expect(h.acts()).toContain('clear #_r_1l_');
    expect(h.acts()).toContain('type #_r_1l_ Lovelace');
    const byLabel = (l: string) =>
      run.questions.find((q) => q.question.label === l);
    expect(byLabel('First name')?.changedFromLinkedIn).toBe(false);
    expect(byLabel('Last name')?.changedFromLinkedIn).toBe(true);
  });

  it('stop mid-step still reports', async () => {
    const h = harness({
      screens: fullFlow(),
      start: 'job',
      // Ctrl+C lands right after the first field is typed.
      stopWhen: (calls) =>
        calls.some((c) => c.op === 'type') ? 'interrupted' : null,
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toMatchObject({
      kind: 'bridge',
      detail: 'interrupted',
      step: 1,
      pathPrefix: '/jobs/',
    });
    const acts = h.acts();
    expect(acts.filter((a) => a.startsWith('type'))).toHaveLength(1);
    expect(acts.at(-1)?.startsWith('type')).toBe(true); // no Dismiss on a bridge stop
    expect(h.closed()).toBe(true);
  });

  it('a page error mid-step is a bridge stop that still closes the page', async () => {
    const h = harness({ screens: fullFlow() });
    const inner = h.deps.pace;
    h.deps.pace = (p) => {
      const pace = inner(p);
      return {
        ...pace,
        click: async (t) => {
          if ((t as unknown as { sel: string }).sel === '#_r_3d_') {
            throw new Error('debugger detached: target_closed\ncall log: x');
          }
          return pace.click(t);
        },
      };
    };
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toMatchObject({
      kind: 'bridge',
      detail: 'debugger detached: target_closed',
      step: 2,
    });
    expect(h.closed()).toBe(true);
  });

  it('a page that will not open is bridge-unavailable', async () => {
    const h = harness({ screens: fullFlow(), openFails: true });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('bridge-unavailable');
    expect(run.stop).toMatchObject({ kind: 'bridge', pathPrefix: null });
  });

  it('a pace that fails to start still closes the tab', async () => {
    const h = harness({ screens: fullFlow() });
    h.deps.pace = () => {
      throw new Error('no pace profile');
    };
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toMatchObject({
      kind: 'bridge',
      detail: 'no pace profile',
    });
    expect(h.closed()).toBe(true);
  });

  it('a stop before the first action ends the run untouched', async () => {
    const h = harness({ screens: fullFlow(), stopWhen: () => 'interrupted' });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    // No tab was opened, so there is nothing to close.
    expect(h.calls).toEqual([]);
  });

  it('the submit check itself catches a Submit button', () => {
    const before = submitHits.length;
    checkNotSubmit(synth({ submit: true }), '#send');
    checkNotSubmit(ONE_PAGE, 'footer button');
    expect(submitHits.length).toBe(before + 2);
    submitHits.splice(before);
  });

  it('no pace call ever targets a submit control, across every test', () => {
    expect(actionsChecked).toBeGreaterThan(50);
    expect(submitHits).toEqual([]);
  });
});
