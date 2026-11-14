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
  it('fails a job-post quote shorter than 3 words', () => {
    for (const quote of ['Kubernetes', 'code review']) {
      fails(
        check(
          q(),
          ans({
            value: 'I enjoy code review.',
            sources: [authorFact, { kind: 'job-post', quote }],
          }),
        ),
        'unknown source',
      );
    }
  });
  it('needs every inference source to exist and be among the cited sources', () => {
    const story: Source = { kind: 'story', id: 'missed-launch-date' };
    const withInference = (source: Source, sources: Source[]) =>
      check(
        q({ type: 'textarea' }),
        ans({
          value: 'I own my deadlines.',
          sources,
          inferences: [{ claim: 'I own my deadlines', source }],
        }),
      );
    expect(withInference(story, [authorFact, story])).toEqual({
      ok: true,
      value: 'I own my deadlines.',
    });
    expect(
      withInference(
        {
          kind: 'fact',
          text: ' I am currently a Backend Engineer at Example Ltd, employed full-time. ',
        },
        [authorFact],
      ),
    ).toEqual({ ok: true, value: 'I own my deadlines.' });
    fails(withInference(story, [authorFact]), 'unknown source');
    fails(
      withInference({ kind: 'story', id: 'nope' }, [authorFact]),
      'unknown source',
    );
    fails(
      withInference({ kind: 'answer', id: 'contractor-rate', variant: 1 }, [
        authorFact,
        { kind: 'answer', id: 'contractor-rate', variant: 0 },
      ]),
      'unknown source',
    );
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
  it('fails a choice that contradicts the cited answer', () => {
    for (const derivation of ['as-written', 'fitted'] as const) {
      fails(
        check(radio, ans({ value: 'No', derivation, sources: [sponsorship] })),
        'not as written',
      );
      expect(
        check(radio, ans({ value: 'Yes', derivation, sources: [sponsorship] })),
      ).toEqual({ ok: true, value: 'Yes' });
    }
  });
  it('as-written on a choice needs exactly one answer source', () => {
    fails(
      check(
        radio,
        ans({ value: 'Yes', derivation: 'as-written', sources: [authorFact] }),
      ),
      'not as written',
    );
  });
  it('fitted on a choice whose cited answer is not an option is left to the option check', () => {
    expect(
      check(
        radio,
        ans({ value: 'No', derivation: 'fitted', sources: [salary] }),
      ),
    ).toEqual({ ok: true, value: 'No' });
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
        q({ type: 'number' }),
        ans({
          value: '2026',
          derivation: 'fitted',
          sources: [salary, runDate],
        }),
      ),
      'number not in sources',
    );
  });
  it('reads magnitudes when checking numbers', () => {
    const fiveEngineers: Source = {
      kind: 'fact',
      text: 'I am comfortable leading code reviews for a team of five engineers.',
    };
    fails(
      check(
        q({ type: 'textarea' }),
        ans({ value: 'I ran a $5M budget.', sources: [fiveEngineers] }),
      ),
      'number not in sources',
    );
    expect(
      check(
        q({ type: 'textarea' }),
        ans({ value: 'I expect about 5k USD a month.', sources: [salary] }),
      ),
    ).toEqual({ ok: true, value: 'I expect about 5k USD a month.' });
  });
  it('allows numbers from a cited story', () => {
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
  it('never lets a job-post number back a number about the author', () => {
    const goJob = {
      ...ctx,
      job: {
        ...job,
        description: `${job.description} You have 5+ years of Go experience.`,
      },
    };
    const post: Source = {
      kind: 'job-post',
      quote: '5+ years of Go experience',
    };
    fails(
      checkCandidate(
        q({ type: 'textarea' }),
        ans({ value: 'I have 5 years of Go.', sources: [authorFact, post] }),
        goJob,
      ),
      'number not in sources',
    );
    fails(
      checkCandidate(
        q({ type: 'number' }),
        ans({
          value: '5',
          derivation: 'math',
          sources: [authorFact, post],
          math: { kind: 'arithmetic', expression: '5' },
        }),
        goJob,
      ),
      'number not in sources',
    );
  });
  it('never allows the run date numbers as free numbers in a value', () => {
    for (const value of [
      'As of 2026 I build backends.',
      'I have 12 years of experience.',
    ]) {
      for (const sources of [[authorFact], [authorFact, runDate]]) {
        fails(
          check(q({ type: 'text' }), ans({ value, sources })),
          'number not in sources',
        );
      }
    }
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

describe('checkCandidate: fitted on text', () => {
  const fitted = (type: string, value: string, sources: Source[]) =>
    check(q({ type }), ans({ value, derivation: 'fitted', sources }));
  it('accepts a bare number from the one cited answer', () => {
    for (const type of ['text', 'textarea', 'typeahead']) {
      expect(fitted(type, '5000', [salary])).toEqual({
        ok: true,
        value: '5000',
      });
    }
  });
  it('fails a fitted sentence', () => {
    fails(
      fitted('textarea', 'I expect 5000 USD per month.', [salary]),
      'not as written',
    );
    fails(fitted('text', '5000 USD', [salary]), 'not as written');
  });
  it('fails a number that is not in the cited answer, or not exactly one answer', () => {
    fails(fitted('text', '6000', [salary]), 'not as written');
    fails(fitted('text', '5000', [authorFact]), 'not as written');
    fails(fitted('text', '5000', [salary, sponsorship]), 'not as written');
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

describe('checkCandidate: math on a choice', () => {
  const kube: Source = {
    kind: 'fact',
    text: 'I have used Kubernetes in production since March 2021.',
  };
  const withKube = {
    ...ctx,
    bank: { ...bank, facts: [...bank.facts, { text: kube.text, tags: [] }] },
  };
  const pickWithMath = (
    options: string[],
    value: string,
    math: Answer['math'] = { kind: 'years-since', year: 2021, month: 3 },
  ) =>
    checkCandidate(
      q({ type: 'select', options }),
      ans({ value, derivation: 'bucket', sources: [kube, runDate], math }),
      withKube,
    );
  const buckets = ['0-2 years', '3-5 years', '6+ years'];

  it('passes the option whose range holds the computed number', () => {
    expect(pickWithMath(buckets, '3-5 years')).toEqual({
      ok: true,
      value: '3-5 years',
    });
  });
  it('fails an option whose range does not hold it', () => {
    fails(pickWithMath(buckets, '6+ years'), 'math does not match');
    fails(pickWithMath(buckets, '0-2 years'), 'math does not match');
  });
  it('runs the math checks themselves on a choice', () => {
    fails(
      pickWithMath(buckets, '3-5 years', {
        kind: 'years-since',
        year: 2019,
        month: 3,
      }),
      'number not in sources',
    );
    fails(
      pickWithMath(buckets, '3-5 years', { kind: 'years-since', year: 2021 }),
      'math does not match',
    );
  });
  it('leaves an option it cannot read to the verifier', () => {
    const options = ['Junior', 'Mid-level', 'Senior'];
    expect(pickWithMath(options, 'Senior')).toEqual({
      ok: true,
      value: 'Senior',
    });
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
  const inlineFact = (text: string) => ({ kind: 'fact' as const, text });
  const withFacts = (...texts: string[]) => ({
    ...ctx,
    bank: {
      ...bank,
      facts: [...bank.facts, ...texts.map((text) => ({ text, tags: [] }))],
    },
  });
  const sinceFact = inlineFact('I have written Go since 2021.');
  const yearOnly = (value: string, math: Answer['math']) =>
    checkCandidate(
      number,
      ans({ value, derivation: 'math', sources: [sinceFact], math }),
      withFacts(sinceFact.text),
    );
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
  });
  it('years-since fails a wrong value, a year or month not in the sources, or no math', () => {
    fails(years('6', since(2021, 3)), 'math does not match');
    fails(years('5', since(2019, 3)), 'number not in sources');
    fails(years('5', since(2021, 6)), 'number not in sources');
    fails(years('5', since(2021, 13)), 'number not in sources');
    fails(years('5', undefined), 'math missing');
  });
  it('years-since without a month works on a year-only fact', () => {
    expect(yearOnly('5', since(2021))).toEqual({ ok: true, value: '5' });
    fails(yearOnly('5', since(2021, 3)), 'number not in sources');
  });
  it('years-since fails when the source has a month and the month is dropped', () => {
    const december = inlineFact('I have used Go since December 2021.');
    const r = checkCandidate(
      number,
      ans({
        value: '5',
        derivation: 'math',
        sources: [december],
        math: since(2021),
      }),
      withFacts(december.text),
    );
    fails(r, 'math does not match');
    fails(
      checkCandidate(
        number,
        ans({
          value: '4',
          derivation: 'math',
          sources: [december],
          math: since(2021),
        }),
        withFacts(december.text),
      ),
      'math does not match',
    );
    expect(
      checkCandidate(
        number,
        ans({
          value: '4',
          derivation: 'math',
          sources: [december],
          math: since(2021, 12),
        }),
        withFacts(december.text),
      ),
    ).toEqual({ ok: true, value: '4' });
  });
  it('years-since reads a numeric month next to the year', () => {
    for (const written of ['03/2021', '3/2021', '2021-03', '2021/03']) {
      const numeric = inlineFact(`I have used Go since ${written}.`);
      const run = (value: string, math: Answer['math']) =>
        checkCandidate(
          number,
          ans({ value, derivation: 'math', sources: [numeric], math }),
          withFacts(numeric.text),
        );
      expect(run('5', since(2021, 3)), written).toEqual({
        ok: true,
        value: '5',
      });
      fails(run('5', since(2021)), 'math does not match');
      fails(run('5', since(2021, 4)), 'number not in sources');
    }
  });
  it('years-since needs the month and year together in one author text', () => {
    const apart = inlineFact(
      'I may have started in 2021, and I studied in March.',
    );
    fails(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [apart],
          math: since(2021, 5),
        }),
        withFacts(apart.text),
      ),
      'number not in sources',
    );
    fails(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [apart],
          math: since(2021, 3),
        }),
        withFacts(apart.text),
      ),
      'number not in sources',
    );
    const comma = inlineFact('I started with Go in mar, 2021.');
    expect(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [comma],
          math: since(2021, 3),
        }),
        withFacts(comma.text),
      ),
    ).toEqual({ ok: true, value: '5' });
  });
  it('years-since takes its year from a fact, answer or story only', () => {
    const jobWithYear = {
      ...ctx,
      job: { ...job, description: `${job.description} We use Go since 2021.` },
    };
    const post: Source = { kind: 'job-post', quote: 'We use Go since 2021.' };
    fails(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [authorFact, post],
          math: since(2021),
        }),
        jobWithYear,
      ),
      'number not in sources',
    );
    fails(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [authorFact, runDate],
          math: since(2026),
        }),
        ctx,
      ),
      'number not in sources',
    );
  });
  it('years-since fails a start date after the run date', () => {
    fails(years('0', since(2021, 3), '2020-01-01'), 'math does not match');
  });

  const hourly: Source = { kind: 'answer', id: 'contractor-rate', variant: 0 };
  const arith = (
    value: string,
    expression: string,
    sources: Source[] = [salary, hourly],
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
    expect(arith('166', '5000 / 30')).toEqual({ ok: true, value: '166' });
    expect(arith('167', '(5000 + 30) / 30')).toEqual({
      ok: true,
      value: '167',
    });
  });
  it('arithmetic fails a wrong result, a number not in sources, or a bad expression', () => {
    fails(arith('167', '5000 / 30'), 'math does not match');
    fails(arith('1000', '5000 / 30 * 6'), 'number not in sources');
    fails(arith('2', '5000 /'), 'math does not match');
    fails(arith('2', 'alert(1)'), 'math does not match');
    fails(arith('2', '5000 / 0'), 'math does not match');
  });
  it('arithmetic never uses run-date numbers, even with a run-date source', () => {
    fails(arith('2', '5000 / 2026', [salary]), 'number not in sources');
    fails(
      arith('2', '5000 / 2026', [salary, runDate]),
      'number not in sources',
    );
  });
  it('arithmetic cannot stand in for years-since', () => {
    // "since December 2021" on 2026-11-12 is 4 years; 2026 - 2021 would say 5.
    const december = inlineFact(
      'I have used Kubernetes in production since December 2021.',
    );
    fails(
      checkCandidate(
        number,
        ans({
          value: '5',
          derivation: 'math',
          sources: [december, runDate],
          math: { kind: 'arithmetic', expression: '2026 - 2021' },
        }),
        withFacts(december.text),
      ),
      'number not in sources',
    );
    expect(
      checkCandidate(
        number,
        ans({
          value: '4',
          derivation: 'math',
          sources: [december, runDate],
          math: since(2021, 12),
        }),
        withFacts(december.text),
      ),
    ).toEqual({ ok: true, value: '4' });
  });
  it('a math value must be a bare whole number', () => {
    const r = check(
      q({ type: 'text' }),
      ans({
        value: '166 per hour',
        derivation: 'math',
        sources: [salary, hourly],
        math: { kind: 'arithmetic', expression: '5000 / 30' },
      }),
    );
    fails(r, 'math does not match');
  });
});

