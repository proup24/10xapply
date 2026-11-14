import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locator } from 'patchright-core';
import {
  mapField,
  ModelUnavailableError,
  type AnswerResult,
  type AnswerValue,
  type FormQuestion,
} from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import {
  CheckFailedError,
  type CheckJob,
  type CheckQuestion,
  type Claim,
  type ClaimKind,
  type ExtractResult,
} from '@xapply/disqualify';
import { parsePage, type Document } from '../linkedin/dom.js';
import { readStep } from '../linkedin/form-step.js';
import {
  byId,
  DISMISS,
  EASY_APPLY,
  FORM_CONTENT,
  FORM_DIALOG,
  SAVE_PROMPT_DIALOG,
  SENT_DIALOG,
} from '../linkedin/selectors.js';
import { readSent } from '../linkedin/sent.js';
import { ConfigError } from '../config.js';
import type { Pace } from '../pace/pace.js';
import type { TerminalIO } from '../terminal/author-mode.js';
import {
  LEFTOVER_RECHECK_MS,
  REVIEW_PROMPT,
  MARKER_WAIT_MS,
  SENT_WAIT_MS,
  guardNext,
  runApply,
} from './run.js';
import type { JobEntry, JobStatus, StatusChange } from './record.js';
import { ReadMismatchError } from './fill.js';
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
/** A contact step with the save prompt open over it, after a backdrop click. */
const BACKDROP_PROMPT = fixture('review-backdrop-prompt.html');
/** That prompt's Discard button (review-backdrop-prompt.html). */
const BACKDROP_DISCARD =
  'button[componentkey="b5c808de-27d8-46a8-88e2-a0d7ced09d23"]';
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
  /** After this many reads of its HTML, the page becomes the named screen. */
  then?: { after: number; to: string };
}
// A screen's `on` key 'goto' moves to the named screen on the next `goto`.

interface Call {
  op: string;
  sel: string;
  arg?: string | number;
  /** The selector of the `within` box a pace action got, if any. */
  within?: string;
}

/** Every acted-on selector whose element reads as Submit, in this test. */
const submitHits: string[] = [];
/** Every acted-on selector whose element is a "Save" button, in this test. */
const saveHits: string[] = [];
/**
 * Set by the latest harness: true for a `submit: true` run. Only such runs
 * may hit Submit, at most once; every other run must never.
 */
let submitRun = false;

const SUBMIT = /submit/i;
function checkNotSubmit(html: string, sel: string) {
  for (const el of docOf(html).querySelectorAll(sel)) {
    const text = el.textContent ?? '';
    const label = el.getAttribute('aria-label') ?? '';
    if (SUBMIT.test(text) || SUBMIT.test(label)) submitHits.push(sel);
    if (text.trim() === 'Save') saveHits.push(sel);
  }
}

const loc = (sel: string) => ({ sel }) as unknown as Locator;
/** The input a `label[for="id"]` press acts on, else the selector itself. */
const inputOf = (sel: string) => {
  const m = /^label\[for="([^"]+)"\]$/.exec(sel);
  return m?.[1] ? byId(m[1]) : sel;
};
/** The bank's resume, pressed on its label (step-resume.html). */
const RESUME_PRESS = 'label[for="_r_3d_"]';
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
  /** What each job-page check was given. */
  jobChecks: CheckJob[];
  /** What each round's check was given. */
  stepChecks: CheckQuestion[][];
  /** Every record write, in order. */
  sets: { jobId: string; change: StatusChange }[];
  /** Every `deps.wait` argument. */
  waits: () => number[];
  /** Record sets (`set <status>`), pace clicks (`click <sel>`) and `goto`s. */
  order: () => string[];
  /** Every acted-on selector that read as Submit, in this harness. */
  submits: () => string[];
}

/** A record entry as the store holds it. */
const entry = (
  status: JobStatus,
  extra: StatusChange = { status },
): JobEntry => ({
  ...extra,
  status,
  updatedAt: '2026-11-13T10:00:00.000Z',
  history: [],
});

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
  /** `ask` rejects on this prompt (Ctrl+C or end of input). */
  rejectAsk?: string;
  /** Selectors typing doesn't change. */
  deaf?: string[];
  /** Once this selector is pressed, every checked-state read times out. */
  readsFailAfter?: string;
  /** The job-page check's claims; none by default. */
  jobClaims?: Claim[];
  /** Each round's check: its claims; none by default. */
  stepClaims?: (qs: CheckQuestion[]) => Claim[];
  /**
   * The record's initial entries; omitted: empty; null: `deps.record` is
   * null.
   */
  record?: Record<string, JobEntry> | null;
  /** Default false (a dry run). */
  submit?: boolean;
  /** A record `set` to this status throws. */
  setFails?: JobStatus;
  onSet?: (jobId: string, change: StatusChange) => void;
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
  submitRun = s.submit ?? false;
  const submits: string[] = [];
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
  const jobChecks: CheckJob[] = [];
  const stepChecks: CheckQuestion[][] = [];
  const replies = [...(s.author ?? [])];
  const reads: Record<string, number> = {};
  const sets: { jobId: string; change: StatusChange }[] = [];
  const entries: Record<string, JobEntry> = { ...(s.record ?? {}) };

  const screen = () => {
    const sc = s.screens[current];
    if (!sc) throw new Error(`no screen ${current}`);
    return sc;
  };
  const act = (
    op: string,
    l: Locator,
    arg?: string | number,
    opts?: { within?: Locator },
  ) => {
    const sel = selOf(l);
    const hitsBefore = submitHits.length;
    checkNotSubmit(screen().html, sel);
    if (submitHits.length > hitsBefore) submits.push(sel);
    calls.push({
      op,
      sel,
      ...(arg === undefined ? {} : { arg }),
      ...(opts?.within ? { within: selOf(opts.within) } : {}),
    });
    const to = screen().on?.[sel];
    if (to) current = to;
  };

  /** A read once `readsFailAfter` was pressed: Patchright times out. */
  const soft = () => {
    if (s.readsFailAfter && calls.some((c) => c.sel === s.readsFailAfter)) {
      throw Object.assign(new Error('locator.isChecked: Timeout 1000ms'), {
        name: 'TimeoutError',
      });
    }
  };
  const idAt = (sel: string, i: number, count: number) => {
    const els = [...docOf(screen().html).querySelectorAll(sel)];
    if (els.length !== count) throw new ReadMismatchError('inputs changed');
    return els[i]?.getAttribute('id') ?? null;
  };
  const page: ApplyPage = {
    locator: loc,
    value: async (sel) => values[sel] ?? '',
    checked: async (sel) => (soft(), checked[sel] ?? false),
    // Stable reads go through the screen's own DOM to the inputs' ids.
    anyChecked: async (sel) => {
      soft();
      const els = [...docOf(screen().html).querySelectorAll(sel)];
      if (els.length === 0) throw new ReadMismatchError('nothing matches');
      return els.some((el) => checked[byId(el.getAttribute('id') ?? '')]);
    },
    checkedAt: async (sel, i, count) => {
      soft();
      return checked[byId(idAt(sel, i, count) ?? '')] ?? false;
    },
    idAt: async (sel, i, count) => (soft(), idAt(sel, i, count)),
    selectedText: async () => null,
    suggestion: async () => null,
    goto: async (url) => {
      const to = current === '' ? undefined : screen().on?.goto;
      calls.push({ op: 'goto', sel: url });
      current = to ?? s.start ?? 'job';
    },
    path: () => screen().path ?? JOB_PATH,
    html: async () => {
      const sc = screen();
      if (sc.then) {
        reads[current] = (reads[current] ?? 0) + 1;
        if (reads[current] >= sc.then.after) current = sc.then.to;
      }
      return sc.html;
    },
    close: async () => {
      closed = true;
      calls.push({ op: 'close', sel: '' });
    },
  };
  const pace: Pace = {
    mood: 1,
    defaulted: [],
    click: async (t, o) => {
      act('click', t, undefined, o);
      // A label[for] press changes its input's state.
      const sel = inputOf(selOf(t));
      checked[sel] = !(checked[sel] ?? false);
    },
    type: async (f, text, o) => {
      act('type', f, text, o);
      if (s.deaf?.includes(selOf(f))) return;
      values[selOf(f)] = (values[selOf(f)] ?? '') + text;
    },
    clear: async (f, o) => {
      act('clear', f, undefined, o);
      values[selOf(f)] = '';
    },
    glance: async (f, o) => act('glance', f, undefined, o),
    pick: async (c, i, o) => act('pick', c, i, o),
    upload: async (b, p, o) => act('upload', b, p, o),
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
          if (prompt === s.rejectAsk) throw new Error('input closed');
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
    checkJob: async (job) => {
      jobChecks.push(job);
      calls.push({ op: 'check-job', sel: '' });
      return { claims: s.jobClaims ?? [], calls: [CALL] };
    },
    checkQuestions: async (qs) => {
      stepChecks.push(qs);
      calls.push({ op: 'check-step', sel: qs.map((q) => q.id).join(',') });
      return { claims: s.stepClaims?.(qs) ?? [], calls: [CALL] };
    },
    rules: { authorizedCountries: ['MA'], locatedIn: ['MA'] },
    submit: s.submit ?? false,
    record:
      s.record === null
        ? null
        : {
            get: (jobId) => entries[jobId] ?? null,
            set: (jobId, change, runStartedAt) => {
              if (s.setFails === change.status) throw new Error('disk full');
              sets.push({ jobId, change });
              calls.push({ op: 'set', sel: change.status });
              s.onSet?.(jobId, change);
              const prev = entries[jobId];
              const e: JobEntry = {
                ...change,
                updatedAt: '2026-11-14T10:00:00.000Z',
                history: [
                  ...(prev?.history ?? []),
                  { ...change, at: '2026-11-14T10:00:00.000Z', runStartedAt },
                ],
              };
              entries[jobId] = e;
              return e;
            },
          },
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
    jobChecks,
    stepChecks,
    sets,
    waits: () => calls.filter((c) => c.op === 'wait').map((c) => Number(c.arg)),
    order: () =>
      calls.flatMap((c) =>
        c.op === 'set'
          ? [`set ${c.sel}`]
          : c.op === 'click'
            ? [`click ${c.sel}`]
            : c.op === 'goto'
              ? ['goto']
              : [],
      ),
    submits: () => [...submits],
  };
}

