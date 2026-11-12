import { describe, expect, it } from 'vitest';
import { checkCandidate, type CheckResult } from './checks.js';
import { fillPlaceholders, matchOption, sourceText } from './sources.js';
import { bank, job } from './testing/bank.js';
import type {
  AnswerContext,
  Candidate,
  FormQuestion,
  Source,
} from './types.js';

type Answer = Extract<Candidate, { outcome: 'answer' }>;

const ctx = {
  bank,
  job,
  runDate: '2026-11-12',
  models: { answerModel: 'm', verifyModel: 'm', maxRegenerations: 1 },
  caller: {},
} as unknown as AnswerContext;

const q = (over: Partial<FormQuestion> = {}): FormQuestion => ({
  id: 'q1',
  label: 'A question',
  type: 'text',
  required: true,
  ...over,
});
const ans = (over: Partial<Answer>): Answer => ({
  outcome: 'answer',
  value: 'x',
  sources: [],
  derivation: 'composed',
  inferences: [],
  ...over,
});
const check = (question: FormQuestion, c: Answer, runDate = ctx.runDate) =>
  checkCandidate(question, c, { ...ctx, runDate });
const fails = (r: CheckResult, detail: string) =>
  expect(r).toEqual({ ok: false, detail });

const sponsorship: Source = { kind: 'answer', id: 'sponsorship-future' };
const salary: Source = { kind: 'answer', id: 'salary-expectation-monthly-usd' };
const aiPerspective: Source = { kind: 'answer', id: 'ai-perspective' };
const whyThisRole: Source = { kind: 'answer', id: 'why-this-role' };
const authorFact: Source = {
  kind: 'fact',
  text: 'I am currently a Backend Engineer at Example Ltd, employed full-time.',
};
const runDate: Source = { kind: 'run-date' };

describe('sourceText', () => {
  it('reads each kind of source', () => {
    expect(sourceText({ kind: 'field', key: 'email' }, ctx)).toBe(
      'sam@example.com',
    );
    expect(sourceText({ kind: 'field', key: 'fullName' }, ctx)).toBe(
      'Sam Example',
    );
    expect(sourceText({ kind: 'field', key: 'phone' }, ctx)).toBe(
      '+44 7700900123',
    );
    expect(sourceText({ kind: 'field', key: 'website' }, ctx)).toBeNull();
    expect(
      sourceText({ kind: 'fact', text: 'I am willing to relocate.' }, ctx),
    ).toBe('I am willing to relocate.');
    expect(sourceText(salary, ctx)).toBe('5000 USD per month');
    expect(
      sourceText({ kind: 'story', id: 'missed-launch-date' }, ctx),
    ).toContain('payments launch');
    expect(sourceText(runDate, ctx)).toBe('2026-11-12');
  });
  it('fills placeholders in answers', () => {
    expect(sourceText(whyThisRole, ctx)).toBe(
      'I want to work on the Backend Engineer role at Acme Payments, found through LinkedIn.',
    );
  });
  it('returns null for sources that do not exist', () => {
    expect(sourceText({ kind: 'answer', id: 'nope' }, ctx)).toBeNull();
    expect(sourceText({ kind: 'story', id: 'nope' }, ctx)).toBeNull();
    expect(
      sourceText({ kind: 'fact', text: 'I am willing to relocate' }, ctx),
    ).toBeNull();
    expect(
      sourceText({ kind: 'job-post', quote: 'We use Rust' }, ctx),
    ).toBeNull();
    expect(sourceText({ kind: 'job-post', quote: '  ' }, ctx)).toBeNull();
  });
  it('needs a variant index exactly when the answer has variants', () => {
    const rate = 'contractor-rate';
    expect(sourceText({ kind: 'answer', id: rate }, ctx)).toBeNull();
    expect(
      sourceText({ kind: 'answer', id: rate, variant: 3 }, ctx),
    ).toBeNull();
    expect(
      sourceText({ kind: 'answer', id: rate, variant: -1 }, ctx),
    ).toBeNull();
    expect(sourceText({ kind: 'answer', id: rate, variant: 0 }, ctx)).toBe(
      '30 USD per hour',
    );
    expect(sourceText({ ...salary, variant: 0 } as Source, ctx)).toBeNull();
  });
  it('accepts a job-post quote that differs only in whitespace', () => {
    const quote =
      'run services on   Kubernetes and\ntake part in daily code review';
    expect(sourceText({ kind: 'job-post', quote }, ctx)).toBe(
      'run services on Kubernetes and take part in daily code review',
    );
  });
});