describe('checkCandidate: date-offset', () => {
  const date = q({ label: 'Earliest start date', type: 'date' });
  const notice: Source = {
    kind: 'fact',
    text: 'My notice period is one week.',
  };
  const offset = (
    amount: number,
    unit: 'day' | 'week' | 'month',
  ): Answer['math'] => ({ kind: 'date-offset', amount, unit });
  const start = (value: string, math = offset(1, 'week'), question = date) =>
    check(
      question,
      ans({ value, derivation: 'math', sources: [notice, runDate], math }),
    );

  it('passes when the value is the run date plus the cited period', () => {
    expect(start('2026-11-19')).toEqual({ ok: true, value: '2026-11-19' });
  });
  it('fails a value that is not the computed date', () => {
    fails(start('2026-11-20'), 'math does not match');
  });
  it('fails an amount not in the cited fact', () => {
    fails(start('2026-11-26', offset(2, 'week')), 'number not in sources');
  });
  it('fails a unit not in the cited fact', () => {
    fails(start('2026-12-12', offset(1, 'month')), 'math does not match');
  });
  it('fails a date-offset on a question that is not a date', () => {
    fails(start('2026-11-19', offset(1, 'week'), q()), 'math does not match');
    fails(
      start('5', offset(1, 'week'), q({ type: 'number' })),
      'math does not match',
    );
  });
  it('fails other math kinds on a date question', () => {
    fails(
      start('2026-11-19', { kind: 'arithmetic', expression: '1 + 1' }),
      'math does not match',
    );
  });
  it('fails a date value that is not YYYY-MM-DD', () => {
    fails(start('19/11/2026'), 'not a date');
    fails(start('2026-02-30'), 'not a date');
    fails(
      check(
        date,
        ans({ value: 'next week', derivation: 'composed', sources: [notice] }),
      ),
      'not a date',
    );
  });
  it('a date with no math must have every number in a cited source', () => {
    fails(
      check(
        date,
        ans({ value: '2026-11-19', derivation: 'composed', sources: [notice] }),
      ),
      'number not in sources',
    );
  });
});