const CALL = {
  role: 'extract',
  model: 'opus',
  latencyMs: 5,
  costUsd: null,
  ok: true,
} as const;

/** A claim as the extractor gives it; the quote is never checked here. */
const claim = (
  kind: ClaimKind,
  countries: string[],
  source = 'job-page',
): Claim => ({
  kind,
  countries,
  countryFrom: 'text',
  quote: 'quoted',
  placeQuote: null,
  source,
  detail: null,
});

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
    '<footer>' +
    (next ? `<button id="next" type="button">${next}</button>` : '') +
    (o.submit
      ? '<button id="send" type="button">Submit application</button>'
      : '') +
    '</footer></div></dialog></body></html>'
  );
}

/** `html` with a minimal "Save this application?" prompt dialog added. */
const withPrompt = (html: string) =>
  html.replace(
    '</body>',
    '<dialog data-testid="dialog" open><h2>Save this application?</h2>' +
      '<button type="button" aria-label="Dismiss"></button>' +
      '<button id="discard" type="button">Discard</button>' +
      '<button id="save" type="button">Save</button></dialog></body>',
  );

const A = textField('qa', 'Question A');
const B = textField('qb', 'Question B');
const C = textField('qc', 'Question C');
const D = textField('qd', 'Question D');

// -------------------------------------------------------------------- tests

const stopKind = (r: ApplyRun) => r.stop?.kind;