describe('fillPlaceholders and matchOption', () => {
  it('fills all three placeholders, every occurrence', () => {
    expect(
      fillPlaceholders('{company} {company} {jobTitle} {source}', job),
    ).toBe('Acme Payments Acme Payments Backend Engineer LinkedIn');
  });
  it('matches options by trim and case and returns the offered string', () => {
    expect(matchOption(' yes ', ['Yes', 'No'])).toBe('Yes');
    expect(matchOption('maybe', ['Yes', 'No'])).toBeNull();
  });
});

describe('checkCandidate: sources', () => {
  it('fails an unknown source', () => {
    fails(
      check(q(), ans({ sources: [{ kind: 'answer', id: 'nope' }] })),
      'unknown source',
    );
  });
  it('fails when the source is only the job post', () => {
    const quote =
      'run services on Kubernetes and take part in daily code review';
    const r = check(
      q({ type: 'textarea' }),
      ans({ sources: [{ kind: 'job-post', quote }] }),
    );
    expect(r).toEqual({ ok: false, detail: 'no source about the author' });
  });
  it('fails a job post plus run date, and no sources at all', () => {
    const quote = 'daily code review';
    fails(
      check(q(), ans({ sources: [{ kind: 'job-post', quote }, runDate] })),
      'no source about the author',
    );
    fails(check(q(), ans({ sources: [] })), 'no source about the author');
  });
  it('lets a job post back a company claim next to an author source', () => {
    const quote = 'daily code review';
    expect(
      check(
        q(),
        ans({
          value: 'I enjoy code review.',
          sources: [authorFact, { kind: 'job-post', quote }],
        }),
      ),
    ).toEqual({ ok: true, value: 'I enjoy code review.' });
  });
});

describe('checkCandidate: choices', () => {
  const radio = q({ type: 'radio', options: ['Yes', 'No'] });
  it('normalizes whitespace and case to the offered option', () => {
    expect(
      check(
        radio,
        ans({ value: 'yes ', derivation: 'fitted', sources: [sponsorship] }),
      ),
    ).toEqual({ ok: true, value: 'Yes' });
  });
  it('fails a value that is not offered', () => {
    fails(
      check(
        radio,
        ans({ value: 'Maybe', derivation: 'fitted', sources: [sponsorship] }),
      ),
      'option not offered',
    );
  });
  it('fails a choice question without options', () => {
    fails(
      check(
        q({ type: 'select' }),
        ans({ value: 'Yes', derivation: 'fitted', sources: [sponsorship] }),
      ),
      'option not offered',
    );
  });
  it('does not check numbers in a choice value', () => {
    const select = q({
      type: 'select',
      options: ['1 to 3 years', '4 to 6 years'],
    });
    expect(
      check(
        select,
        ans({
          value: '4 to 6 years',
          derivation: 'bucket',
          sources: [authorFact],
        }),
      ),
    ).toEqual({ ok: true, value: '4 to 6 years' });
  });
  it('accepts a checkbox group subset and normalizes it', () => {
    const group = q({
      type: 'checkbox-group',
      options: ['Go', 'Rust', 'Python'],
    });
    expect(
      check(
        group,
        ans({
          value: ['go ', 'PYTHON'],
          derivation: 'bucket',
          sources: [authorFact],
        }),
      ),
    ).toEqual({ ok: true, value: ['Go', 'Python'] });
  });
  it('fails a checkbox group with an unoffered or duplicate item', () => {
    const group = q({ type: 'checkbox-group', options: ['Go', 'Rust'] });
    const base = {
      derivation: 'bucket',
      sources: [authorFact],
    } satisfies Partial<Answer>;
    fails(
      check(group, ans({ ...base, value: ['Go', 'Java'] })),
      'option not offered',
    );
    fails(
      check(group, ans({ ...base, value: ['Go', 'go'] })),
      'option not offered',
    );
  });
  it('allows an empty checkbox group only when not required', () => {
    const base = {
      derivation: 'bucket',
      sources: [authorFact],
      value: [],
    } satisfies Partial<Answer>;
    const group = q({ type: 'checkbox-group', options: ['Go'] });
    expect(check({ ...group, required: false }, ans(base))).toEqual({
      ok: true,
      value: [],
    });
    fails(check(group, ans(base)), 'empty required answer');
  });
  it('fails values of the wrong shape', () => {
    fails(
      check(
        radio,
        ans({ value: ['Yes'], derivation: 'fitted', sources: [sponsorship] }),
      ),
      'wrong value shape',
    );
    fails(
      check(
        q({ type: 'checkbox-group', options: ['Go'] }),
        ans({ value: 'Go', sources: [authorFact] }),
      ),
      'wrong value shape',
    );
    fails(
      check(q({ type: 'text' }), ans({ value: ['a'], sources: [authorFact] })),
      'wrong value shape',
    );
    fails(
      check(q({ type: 'number' }), ans({ value: ['5'], sources: [salary] })),
      'wrong value shape',
    );
    fails(
      check(q({ type: 'mystery' }), ans({ value: 'a', sources: [authorFact] })),
      'wrong value shape',
    );
  });
});

describe('checkCandidate: numbers and number fields', () => {
  const number = q({ type: 'number' });
  const fitted = (value: string) =>
    ans({ value, derivation: 'fitted', sources: [salary] });
  it('accepts a bare number that is in the source', () => {
    expect(check(number, fitted('5000'))).toEqual({ ok: true, value: '5000' });
  });
  it('rejects anything that is not just a number', () => {
    for (const v of ['5,000', '5000.00x', '5000 USD', '', '-5000']) {
      expect(check(number, fitted(v)).ok, v).toBe(false);
    }
  });
  it('rejects a number that is not in the cited answer', () => {
    fails(check(number, fitted('6000')), 'number not in sources');
  });
  it('fails a not-a-number value with that detail, and never repeats it', () => {
    const failing = check(number, fitted('5,000'));
    fails(failing, 'not a number');
    expect(JSON.stringify(failing)).not.toContain('5,000');
  });
  it('rejects an added number in composed text', () => {
    fails(
      check(
        q({ type: 'textarea' }),
        ans({ value: 'I cut review time by 30%.', sources: [aiPerspective] }),
      ),
      'number not in sources',
    );
  });
  it('rejects added number words', () => {
    fails(
      check(
        q({ type: 'textarea' }),
        ans({ value: 'I led five teams.', sources: [aiPerspective] }),
      ),
      'number not in sources',
    );
  });
  it('fitted numbers must come from the cited answer, not other sources', () => {
    fails(
      check(
        q({ type: 'text' }),
        ans({
          value: 'about 2021',
          derivation: 'fitted',
          sources: [salary, runDate],
        }),
      ),
      'number not in sources',
    );
  });
  it('allows numbers from a cited story, fact and job post', () => {
    expect(
      check(
        q({ type: 'textarea' }),
        ans({
          value: 'The launch slipped two weeks.',
          sources: [{ kind: 'story', id: 'missed-launch-date' }],
        }),
      ),
    ).toEqual({ ok: true, value: 'The launch slipped two weeks.' });
  });
  it('allows the run date numbers only when a run-date source is cited', () => {
    const value = 'As of 2026 I build backends.';
    fails(
      check(q({ type: 'text' }), ans({ value, sources: [authorFact] })),
      'number not in sources',
    );
    expect(
      check(
        q({ type: 'text' }),
        ans({ value, sources: [authorFact, runDate] }),
      ),
    ).toEqual({
      ok: true,
      value,
    });
  });
});

describe('checkCandidate: as-written', () => {
  it('accepts the answer text with placeholders filled, apart from surrounding whitespace', () => {
    const value =
      '  I want to work on the Backend Engineer role at Acme Payments, found through LinkedIn. \n';
    expect(
      check(
        q({ type: 'textarea' }),
        ans({ value, derivation: 'as-written', sources: [whyThisRole] }),
      ),
    ).toEqual({
      ok: true,
      value: value.trim(),
    });
  });
  it('accepts a variant', () => {
    expect(
      check(
        q({ type: 'text' }),
        ans({
          value: '5000 USD per month',
          derivation: 'as-written',
          sources: [{ kind: 'answer', id: 'contractor-rate', variant: 1 }],
        }),
      ),
    ).toEqual({ ok: true, value: '5000 USD per month' });
  });
  it('fails any change to the text', () => {
    fails(
      check(
        q({ type: 'text' }),
        ans({
          value: '5000 USD a month',
          derivation: 'as-written',
          sources: [salary],
        }),
      ),
      'not as written',
    );
  });
  it('needs exactly one answer source', () => {
    fails(
      check(
        q({ type: 'text' }),
        ans({
          value: '5000 USD per month',
          derivation: 'as-written',
          sources: [salary, sponsorship],
        }),
      ),
      'not as written',
    );
    fails(
      check(
        q({ type: 'text' }),
        ans({
          value: 'I am willing to relocate.',
          derivation: 'as-written',
          sources: [{ kind: 'fact', text: 'I am willing to relocate.' }],
        }),
      ),
      'not as written',
    );
  });
});

describe('checkCandidate: placeholders', () => {
  it('fails an unfilled placeholder before anything else', () => {
    fails(
      check(
        q({ type: 'textarea' }),
        ans({ value: 'I want to join {company}', sources: [whyThisRole] }),
      ),
      'unfilled placeholder',
    );
  });
  it('fails a stray brace', () => {
    fails(
      check(q(), ans({ value: 'a } b', sources: [authorFact] })),
      'unfilled placeholder',
    );
  });
});