describe('the record at the start', () => {
  const checked = (step: string): Record<string, Screen> => ({
    job: { html: JOB, on: { [EASY_APPLY]: 'step' } },
    step: {
      html: step,
      on: { [nextOf(step)]: 'review', [DISMISS]: 'prompt' },
    },
    ...reviewScreens(),
  });
  it('applied in the record: refused before a window opens', async () => {
    const h = harness({
      screens: fullFlow(),
      record: { '123': entry('applied') },
    });
    const run = await runApply('123', h.deps);
    expect(run).toMatchObject({
      outcome: 'already-applied',
      via: 'record',
      record: { before: 'applied', after: 'applied' },
    });
    expect(h.calls).toEqual([]);
    expect(h.sets).toEqual([]);
  });

  it.each([false, true])(
    'disqualified in the record: refused before a window opens (submit %s)',
    async (submit) => {
      const h = harness({
        screens: fullFlow(),
        submit,
        record: { '123': entry('disqualified') },
      });
      const run = await runApply('123', h.deps);
      expect(run).toMatchObject({
        outcome: 'disqualified',
        via: 'record',
        record: { before: 'disqualified', after: 'disqualified' },
      });
      expect(h.calls).toEqual([]);
    },
  );

  it.each([false, true])(
    'a marker on a job the record does not know is recorded applied (submit %s)',
    async (submit) => {
      const h = harness({
        submit,
        screens: { job: { html: fixture('job-applied.html') } },
      });
      const run = await runApply('123', h.deps);
      expect(run).toMatchObject({
        outcome: 'already-applied',
        via: 'linkedin',
        record: { before: null, after: 'applied' },
      });
      expect(h.sets).toEqual([
        {
          jobId: '123',
          change: { status: 'applied', source: 'linkedin-marker' },
        },
      ]);
      expect(h.acts()).toEqual([]);
    },
  );

  it('a job-page disqualification is recorded with its reason', async () => {
    const h = harness({
      screens: fullFlow(),
      jobClaims: [claim('requires-location', ['DE'])],
    });
    const run = await runApply('123', h.deps);
    expect(run).toMatchObject({
      outcome: 'disqualified',
      via: 'linkedin',
      record: { before: null, after: 'disqualified' },
    });
    expect(h.sets).toEqual([
      {
        jobId: '123',
        change: { status: 'disqualified', reason: 'requires-location:DE' },
      },
    ]);
  });

  it('a form-step disqualification is recorded too', async () => {
    const h = harness({
      screens: checked(synth({ fields: [A] })),
      stepClaims: () => [claim('requires-location', ['DE'], 's1-q1')],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('disqualified');
    expect(h.sets).toEqual([
      {
        jobId: '123',
        change: { status: 'disqualified', reason: 'requires-location:DE' },
      },
    ]);
  });

  it('a record set that throws on disqualified still ends disqualified', async () => {
    const h = harness({
      screens: fullFlow(),
      jobClaims: [claim('requires-location', ['DE'])],
      record: { '123': entry('failed') },
      setFails: 'disqualified',
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('disqualified');
    expect(run.record).toMatchObject({ before: 'failed', after: 'failed' });
    expect(h.sets).toEqual([]);
  });

  it('failed in the record walks the form as usual', async () => {
    const h = harness({
      screens: fullFlow(),
      record: { '123': entry('failed') },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.record).toMatchObject({ before: 'failed', after: 'failed' });
    expect(h.sets).toEqual([]);
  });

  it('a null record (dry run) reads and writes nothing', async () => {
    const h = harness({
      screens: { job: { html: fixture('job-applied.html') } },
      record: null,
    });
    const run = await runApply('123', h.deps);
    expect(run).toMatchObject({
      outcome: 'already-applied',
      via: 'linkedin',
      record: { before: null, after: null },
    });
    expect(h.sets).toEqual([]);
  });

  describe('a leftover submitting', () => {
    const left = { '123': entry('submitting') };

    it('with the marker: applied from linkedin-marker, form never opened', async () => {
      const h = harness({
        submit: true,
        screens: { job: { html: fixture('job-applied.html') } },
        record: left,
      });
      const run = await runApply('123', h.deps);
      expect(run).toMatchObject({
        outcome: 'already-applied',
        via: 'linkedin',
        record: { before: 'submitting', after: 'applied' },
      });
      expect(h.sets).toEqual([
        {
          jobId: '123',
          change: { status: 'applied', source: 'linkedin-marker' },
        },
      ]);
      expect(h.acts()).toEqual([]);
      expect(h.waits()).not.toContain(LEFTOVER_RECHECK_MS);
    });

    it('without the marker: one reload after LEFTOVER_RECHECK_MS, then failed submit-unconfirmed, form never opened', async () => {
      const h = harness({
        submit: true,
        screens: { job: { html: JOB } },
        record: left,
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submit-unconfirmed');
      expect(run.record).toMatchObject({
        before: 'submitting',
        after: 'failed',
      });
      expect(h.calls.filter((c) => c.op === 'goto')).toHaveLength(2);
      expect(h.waits()).toContain(LEFTOVER_RECHECK_MS);
      expect(h.sets).toEqual([
        {
          jobId: '123',
          change: { status: 'failed', reason: 'submit-unconfirmed' },
        },
      ]);
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
    });

    it('the marker on the reload: applied', async () => {
      const h = harness({
        submit: true,
        screens: {
          job: { html: JOB, on: { goto: 'job2' } },
          job2: { html: fixture('job-applied.html') },
        },
        record: left,
      });
      const run = await runApply('123', h.deps);
      expect(run).toMatchObject({
        outcome: 'already-applied',
        via: 'linkedin',
        record: { after: 'applied' },
      });
      expect(h.sets).toEqual([
        {
          jobId: '123',
          change: { status: 'applied', source: 'linkedin-marker' },
        },
      ]);
      expect(h.calls.filter((c) => c.op === 'goto')).toHaveLength(2);
      expect(h.acts()).toEqual([]);
    });

    it('a dry run walks it and writes nothing', async () => {
      const h = harness({ screens: fullFlow(), record: left });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(run.record).toMatchObject({
        before: 'submitting',
        after: 'submitting',
      });
      expect(h.sets).toEqual([]);
    });
  });
});

describe('runApply', () => {
  // The never-submit rule, checked after every test's run. A `submit: true`
  // run asserts its own Submit clicks; even it never gets more than one.
  afterEach(() => {
    const hits = submitHits.splice(0);
    if (submitRun) expect(hits.length).toBeLessThanOrEqual(1);
    else expect(hits).toEqual([]);
    submitRun = false;
    // Nor ever the save prompt's Save.
    expect(saveHits.splice(0)).toEqual([]);
  });

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
    expect(acts).toContain(`click ${RESUME_PRESS}`); // the bank's resume, on its label
    // Close-out: Dismiss, then Discard on the save prompt, then close.
    expect(acts.slice(-2)).toEqual([`click ${DISMISS}`, `click ${DISCARD}`]);
    expect(h.closed()).toBe(true);
    expect(run.timings.perStepMs).toHaveLength(3);
    expect(run.timings.totalMs).toBeGreaterThan(0);
    expect(run.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('fills and Next keep to the form content; the header Dismiss to the dialog', async () => {
    const h = harness({ screens: fullFlow() });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    const acts = h.calls.filter((c) =>
      ['click', 'type', 'clear', 'glance', 'pick', 'upload'].includes(c.op),
    );
    // The job page's Easy Apply gets no box; Discard gets the prompt's own.
    const outside = [EASY_APPLY, DISCARD];
    expect(acts.filter((c) => outside.includes(c.sel))).toEqual([
      { op: 'click', sel: EASY_APPLY },
      { op: 'click', sel: DISCARD, within: SAVE_PROMPT_DIALOG },
    ]);
    const inForm = acts.filter((c) => !outside.includes(c.sel));
    // Fills and every Next and Review: the scrolling content.
    const content = inForm.filter((c) => c.sel !== DISMISS);
    expect(content.length).toBeGreaterThan(5);
    expect(content.map((c) => c.sel)).toContain(nextOf(CONTACT));
    expect(content.filter((c) => c.within !== FORM_CONTENT)).toEqual([]);
    // The close-out's Dismiss sits in the header: the whole dialog.
    expect(inForm.filter((c) => c.sel === DISMISS)).toEqual([
      { op: 'click', sel: DISMISS, within: FORM_DIALOG },
    ]);
  });

  it('a guarded pace passes the form dialog through', async () => {
    const h = harness({ screens: oneStep(synth({ fields: [A] })) });
    await runApply('123', h.deps);
    expect(h.calls).toContainEqual({
      op: 'type',
      sel: '#qa',
      arg: 'ok',
      within: FORM_CONTENT,
    });
    expect(h.calls).toContainEqual({
      op: 'click',
      sel: '#next',
      within: FORM_CONTENT,
    });
  });

  it('the normal close-out clicks the form Dismiss in the form, then Discard in the prompt', async () => {
    const h = harness({ screens: fullFlow() });
    await runApply('123', h.deps);
    const clicks = h.calls.filter((c) => c.op === 'click');
    expect(clicks.slice(-2)).toEqual([
      { op: 'click', sel: DISMISS, within: FORM_DIALOG },
      { op: 'click', sel: DISCARD, within: SAVE_PROMPT_DIALOG },
    ]);
    expect(h.closed()).toBe(true);
  });

  it('a save prompt open over the form stops the run before any form action; Discard is first', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'backdrop' } },
        backdrop: { html: BACKDROP_PROMPT, on: { [BACKDROP_DISCARD]: 'gone' } },
        gone: { html: JOB },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toMatchObject({
      kind: 'unexpected-page',
      detail: 'the save prompt is open',
    });
    // No fill, no Next, no Dismiss: after Easy Apply, only the Discard.
    expect(h.acts()).toEqual([
      `click ${EASY_APPLY}`,
      `click ${BACKDROP_DISCARD}`,
    ]);
    expect(h.calls.filter((c) => c.op === 'click').at(-1)).toEqual({
      op: 'click',
      sel: BACKDROP_DISCARD,
      within: SAVE_PROMPT_DIALOG,
    });
    expect(run.questions).toEqual([]);
    expect(h.closed()).toBe(true);
  });

  it('a save prompt that opens mid-step stops the next fill', async () => {
    const step = synth({ fields: [A, B] });
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'step' } },
        // Typing into A lands a press on the backdrop: the prompt opens.
        step: { html: step, on: { '#qa': 'prompted' } },
        prompted: { html: withPrompt(step), on: { '#discard': 'gone' } },
        gone: { html: JOB },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.stop).toMatchObject({
      kind: 'unexpected-page',
      detail: 'the save prompt is open',
    });
    expect(h.acts()).toEqual([
      `click ${EASY_APPLY}`,
      'type #qa ok',
      'click #discard',
    ]);
    expect(h.closed()).toBe(true);
  });

  it('a save prompt whose dialog cannot be pinned gets no press; the page just closes', async () => {
    // A third open dialog: the prompt's own dialog is no longer unique.
    const extra = SAVE_PROMPT.replace(
      '</body>',
      '<dialog data-testid="dialog" open></dialog></body>',
    );
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'contact' } },
        contact: { html: CONTACT, on: { [nextOf(CONTACT)]: 'review' } },
        review: { html: REVIEW, on: { [DISMISS]: 'prompt' } },
        prompt: { html: extra, on: { [DISCARD]: 'gone' } },
        gone: { html: JOB },
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    const acts = h.acts();
    expect(acts.at(-1)).toBe(`click ${DISMISS}`);
    expect(acts).not.toContain(`click ${DISCARD}`);
    expect(h.closed()).toBe(true);
  });

  it('a rejected review prompt still dismisses, discards and closes', async () => {
    const h = harness({
      screens: fullFlow(),
      author: [],
      rejectAsk: REVIEW_PROMPT,
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(h.asked).toEqual([REVIEW_PROMPT]);
    expect(h.acts().slice(-2)).toEqual([
      `click ${DISMISS}`,
      `click ${DISCARD}`,
    ]);
    expect(h.closed()).toBe(true);
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

  describe('a job page that renders after the load event', () => {
    const SKELETON =
      '<html><body><main><h1>Loading</h1><div class="skeleton"></div></main></body></html>';
    const waits = (h: Harness) => h.calls.filter((c) => c.op === 'wait');

    it('waits through a skeleton, then walks normally', async () => {
      const h = harness({
        screens: {
          skel: { html: SKELETON, then: { after: 2, to: 'job' } },
          ...fullFlow(),
        },
        start: 'skel',
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(run.job?.description).toBeTruthy();
      expect(waits(h).length).toBeGreaterThanOrEqual(2);
    });

    it('a skeleton that never fills is unexpected-page, not not-easy-apply', async () => {
      const h = harness({
        screens: { skel: { html: SKELETON } },
        start: 'skel',
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({ kind: 'unexpected-page' });
      expect(waits(h).length).toBe(20);
      expect(h.acts()).toEqual([]);
    });

    it('recognises the applied page as soon as it shows', async () => {
      const h = harness({
        screens: {
          skel: { html: SKELETON, then: { after: 1, to: 'done' } },
          done: { html: fixture('job-applied.html') },
        },
        start: 'skel',
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('already-applied');
      expect(waits(h).length).toBeLessThanOrEqual(2);
    });

    it('stops waiting when the stop reason is set', async () => {
      const h = harness({
        screens: { skel: { html: SKELETON } },
        start: 'skel',
        stopWhen: (calls) =>
          calls.filter((c) => c.op === 'wait').length >= 1
            ? 'interrupted'
            : null,
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(waits(h).length).toBe(1);
    });
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
    // After the click, polled every 500 ms for 10 s.
    const afterClick = h.calls.slice(
      h.calls.findIndex((c) => c.op === 'click'),
    );
    expect(afterClick.filter((c) => c.op === 'wait')).toHaveLength(20);
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
      { tag: 'input', role: null, inputType: 'date', label: null },
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

  it('the contact step’s phone gets the national number beside the country code', async () => {
    const h = harness({
      screens: fullFlow(),
      values: { '#_r_1k_': '7700900123' },
    });
    const stub = {
      fields: {
        phone: {
          countryCode: '+44',
          country: 'United Kingdom',
          number: '7700900123',
          full: '+44 7700900123',
        },
      },
    } as unknown as FactBank;
    const fallback = h.deps.answer;
    h.deps.answer = async (q, b, job) => {
      const m = mapField(q, stub);
      if (m.kind === 'filled' && m.key === 'phone') {
        return result(q, m.value);
      }
      return fallback(q, b, job);
    };
    const run = await runApply('123', h.deps);
    const phone = run.questions.find(
      (q) => q.question.label === 'Mobile phone number',
    );
    expect(phone?.question.stepLabels).toContain('Phone country code');
    expect(phone?.question.stepLabels).not.toContain('Mobile phone number');
    expect(phone?.result).toMatchObject({ value: '7700900123' });
    expect(phone?.changedFromLinkedIn).toBe(false);
    expect(h.acts()).toContain('glance #_r_1k_');
    expect(h.acts().some((a) => a.startsWith('type #_r_1k_'))).toBe(false);
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
    expect(run.stop).toEqual({
      kind: 'needs-author',
      step: 1,
      detail: 'question s1-q2 needs the author',
      pathPrefix: '/jobs/',
    });
    expect(run.timings.perStepMs).toHaveLength(1); // the stopped step is timed
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
    expect(run.stop).toMatchObject({
      kind: 'needs-author',
      detail: 'question s1-q3 needs the author',
    });
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
      // Pressed on their labels; the harness checks the inputs.
      expect.arrayContaining([
        'click label[for="c1"]',
        'click label[for="c2"]',
      ]),
    );
  });

  describe('a check that fails after a press (unverified)', () => {
    const group =
      '<div componentkey="easyApplyFieldFocus_g"><fieldset id="g">' +
      '<legend>Which stacks?</legend>' +
      '<input type="checkbox" id="c1"><label for="c1">Node</label>' +
      '<input type="checkbox" id="c2"><label for="c2">Go</label>' +
      '</fieldset></div>';

    it('without an author, an optional question ends as needs-author, not blank', async () => {
      const h = harness({
        screens: oneStep(synth({ fields: [group] })),
        answers: { 'Which stacks?': ['Node', 'Go'] },
        readsFailAfter: 'label[for="c1"]',
      });
      const run = await runApply('123', h.deps);
      expect(run.questions[0]?.question.required).toBe(false);
      expect(run.outcome).toBe('needs-author');
      expect(run.questions[0]).toMatchObject({
        by: 'needs-author',
        fillProblem: 'unverified',
      });
      // One press, then nothing more in the form.
      expect(h.acts().filter((a) => a.includes('c2'))).toEqual([]);
    });

    it('with an author, it is asked about like any blocked question', async () => {
      const h = harness({
        screens: oneStep(synth({ fields: [group] })),
        answers: { 'Which stacks?': ['Node', 'Go'] },
        readsFailAfter: 'label[for="c1"]',
        author: ['s'],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(h.printed.join('\n') + h.asked.join('\n')).toMatch(/unverified/);
    });
  });

  it('author stop → stopped', async () => {
    const screens = oneStep(LOCATION);
    screens['step'] = { html: LOCATION, on: { [DISMISS]: 'prompt' } };
    const h = harness({
      screens,
      answers: { 'What is your current location?': BLOCKED },
      author: ['s'],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toEqual({
      kind: 'author',
      step: 1,
      detail: 'the author stopped the run',
      pathPrefix: '/jobs/',
    });
    // No Enter wait after the author's own stop, but Dismiss and Discard.
    expect(h.asked).toHaveLength(1);
    expect(h.acts().slice(-2)).toEqual([
      `click ${DISMISS}`,
      `click ${DISCARD}`,
    ]);
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
    const screens = fullFlow();
    screens['contact'] = {
      ...(screens['contact'] as Screen),
      on: { [DISMISS]: 'prompt' },
    };
    const h = harness({
      screens,
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
    // Ctrl+C still dismisses and discards, so no draft is kept.
    expect(acts.slice(-2)).toEqual([`click ${DISMISS}`, `click ${DISCARD}`]);
    expect(h.closed()).toBe(true);
    expect(run.timings.perStepMs).toHaveLength(1);
  });

  it('any other bridge stop goes straight to close', async () => {
    const h = harness({
      screens: fullFlow(),
      stopWhen: (calls) =>
        calls.some((c) => c.op === 'type') ? 'bridge went away' : null,
    });
    const run = await runApply('123', h.deps);
    expect(run.stop).toMatchObject({
      kind: 'bridge',
      detail: 'bridge went away',
    });
    expect(h.acts().at(-1)?.startsWith('type')).toBe(true);
    expect(h.closed()).toBe(true);
  });

  /** The harness with a click on `sel` throwing `err`. */
  function failingClick(sel: string, err: Error) {
    const h = harness({ screens: fullFlow() });
    const inner = h.deps.pace;
    h.deps.pace = (p) => {
      const pace = inner(p);
      return {
        ...pace,
        click: async (t) => {
          if ((t as unknown as { sel: string }).sel === sel) throw err;
          return pace.click(t);
        },
      };
    };
    return h;
  }

  it('an unexpected error is kind error, named but not quoted', async () => {
    const h = failingClick(
      RESUME_PRESS,
      new Error('debugger detached: target_closed\ncall log: x'),
    );
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toMatchObject({
      kind: 'error',
      detail: 'Error',
      error: 'debugger detached: target_closed',
      step: 2,
    });
    expect(h.closed()).toBe(true);
    expect(run.timings.perStepMs).toHaveLength(2);
  });

  it('an error once the bridge has gone is a bridge stop', async () => {
    let gone = false;
    const h = failingClick(RESUME_PRESS, new Error('target closed'));
    const click = h.deps.pace;
    h.deps.pace = (p) => {
      const pace = click(p);
      return {
        ...pace,
        click: async (t) => {
          if ((t as unknown as { sel: string }).sel === RESUME_PRESS)
            gone = true;
          return pace.click(t);
        },
      };
    };
    h.deps.stopReason = () => (gone ? 'bridge went away' : null);
    const run = await runApply('123', h.deps);
    expect(run.stop).toMatchObject({
      kind: 'bridge',
      detail: 'bridge went away',
    });
    expect(run.stop?.error).toBeUndefined();
  });

  it('a pace refusal is an unexpected-page safety stop', async () => {
    const h = failingClick(
      RESUME_PRESS,
      new Error('pace: target has no box (hidden or detached)'),
    );
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('safety-stop');
    expect(run.stop).toEqual({
      kind: 'unexpected-page',
      step: 2,
      detail: 'the page did not take an input',
      error: 'pace: target has no box (hidden or detached)',
      pathPrefix: '/jobs/',
    });
    expect(h.closed()).toBe(true);
  });

  it("a pace refusal keeps its message's first line, at most 200 characters", async () => {
    const long = `pace: target is off-screen ${'x'.repeat(300)}\nsecond line`;
    const h = failingClick(RESUME_PRESS, new Error(long));
    const run = await runApply('123', h.deps);
    expect(run.stop?.kind).toBe('unexpected-page');
    expect(run.stop?.error).toBe(long.split('\n')[0]?.slice(0, 200));
    expect(run.stop?.error).toHaveLength(200);
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
      throw new ConfigError('no pace profile');
    };
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('stopped');
    expect(run.stop).toMatchObject({
      kind: 'error',
      detail: 'ConfigError',
      error: 'no pace profile',
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

  it('waits for a form that opens empty, and never clicks Next on it', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'empty' } },
        empty: { html: synth({}), then: { after: 3, to: 'step' } },
        step: { html: synth({ fields: [A] }), on: { '#next': 'review' } },
        ...reviewScreens(),
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.questions.map((q) => q.question.label)).toEqual(['Question A']);
    const acts = h.acts();
    expect(acts.indexOf('type #qa ok')).toBeGreaterThan(-1);
    expect(acts.indexOf('click #next')).toBeGreaterThan(
      acts.indexOf('type #qa ok'),
    );
  });

  it('takes a step only once two reads in a row agree', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'first' } },
        first: { html: synth({ fields: [B] }), then: { after: 1, to: 'full' } },
        full: { html: synth({ fields: [A, B] }), on: { '#next': 'review' } },
        ...reviewScreens(),
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    // Both fields were read together on the settled step, in page order.
    expect(run.questions.map((q) => q.question.label)).toEqual([
      'Question A',
      'Question B',
    ]);
  });

  it('an empty step that stays empty is taken after the settle wait', async () => {
    const h = harness({
      screens: {
        job: { html: JOB, on: { [EASY_APPLY]: 'empty' } },
        empty: { html: synth({}), on: { '#next': 'review' } },
        ...reviewScreens(),
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    // Two reads to agree, then 2 s more (four 500 ms waits) before Next.
    const beforeNext = h.calls.slice(
      0,
      h.calls.findIndex((c) => c.op === 'click' && c.sel === '#next'),
    );
    expect(
      beforeNext.filter((c) => c.op === 'wait' && c.arg === 500).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('typed text the page did not take goes down the blocked path', async () => {
    const h = harness({
      screens: oneStep(synth({ fields: [A] })),
      deaf: ['#qa'],
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('needs-author');
    expect(run.questions[0]).toMatchObject({
      by: 'needs-author',
      fillProblem: 'not-taken',
      filled: null,
    });
  });

  it('fills a company the job page lacked from the form heading', async () => {
    const job = JOB.replaceAll(
      'aria-label="Follow Zero to One Search | Recruitment Agency"',
      '',
    );
    const h = harness({
      screens: {
        job: { html: job, on: { [EASY_APPLY]: 'step' } },
        step: { html: synth({ fields: [A] }), on: { '#next': 'review' } },
        ...reviewScreens(),
      },
    });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('reached-review');
    expect(run.job?.company).toBe('Acme');
  });

  it('the submit check itself catches a Submit button', () => {
    checkNotSubmit(synth({ submit: true }), '#send');
    checkNotSubmit(ONE_PAGE, 'footer button');
    expect(submitHits.splice(0)).toHaveLength(2);
  });

  it('never clicks a Next that reads Submit', async () => {
    const step = synth({ fields: [A], next: null, submit: true });
    const doc = parsePage(step);
    expect(() => guardNext(doc, { selector: '#send', label: 'next' })).toThrow(
      expect.objectContaining({ outcome: 'safety-stop' }),
    );
    const ok = parsePage(synth({ fields: [A] }));
    // A label that reads Submit is refused whatever the button says.
    expect(() =>
      guardNext(ok, { selector: '#next', label: 'Submit' as 'next' }),
    ).toThrow();
    expect(() =>
      guardNext(ok, { selector: '#next', label: 'next' }),
    ).not.toThrow();
  });
  describe('the requirements checks', () => {
    /** job → `step` (Dismiss opens the save prompt) → review. */
    const checked = (step: string): Record<string, Screen> => ({
      job: { html: JOB, on: { [EASY_APPLY]: 'step' } },
      step: {
        html: step,
        on: { [nextOf(step)]: 'review', [DISMISS]: 'prompt' },
      },
      ...reviewScreens(),
    });
    const typed = (h: Harness) => h.acts().filter((a) => a.startsWith('type'));

    it('disqualifying job page never opens the form', async () => {
      const h = harness({
        screens: fullFlow(),
        jobClaims: [claim('requires-authorization', ['US'])],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(run.stop).toBeUndefined();
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
      expect(h.acts()).toEqual([]);
      expect(run.checks[0]).toEqual({
        at: 'job-page',
        step: null,
        ok: true,
        claims: [claim('requires-authorization', ['US'])],
        calls: [CALL],
      });
      expect(run.disqualification).toEqual([
        claim('requires-authorization', ['US']),
      ]);
      expect(h.stepChecks).toEqual([]);
      expect(h.closed()).toBe(true);
    });

    it('the job check gets the title, company and description only', async () => {
      const h = harness({ screens: fullFlow() });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(h.jobChecks).toEqual([
        {
          title: run.job?.title,
          company: run.job?.company,
          description: run.job?.description,
        },
      ]);
      expect(run.disqualification).toBeNull();
    });

    it('the job check runs during the read', async () => {
      const h = harness({ screens: fullFlow() });
      let readResolved = false;
      let calledBefore: boolean | null = null;
      const inner = h.deps.pace;
      h.deps.pace = (p) => {
        const pace = inner(p);
        return {
          ...pace,
          read: async (n) => {
            await pace.read(n);
            readResolved = true;
          },
        };
      };
      const check = h.deps.checkJob;
      h.deps.checkJob = (job) => {
        calledBefore = !readResolved;
        return check(job);
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(calledBefore).toBe(true);
      const ops = h.calls.map((c) => c.op);
      expect(ops.indexOf('check-job')).toBeLessThan(ops.indexOf('read'));
    });

    it('job check failing during the read stops before Easy Apply', async () => {
      const h = harness({ screens: fullFlow() });
      let reject: (e: unknown) => void = () => undefined;
      h.deps.checkJob = () =>
        new Promise<ExtractResult>((_, rej) => {
          reject = rej;
        });
      const inner = h.deps.pace;
      h.deps.pace = (p) => {
        const pace = inner(p);
        return {
          ...pace,
          read: async (n) => {
            reject(new CheckFailedError('model-error', [CALL]));
            // A macrotask: an unhandled rejection would be reported here.
            await new Promise((r) => setTimeout(r, 20));
            await pace.read(n);
          },
        };
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({
        kind: 'check-failed',
        detail: 'the requirements check did not give a valid answer',
        step: null,
      });
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
      expect(run.checks).toEqual([
        { at: 'job-page', step: null, ok: false, claims: [], calls: [CALL] },
      ]);
      expect(h.closed()).toBe(true);
    });

    it('disqualifying round fills nothing', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A, B] })),
        stepClaims: () => [claim('asks-sponsorship', ['US'], 's1-q2')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(run.stop).toBeUndefined();
      expect(h.answered).toEqual([]);
      expect(run.questions).toEqual([]);
      expect(typed(h)).toEqual([]);
      expect(h.acts().some((a) => /#q[ab]/.test(a))).toBe(false);
      expect(run.disqualification?.[0]?.source).toBe('s1-q2');
      expect(h.stepChecks.map((qs) => qs.map((q) => [q.id, q.label]))).toEqual([
        [
          ['s1-q1', 'Question A'],
          ['s1-q2', 'Question B'],
        ],
      ]);
      expect(run.checks.map((c) => [c.at, c.step])).toEqual([
        ['job-page', null],
        ['step', 1],
      ]);
      // The close-out: Dismiss, then Discard on the save prompt.
      expect(h.acts().slice(-2)).toEqual([
        `click ${DISMISS}`,
        `click ${DISCARD}`,
      ]);
      expect(h.closed()).toBe(true);
    });

    it('a follow-up field can disqualify', async () => {
      const h = harness({
        screens: {
          job: { html: JOB, on: { [EASY_APPLY]: 's0' } },
          s0: { html: synth({ fields: [A] }), on: { '#qa': 's1' } },
          s1: {
            html: synth({ fields: [A, B] }),
            on: { [DISMISS]: 'prompt' },
          },
          ...reviewScreens(),
        },
        stepClaims: (qs) =>
          qs.some((q) => q.id === 's1-q2')
            ? [claim('asks-sponsorship', ['US'], 's1-q2')]
            : [],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(h.stepChecks.map((qs) => qs.map((q) => q.id))).toEqual([
        ['s1-q1'],
        ['s1-q2'],
      ]);
      expect(h.answered.map((q) => q.id)).toEqual(['s1-q1']);
      expect(typed(h)).toEqual(['type #qa ok']);
      expect(run.disqualification?.[0]?.source).toBe('s1-q2');
    });

    it('an offer on the job page exempts a form question', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        jobClaims: [claim('offers-sponsorship', ['DE'])],
        stepClaims: () => [claim('asks-sponsorship', ['DE'], 's1-q1')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(run.disqualification).toBeNull();
      expect(typed(h)).toEqual(['type #qa ok']);
    });

    it('a relocation offer on the job page exempts a location question', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        jobClaims: [claim('offers-relocation', ['DE'])],
        stepClaims: () => [claim('asks-location', ['DE'], 's1-q1')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(run.disqualification).toBeNull();
      expect(typed(h)).toEqual(['type #qa ok']);
    });

    it('a location question disqualifies a round', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        stepClaims: () => [claim('asks-location', ['DE'], 's1-q1')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(h.answered).toEqual([]);
      expect(typed(h)).toEqual([]);
    });

    it('a location requirement on the job page never opens the form', async () => {
      const h = harness({
        screens: fullFlow(),
        jobClaims: [claim('requires-location', ['DE'])],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
      expect(h.acts()).toEqual([]);
    });

    it('an offer in a form question exempts nothing', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        stepClaims: () => [
          claim('offers-sponsorship', ['DE'], 's1-q1'),
          claim('asks-sponsorship', ['DE'], 's1-q1'),
        ],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
    });

    it('disqualification wins over an unknown field', async () => {
      const unknown =
        '<div componentkey="easyApplyFieldFocus_dt"><label for="dt">Visa sponsorship needed from</label><input type="date" id="dt"></div>' +
        '<div componentkey="easyApplyFieldFocus_dn"><input type="date" id="dn"></div>';
      const h = harness({
        screens: checked(synth({ fields: [A, unknown] })),
        stepClaims: () => [claim('asks-sponsorship', ['US'], 's1-u1')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('disqualified');
      expect(run.stop).toBeUndefined();
      // The unlabelled unknown is not sent.
      expect(h.stepChecks).toEqual([
        [
          expect.objectContaining({ id: 's1-q1', label: 'Question A' }),
          {
            id: 's1-u1',
            label: 'Visa sponsorship needed from',
            type: 'date',
            stepTitle: 'Apply to Acme',
          },
        ],
      ]);
      expect(h.answered).toEqual([]);
    });

    it('an unknown field still stops once the check passes', async () => {
      const unknown =
        '<div componentkey="easyApplyFieldFocus_dt"><label for="dt">Start date</label><input type="date" id="dt"></div>';
      const h = harness({
        screens: checked(synth({ fields: [A, unknown] })),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({ kind: 'unknown-field', step: 1 });
      expect(h.stepChecks).toHaveLength(1);
      expect(h.answered).toEqual([]);
    });

    it('a round whose check fails is check-failed, with its calls kept', async () => {
      const h = harness({ screens: checked(synth({ fields: [A] })) });
      h.deps.checkQuestions = async () => {
        throw new CheckFailedError('invalid-claims', [CALL, CALL]);
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({ kind: 'check-failed', step: 1 });
      expect(run.checks.at(-1)).toEqual({
        at: 'step',
        step: 1,
        ok: false,
        claims: [],
        calls: [CALL, CALL],
      });
      expect(h.answered).toEqual([]);
    });

    it('ModelUnavailableError from a round check is an error stop, unrecorded', async () => {
      const h = harness({ screens: checked(synth({ fields: [A] })) });
      h.deps.checkQuestions = async () => {
        throw new ModelUnavailableError('claude is not signed in');
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(run.stop).toMatchObject({
        kind: 'error',
        detail: 'ModelUnavailableError',
        step: 1,
      });
      // Only the job page's check is recorded.
      expect(run.checks.map((c) => [c.at, c.ok])).toEqual([['job-page', true]]);
      expect(h.answered).toEqual([]);
      expect(typed(h)).toEqual([]);
    });

    it('ModelUnavailableError from the job check is an error stop, unrecorded', async () => {
      const h = harness({ screens: fullFlow() });
      h.deps.checkJob = async () => {
        throw new ModelUnavailableError('claude is not signed in');
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(run.stop).toMatchObject({
        kind: 'error',
        detail: 'ModelUnavailableError',
        step: null,
      });
      expect(run.checks).toEqual([]);
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
      expect(h.closed()).toBe(true);
    });

    it('an unclear claim does not disqualify', async () => {
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        jobClaims: [claim('requires-authorization', [])],
        stepClaims: () => [claim('asks-authorization', [], 's1-q1')],
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      expect(run.disqualification).toBeNull();
      expect(run.checks.map((c) => c.claims.length)).toEqual([1, 1]);
    });

    it.each([
      ['passes', false],
      ['fails', true],
    ])('stop during a check is stopped (the check %s)', async (_, fails) => {
      let stop = false;
      const h = harness({
        screens: checked(synth({ fields: [A] })),
        stopWhen: () => (stop ? 'interrupted' : null),
      });
      h.deps.checkQuestions = async () => {
        stop = true;
        if (fails) throw new CheckFailedError('model-error', [CALL]);
        return { claims: [], calls: [CALL] };
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(run.stop).toMatchObject({
        kind: 'bridge',
        detail: 'interrupted',
        step: 1,
      });
      expect(run.checks.at(-1)).toMatchObject({ at: 'step', step: 1 });
      expect(h.answered).toEqual([]);
      // Ctrl+C still dismisses and discards.
      expect(h.acts().slice(-2)).toEqual([
        `click ${DISMISS}`,
        `click ${DISCARD}`,
      ]);
    });

    it('stop during the job check is stopped', async () => {
      let stop = false;
      const h = harness({
        screens: fullFlow(),
        stopWhen: () => (stop ? 'interrupted' : null),
      });
      h.deps.checkJob = async () => {
        stop = true;
        throw new CheckFailedError('model-error', [CALL]);
      };
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
    });

    it('no fresh fields, no check', async () => {
      const h = harness({ screens: fullFlow() });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('reached-review');
      // Three steps with fields; the review page with none gets no check.
      expect(h.stepChecks).toHaveLength(3);
      const empty = harness({ screens: oneStep(synth({})) });
      const r2 = await runApply('123', empty.deps);
      expect(r2.outcome).toBe('reached-review');
      expect(empty.stepChecks).toEqual([]);
    });

    it('fields already filled get no second check', async () => {
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
      expect(h.stepChecks.map((qs) => qs.map((q) => q.id))).toEqual([
        ['s1-q1'],
        ['s1-q2'],
      ]);
      expect(run.questions.map((q) => q.question.id)).toEqual([
        's1-q1',
        's1-q2',
      ]);
    });
  });

  describe('submitting', () => {
    const submitOf = (html: string) => {
      const r = readStep(docOf(html));
      if (r.kind !== 'review' || !r.submit) throw new Error('no submit');
      return r.submit;
    };
    /** review.html's one Submit button. */
    const SUBMIT_SEL = submitOf(REVIEW);
    /** The job page after a submit, with LinkedIn's sent dialog up. */
    const SENT = fixture('job-applied.html');
    const SENT_CLOSE = readSent(docOf(SENT))?.close ?? '';
    /** The applied job page without the sent dialog (a reload). */
    const APPLIED = SENT.replaceAll('Your application was sent', 'Sent');
    /** A review page with two Submit buttons: no single one. */
    const TWO_SUBMITS = synth({
      next: null,
      submit: true,
      extra: '<button id="send2" type="button">Submit application</button>',
    });
    /** fullFlow, with the review's Submit leading to `to`. */
    const flow = (
      to: string,
      more: Record<string, Screen>,
    ): Record<string, Screen> => {
      const f = fullFlow();
      f['review'] = {
        html: REVIEW,
        on: { [DISMISS]: 'prompt', [SUBMIT_SEL]: to },
      };
      return { ...f, ...more };
    };
    /** Submit → the sent dialog → reload → applied. */
    const happy = () =>
      flow('sent', {
        sent: { html: SENT, on: { goto: 'applied' } },
        applied: { html: APPLIED },
      });
    /** Submit takes no effect: the review page, Dismiss and all, stays up. */
    const stays = (): Record<string, Screen> => ({
      ...fullFlow(),
      review: { html: REVIEW, on: { [DISMISS]: 'prompt', goto: 'job' } },
    });

    /** What happened from the `submitting` write on. */
    const fromSubmitting = (h: Harness) =>
      h.order().slice(h.order().indexOf('set submitting'));
    const gotosAfterSubmit = (h: Harness) =>
      fromSubmitting(h).filter((o) => o === 'goto').length;

    it('the fixtures read as the tests need', () => {
      expect(SENT_CLOSE).not.toBe('');
      expect(readSent(docOf(APPLIED))).toBeNull();
      expect(readStep(docOf(TWO_SUBMITS))).toMatchObject({
        kind: 'review',
        submit: null,
      });
    });

    it('writes submitting, clicks Submit once, closes the sent dialog, confirms the marker, records applied', async () => {
      const h = harness({ screens: happy(), submit: true });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(run.stop).toBeUndefined();
      expect(h.sets.map((s) => s.change)).toEqual([
        { status: 'submitting' },
        { status: 'applied', source: 'submit' },
      ]);
      expect(run.record).toMatchObject({ before: null, after: 'applied' });
      expect(fromSubmitting(h)).toEqual([
        'set submitting',
        `click ${SUBMIT_SEL}`,
        `click ${SENT_CLOSE}`,
        'goto',
        'set applied',
      ]);
      expect(h.calls).toContainEqual({
        op: 'click',
        sel: SUBMIT_SEL,
        within: FORM_DIALOG,
      });
      expect(h.calls).toContainEqual({
        op: 'click',
        sel: SENT_CLOSE,
        within: SENT_DIALOG,
      });
      expect(h.submits()).toEqual([SUBMIT_SEL]);
      expect(run.timings.submit).toEqual({
        clickToSentMs: expect.any(Number),
        sentToMarkerMs: expect.any(Number),
      });
      // No form close-out after a submit.
      expect(h.acts()).not.toContain(`click ${DISMISS}`);
      expect(h.acts()).not.toContain(`click ${DISCARD}`);
      expect(h.closed()).toBe(true);
    });

    it('a one-page form fills its fields, then submits', async () => {
      const one = submitOf(ONE_PAGE);
      const h = harness({
        submit: true,
        screens: {
          job: { html: JOB, on: { [EASY_APPLY]: 'form' } },
          form: { html: ONE_PAGE, on: { [one]: 'sent' } },
          sent: { html: SENT, on: { goto: 'applied' } },
          applied: { html: APPLIED },
        },
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(run.questions.length).toBeGreaterThan(2);
      expect(h.submits()).toEqual([one]);
      // Every fill comes before the record write, and the write before Submit.
      const acts = h.calls.filter((c) => c.op !== 'wait');
      const at = acts.findIndex((c) => c.op === 'set');
      expect(acts.slice(0, at).some((c) => c.op === 'type')).toBe(true);
      expect(acts.slice(at + 1).some((c) => c.op === 'type')).toBe(false);
      expect(acts[at + 1]).toMatchObject({ op: 'click', sel: one });
    });

    it('a failed submitting write: no Submit click, safety-stop', async () => {
      const h = harness({
        screens: happy(),
        submit: true,
        setFails: 'submitting',
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({
        kind: 'unexpected-page',
        detail: 'could not write the record',
      });
      expect(h.sets).toEqual([]);
      expect(run.record.after).toBeNull();
      expect(h.submits()).toEqual([]);
      expect(run.timings.submit).toBeNull();
      // Nothing was sent: the form is closed out as on any stop.
      expect(h.acts().slice(-2)).toEqual([
        `click ${DISMISS}`,
        `click ${DISCARD}`,
      ]);
    });

    it.each([
      ['an entry written since', null, entry('failed')],
      [
        'the same status, written again',
        entry('failed'),
        { ...entry('failed'), updatedAt: '2026-11-14T09:00:00.000Z' },
      ],
    ])(
      'a record changed since the start: no Submit click, safety-stop record-changed (%s)',
      async (_name, first, later) => {
        const h = harness({
          screens: happy(),
          submit: true,
          record: first ? { '123': first } : {},
        });
        const store = h.deps.record;
        if (!store) throw new Error('no record');
        let gets = 0;
        h.deps.record = {
          get: (id) => (gets++ === 0 ? store.get(id) : later),
          set: (id, c, at) => store.set(id, c, at),
        };
        const run = await runApply('123', h.deps);
        expect(gets).toBe(2);
        expect(run.outcome).toBe('safety-stop');
        expect(run.stop?.kind).toBe('record-changed');
        expect(h.sets).toEqual([]);
        expect(h.submits()).toEqual([]);
      },
    );

    it('a review with no single Submit button is unexpected-page, no click', async () => {
      const h = harness({
        submit: true,
        screens: {
          job: { html: JOB, on: { [EASY_APPLY]: 'review' } },
          review: { html: TWO_SUBMITS, on: { [DISMISS]: 'gone' } },
          gone: { html: JOB },
        },
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({
        kind: 'unexpected-page',
        detail: 'no single Submit button',
      });
      expect(h.sets).toEqual([]);
      expect(h.submits()).toEqual([]);
    });

    it('a review that loses its single Submit by the fresh read is unexpected-page, no click', async () => {
      const screens = happy();
      const h = harness({
        submit: true,
        screens,
        onSet: (_id, c) => {
          const review = screens['review'];
          if (c.status === 'submitting' && review) review.html = TWO_SUBMITS;
        },
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop).toMatchObject({
        kind: 'unexpected-page',
        detail: 'no single Submit button',
      });
      // Written, never clicked: the next run settles it from the marker.
      expect(run.record.after).toBe('submitting');
      expect(h.submits()).toEqual([]);
      // Submit was never about to go out: the form is closed out as usual.
      expect(fromSubmitting(h)).toEqual([
        'set submitting',
        `click ${DISMISS}`,
        `click ${DISCARD}`,
      ]);
    });

    it('no dialog but the marker on reload is submitted', async () => {
      const h = harness({
        submit: true,
        screens: flow('quiet', {
          // LinkedIn closed its own dialog, or showed none.
          quiet: { html: JOB, on: { goto: 'applied' } },
          applied: { html: APPLIED },
        }),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(h.sets.map((s) => s.change)).toEqual([
        { status: 'submitting' },
        { status: 'applied', source: 'submit' },
      ]);
      expect(fromSubmitting(h)).toEqual([
        'set submitting',
        `click ${SUBMIT_SEL}`,
        'goto',
        'set applied',
      ]);
      expect(run.timings.submit).toEqual({
        clickToSentMs: null,
        sentToMarkerMs: null,
      });
      // It waited out the sent dialog's full wait first.
      expect(
        h.waits().filter((ms) => ms === 500).length,
      ).toBeGreaterThanOrEqual(SENT_WAIT_MS / 500);
    });

    it('a marker that shows on a later poll after the first reload is submitted, with one reload', async () => {
      const h = harness({
        submit: true,
        screens: flow('sent', {
          sent: { html: SENT, on: { goto: 'slow' } },
          // A stable, unapplied job page for 6 reads, then the marker.
          slow: { html: JOB, then: { after: 6, to: 'applied' } },
          applied: { html: APPLIED },
        }),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(h.sets.map((s) => s.change)).toEqual([
        { status: 'submitting' },
        { status: 'applied', source: 'submit' },
      ]);
      expect(gotosAfterSubmit(h)).toBe(1);
      expect(h.waits()).not.toContain(LEFTOVER_RECHECK_MS);
      expect(h.submits()).toEqual([SUBMIT_SEL]);
    });

    it('no marker within MARKER_WAIT_MS: one more reload, then failed submit-unconfirmed', async () => {
      const h = harness({
        submit: true,
        screens: flow('sent', {
          sent: { html: SENT, on: { goto: 'job' } },
        }),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submit-unconfirmed');
      expect(h.sets.map((s) => s.change)).toEqual([
        { status: 'submitting' },
        { status: 'failed', reason: 'submit-unconfirmed' },
      ]);
      expect(run.record.after).toBe('failed');
      expect(gotosAfterSubmit(h)).toBe(2);
      expect(h.waits()).toContain(LEFTOVER_RECHECK_MS);
      // Each reload is polled for the marker for the whole MARKER_WAIT_MS.
      const afterLeftover = h
        .waits()
        .slice(h.waits().indexOf(LEFTOVER_RECHECK_MS) + 1);
      const markerPolls = Array.from(
        { length: MARKER_WAIT_MS / 500 },
        () => 500,
      );
      expect(afterLeftover).toEqual(markerPolls);
      const beforeLeftover = h
        .waits()
        .slice(0, h.waits().indexOf(LEFTOVER_RECHECK_MS));
      expect(beforeLeftover.slice(-MARKER_WAIT_MS / 500)).toEqual(markerPolls);
      expect(h.submits()).toEqual([SUBMIT_SEL]);
      expect(run.timings.submit).toEqual({
        clickToSentMs: expect.any(Number),
        sentToMarkerMs: null,
      });
      expect(h.acts()).not.toContain(`click ${DISMISS}`);
    });

    it('a review page that stays after Submit is never clicked twice', async () => {
      const h = harness({
        submit: true,
        // A reload after it shows the unapplied job page.
        screens: stays(),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submit-unconfirmed');
      expect(h.submits()).toEqual([SUBMIT_SEL]);
      expect(h.acts().filter((a) => a === `click ${SUBMIT_SEL}`)).toHaveLength(
        1,
      );
      expect(h.sets.map((s) => s.change)).toEqual([
        { status: 'submitting' },
        { status: 'failed', reason: 'submit-unconfirmed' },
      ]);
      expect(run.record.after).toBe('failed');
      expect(h.acts()).not.toContain(`click ${DISMISS}`);
      expect(h.acts().filter((a) => a === `click ${EASY_APPLY}`)).toHaveLength(
        1,
      );
    });

    it.each([
      ['interrupted', 'the sent dialog', happy],
      ['the bridge went away', 'the sent dialog', happy],
      ['interrupted', 'the form still up', stays],
      ['the bridge went away', 'the form still up', stays],
    ])(
      'a stop after the Submit click leaves submitting and presses nothing more (%s, %s)',
      async (reason, _page, screens) => {
        const h = harness({
          submit: true,
          author: [],
          screens: screens(),
          stopWhen: (calls) =>
            calls.some((c) => c.op === 'click' && c.sel === SUBMIT_SEL)
              ? reason
              : null,
        });
        const run = await runApply('123', h.deps);
        expect(run.outcome).toBe('stopped');
        expect(run.stop).toMatchObject({ kind: 'bridge', detail: reason });
        expect(run.record.after).toBe('submitting');
        expect(h.sets.map((s) => s.change)).toEqual([{ status: 'submitting' }]);
        expect(h.acts().at(-1)).toBe(`click ${SUBMIT_SEL}`);
        expect(fromSubmitting(h)).toEqual([
          'set submitting',
          `click ${SUBMIT_SEL}`,
        ]);
        expect(h.asked).toEqual([]);
        expect(h.closed()).toBe(true);
      },
    );

    it('a security check after the Submit click asks nothing and presses nothing more', async () => {
      const h = harness({
        submit: true,
        author: [],
        screens: flow('check', {
          check: { html: REVIEW, path: '/checkpoint/challenge/' },
        }),
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('safety-stop');
      expect(run.stop?.kind).toBe('security-check');
      expect(run.record.after).toBe('submitting');
      expect(fromSubmitting(h)).toEqual([
        'set submitting',
        `click ${SUBMIT_SEL}`,
      ]);
      expect(h.asked).toEqual([]);
      expect(h.closed()).toBe(true);
    });

    it('a stop between the record write and the click leaves submitting, no click', async () => {
      const h = harness({
        submit: true,
        author: [],
        screens: happy(),
        stopWhen: (calls) =>
          calls.some((c) => c.op === 'set' && c.sel === 'submitting')
            ? 'interrupted'
            : null,
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('stopped');
      expect(run.record.after).toBe('submitting');
      expect(h.submits()).toEqual([]);
      // Nothing pressed after the write: no Submit, no Dismiss, no Discard.
      expect(fromSubmitting(h)).toEqual(['set submitting']);
      expect(h.asked).toEqual([]);
      expect(h.closed()).toBe(true);
    });

    it('an applied write that fails still reports submitted', async () => {
      const h = harness({
        screens: happy(),
        submit: true,
        setFails: 'applied',
      });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(run.stop).toBeUndefined();
      expect(run.record).toMatchObject({ before: null, after: 'submitting' });
      expect(h.sets.map((s) => s.change)).toEqual([{ status: 'submitting' }]);
      expect(h.submits()).toEqual([SUBMIT_SEL]);
    });

    it.each([
      ['review.html', REVIEW],
      ['review-one-page.html', ONE_PAGE],
      ['review-save-prompt.html', SAVE_PROMPT],
      ['a synthetic review', synth({ next: null, submit: true })],
    ])(
      'a dry run on review never writes submitting and never clicks Submit (%s)',
      async (_name, html) => {
        const h = harness({
          screens: {
            job: { html: JOB, on: { [EASY_APPLY]: 'review' } },
            review: { html, on: { [DISMISS]: 'prompt' } },
            prompt: { html: SAVE_PROMPT, on: { [DISCARD]: 'gone' } },
            gone: { html: JOB },
          },
        });
        const run = await runApply('123', h.deps);
        expect(['reached-review', 'safety-stop']).toContain(run.outcome);
        expect(h.sets).toEqual([]);
        expect(h.submits()).toEqual([]);
        expect(run.timings.submit).toBeNull();
      },
    );

    it('in author mode a submitted run asks no Enter before closing', async () => {
      const h = harness({ screens: happy(), submit: true, author: [] });
      const run = await runApply('123', h.deps);
      expect(run.outcome).toBe('submitted');
      expect(h.asked).toEqual([]);
      expect(h.closed()).toBe(true);
    });
  });
});