describe('checkCandidate: field limits', () => {
  const base = { sources: [authorFact] };
  it('fails an empty required answer, allows an empty optional one', () => {
    fails(check(q(), ans({ ...base, value: '  ' })), 'empty required answer');
    expect(check(q({ required: false }), ans({ ...base, value: '' }))).toEqual({
      ok: true,
      value: '',
    });
  });
  it('fails an answer over maxLength and never cuts it', () => {
    const value = 'I am a Backend Engineer.';
    fails(check(q({ maxLength: 10 }), ans({ ...base, value })), 'too long');
    expect(
      check(q({ maxLength: value.length }), ans({ ...base, value })),
    ).toEqual({ ok: true, value });
  });
});

describe('checkCandidate: file', () => {
  const resume: Source = { kind: 'field', key: 'resume' };
  it('accepts the resume path with a resume source', () => {
    expect(
      check(
        q({ type: 'file' }),
        ans({
          value: bank.fields.resume,
          derivation: 'as-written',
          sources: [resume],
        }),
      ),
    ).toEqual({ ok: true, value: bank.fields.resume });
  });
  it('fails another path, or no resume source', () => {
    fails(
      check(
        q({ type: 'file' }),
        ans({ value: '/tmp/other.pdf', sources: [resume] }),
      ),
      'not the resume',
    );
    fails(
      check(
        q({ type: 'file' }),
        ans({ value: bank.fields.resume, sources: [authorFact] }),
      ),
      'not the resume',
    );
    fails(
      check(
        q({ type: 'file' }),
        ans({ value: [bank.fields.resume], sources: [resume] }),
      ),
      'wrong value shape',
    );
  });
});

describe('checkCandidate: math', () => {
  const number = q({ type: 'number' });
  const since = (year: number, month?: number): Answer['math'] => ({
    kind: 'years-since',
    year,
    month,
  });
  const kube: Source = {
    kind: 'fact',
    text: 'I have used Kubernetes in production since March 2021.',
  };
  const withKubeFact = {
    ...ctx,
    bank: { ...bank, facts: [...bank.facts, { text: kube.text, tags: [] }] },
  };
  const years = (value: string, math: Answer['math'], when = '2026-11-12') =>
    checkCandidate(
      number,
      ans({ value, derivation: 'math', sources: [kube], math }),
      { ...withKubeFact, runDate: when },
    );

  it('years-since passes when the date is in a cited source and the value matches', () => {
    expect(years('5', since(2021, 3))).toEqual({ ok: true, value: '5' });
    expect(years('4', since(2021, 3), '2026-02-01')).toEqual({
      ok: true,
      value: '4',
    });
    expect(years('5', since(2021))).toEqual({ ok: true, value: '5' });
  });
  it('years-since fails a wrong value, a year or month not in the sources, or no math', () => {
    fails(years('6', since(2021, 3)), 'math does not match');
    fails(years('5', since(2019, 3)), 'number not in sources');
    fails(years('5', since(2021, 6)), 'number not in sources');
    fails(years('5', since(2021, 13)), 'number not in sources');
    fails(years('5', undefined), 'math missing');
  });
  it('years-since fails a start date after the run date', () => {
    fails(years('0', since(2021, 3), '2020-01-01'), 'math does not match');
  });

  const arith = (
    value: string,
    expression: string,
    sources: Source[] = [salary, runDate],
  ) =>
    check(
      number,
      ans({
        value,
        derivation: 'math',
        sources,
        math: { kind: 'arithmetic', expression },
      }),
    );
  it('arithmetic passes when every number is allowed and the floored result matches', () => {
    expect(arith('2', '5000 / 2026')).toEqual({ ok: true, value: '2' });
    expect(arith('3', '(5000 + 2026) / 2026')).toEqual({
      ok: true,
      value: '3',
    });
  });
  it('arithmetic fails a wrong result, a number not in sources, or a bad expression', () => {
    fails(arith('3', '5000 / 2026'), 'math does not match');
    fails(arith('12', '5000 / 2026 * 6'), 'number not in sources');
    fails(arith('2', '5000 /'), 'math does not match');
    fails(arith('2', 'alert(1)'), 'math does not match');
    fails(arith('2', '5000 / 0'), 'math does not match');
  });
  it('arithmetic needs a run-date source for run-date numbers', () => {
    fails(arith('2', '5000 / 2026', [salary]), 'number not in sources');
  });
  it('a math value must be a bare whole number', () => {
    const r = check(
      q({ type: 'text' }),
      ans({
        value: '2 years',
        derivation: 'math',
        sources: [salary, runDate],
        math: { kind: 'arithmetic', expression: '5000 / 2026' },
      }),
    );
    fails(r, 'math does not match');
  });
});
