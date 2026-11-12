import { describe, expect, it } from 'vitest';
import { answerQuestion } from './answer.js';
import { FIELD_PATTERNS, fieldValue } from './fields.js';
import { ModelCallError, ModelUnavailableError } from './model/caller.js';
import { generatorPrompt } from './prompts/generator.js';
import { blindPrompt, fitPrompt } from './prompts/verifier.js';
import { fakeCaller } from './testing/fake-caller.js';
import { bank, job } from './testing/bank.js';
import { checksFor, verifyCandidate } from './verify.js';
import type {
  AnswerContext,
  CallStat,
  Candidate,
  AnswerResult,
  FieldKey,
  FormQuestion,
} from './types.js';

type Script = Parameters<typeof fakeCaller>[0];

const RUN_DATE = '2026-11-12';
const UK_ONLY = 'I am authorized to work in the United Kingdom only.';

const blockedResults: Array<{ result: AnswerResult; label: string }> = [];

async function run(
  q: FormQuestion,
  script: Script,
  maxRegenerations = 1,
): Promise<{
  result: AnswerResult;
  requests: ReturnType<typeof fakeCaller>['requests'];
}> {
  const caller = fakeCaller(script);
  const ctx: AnswerContext = {
    bank,
    job,
    runDate: RUN_DATE,
    models: {
      answerModel: 'gen-model',
      verifyModel: 'ver-model',
      maxRegenerations,
    },
    caller,
  };
  const result = await answerQuestion(q, ctx);
  if (result.status === 'blocked')
    blockedResults.push({ result, label: q.label });
  return { result, requests: caller.requests };
}

const promptCtx = { bank, job, runDate: RUN_DATE };

const q = (over: Partial<FormQuestion> = {}): FormQuestion => ({
  id: 'q1',
  label: 'A question',
  type: 'text',
  required: true,
  ...over,
});

// The flat model-output shapes, with every key present.
const src = (over: Record<string, unknown>) => ({
  kind: 'fact',
  key: null,
  text: null,
  id: null,
  variant: null,
  quote: null,
  ...over,
});
const out = (over: Record<string, unknown>) => ({
  outcome: 'answer',
  reason: null,
  value: null,
  sources: [],
  derivation: null,
  inferences: [],
  math: null,
  ...over,
});
const cannot = (reason: string) => out({ outcome: 'cannot-answer', reason });
const factSrc = src({ kind: 'fact', text: UK_ONLY });
const pick =
  (value: unknown, derivation = 'bucket', sources = [factSrc]) =>
  () =>
    out({ value, derivation, sources });

const sponsorshipRadio = q({
  id: 'sponsor',
  label: 'Will you need visa sponsorship to work here?',
  type: 'radio',
  options: ['Yes', 'No'],
});

const expectBlocked = (r: AnswerResult, reason: string, detail: string) => {
  expect(r.status).toBe('blocked');
  if (r.status !== 'blocked') return;
  expect(r.reason).toBe(reason);
  expect(r.detail).toBe(detail);
};

const BLIND_FEEDBACK = 'the verifier picked a different option';

describe('answerQuestion: before any model call', () => {
  it('blocks an unknown type as unsupported-field, with 0 calls', async () => {
    const { result, requests } = await run(q({ type: 'date' }), []);
    expectBlocked(result, 'unsupported-field', 'unsupported field type');
    expect(result.calls).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('fills a field label from the bank, with 0 calls', async () => {
    const { result, requests } = await run(q({ label: 'Email address' }), []);
    expect(result).toEqual({
      questionId: 'q1',
      required: true,
      calls: [],
      status: 'backed',
      value: 'sam@example.com',
      sources: [{ kind: 'field', key: 'email' }],
      derivation: 'field',
      inferences: [],
      verification: { verdict: 'not-needed', rounds: 0 },
    });
    expect(requests).toHaveLength(0);
  });

  it('blocks a field choice with no matching option as check-failed', async () => {
    const { result } = await run(
      q({ label: 'Country', type: 'select', options: ['France', 'Spain'] }),
      [],
    );
    expectBlocked(result, 'check-failed', 'no option matches field country');
  });

  it('blocks a cover-letter file as unsupported-field', async () => {
    const { result, requests } = await run(
      q({ label: 'Cover letter', type: 'file' }),
      [],
    );
    expectBlocked(result, 'unsupported-field', 'unsupported field type');
    expect(requests).toHaveLength(0);
  });
});

describe('answerQuestion: generate and check', () => {
  it('passes a generator cannot-answer through, with 1 call', async () => {
    const { result, requests } = await run(sponsorshipRadio, [
      () => cannot('bank-silent'),
    ]);
    expectBlocked(result, 'bank-silent', 'generator: bank-silent');
    expect(result.calls).toHaveLength(1);
    expect(requests[0]).toMatchObject({ role: 'answer', model: 'gen-model' });
    expect(requests[0]?.prompt).toBe(
      generatorPrompt(sponsorshipRadio, promptCtx, []),
    );
  });

  it('blocks a check failure with no verify call and no retry', async () => {
    const { result, requests } = await run(sponsorshipRadio, [pick('Maybe')]);
    expectBlocked(result, 'check-failed', 'option not offered');
    expect(result.calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
});

describe('answerQuestion: verify', () => {
  it('confirms a blind match on a radio: 2 calls, rounds 1', async () => {
    const { result, requests } = await run(sponsorshipRadio, [
      pick('Yes'),
      pick(' yes '),
    ]);
    expect(result).toMatchObject({
      status: 'backed',
      value: 'Yes',
      derivation: 'bucket',
      sources: [{ kind: 'fact', text: UK_ONLY }],
      verification: { verdict: 'confirmed', rounds: 1 },
    });
    expect(result.calls.map((c) => [c.role, c.model])).toEqual([
      ['answer', 'gen-model'],
      ['verify', 'ver-model'],
    ]);
    expect(requests[1]?.prompt).toBe(blindPrompt(sponsorshipRadio, promptCtx));
  });

  it('regenerates once after a blind mismatch: 4 calls, rounds 2, no pick leaked', async () => {
    const { result, requests } = await run(sponsorshipRadio, [
      pick('Yes'),
      pick('No'),
      pick('No'),
      pick('No'),
    ]);
    expect(result).toMatchObject({
      status: 'backed',
      value: 'No',
      verification: { verdict: 'confirmed', rounds: 2 },
    });
    expect(result.calls).toHaveLength(4);
    const second = requests[2]?.prompt ?? '';
    expect(second).toBe(
      generatorPrompt(sponsorshipRadio, promptCtx, [BLIND_FEEDBACK]),
    );
    expect(second).toContain(BLIND_FEEDBACK);
    // The verifier's pick ("No") is an option, so it is in every prompt's
    // question. It must not be in the feedback, and the verify prompts are blind.
    const feedback = second.slice(
      second.indexOf('<feedback>'),
      second.indexOf('</feedback>'),
    );
    expect(feedback).not.toMatch(/\bNo\b/);
    expect(requests[3]?.prompt).toBe(blindPrompt(sponsorshipRadio, promptCtx));
  });

  it('blocks a mismatch twice as verifier-rejected, with 4 calls', async () => {
    const { result } = await run(sponsorshipRadio, [
      pick('Yes'),
      pick('No'),
      pick('Yes'),
      pick('No'),
    ]);
    expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
    expect(result.calls).toHaveLength(4);
  });

  it('blocks on the first rejection when maxRegenerations is 0', async () => {
    const { result } = await run(
      sponsorshipRadio,
      [pick('Yes'), pick('No')],
      0,
    );
    expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
    expect(result.calls).toHaveLength(2);
  });

  it('rejects a blind verifier cannot-answer, with its own feedback line', async () => {
    const { result, requests } = await run(sponsorshipRadio, [
      pick('Yes'),
      () => cannot('bank-silent'),
      () => cannot('bank-silent'),
    ]);
    expectBlocked(result, 'bank-silent', 'generator: bank-silent');
    expect(requests[2]?.prompt).toBe(
      generatorPrompt(sponsorshipRadio, promptCtx, [
        'the verifier could not back an answer from the bank',
      ]),
    );

    const once = await run(
      sponsorshipRadio,
      [pick('Yes'), () => cannot('bank-silent')],
      0,
    );
    expectBlocked(once.result, 'verifier-rejected', 'verifier rejected: blind');
  });

  describe('math and bucket on a text field', () => {
    const rate = q({ label: 'Your combined rate figure', type: 'text' });
    const mathGen = () =>
      out({
        value: '5030',
        derivation: 'math',
        sources: [src({ kind: 'answer', id: 'contractor-rate', variant: 2 })],
        math: {
          kind: 'arithmetic',
          year: null,
          month: null,
          expression: '5000 + 30',
        },
      });

    it('runs a blind call on a math answer and rejects a mismatch', async () => {
      const { result, requests } = await run(rate, [mathGen, pick('5031')], 0);
      expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
      expect(requests.map((r) => r.role)).toEqual(['answer', 'verify']);
      expect(requests[1]?.prompt).toBe(blindPrompt(rate, promptCtx));
    });

    it('compares a math answer on a text field numerically', async () => {
      const { result } = await run(rate, [mathGen, pick('5030.0')]);
      expect(result).toMatchObject({
        status: 'backed',
        value: '5030',
        derivation: 'math',
        verification: { verdict: 'confirmed', rounds: 1 },
      });
      expect(result.calls).toHaveLength(2);
    });

    it('runs a blind call on a bucket answer, compared case-insensitively', async () => {
      const notice = q({ label: 'What is your notice period?', type: 'text' });
      const noticeFact = src({
        kind: 'fact',
        text: 'My notice period is one month.',
      });
      const { result, requests } = await run(notice, [
        pick('One month', 'bucket', [noticeFact]),
        pick(' one MONTH '),
      ]);
      expect(result).toMatchObject({
        status: 'backed',
        value: 'One month',
        verification: { verdict: 'confirmed', rounds: 1 },
      });
      expect(requests.map((r) => r.role)).toEqual(['answer', 'verify']);
      expect(requests[1]?.prompt).toBe(blindPrompt(notice, promptCtx));

      const mismatch = await run(
        notice,
        [pick('One month', 'bucket', [noticeFact]), pick('Two weeks')],
        0,
      );
      expectBlocked(
        mismatch.result,
        'verifier-rejected',
        'verifier rejected: blind',
      );
    });
  });

  it('rejects a blind verifier value that is not an option', async () => {
    const { result } = await run(
      sponsorshipRadio,
      [pick('Yes'), pick('Perhaps')],
      0,
    );
    expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
  });

  it('runs blind and then fit on a fitted radio', async () => {
    const sponsorAnswer = src({ kind: 'answer', id: 'sponsorship-future' });
    const { result, requests } = await run(sponsorshipRadio, [
      pick('Yes', 'fitted', [sponsorAnswer]),
      pick('Yes'),
      () => ({ fits: true, why: 'It answers it.' }),
    ]);
    expect(result).toMatchObject({
      status: 'backed',
      value: 'Yes',
      derivation: 'fitted',
      verification: { verdict: 'confirmed', rounds: 1 },
    });
    expect(requests.map((r) => r.role)).toEqual(['answer', 'verify', 'verify']);
    expect(requests[1]?.prompt).toBe(blindPrompt(sponsorshipRadio, promptCtx));
    expect(requests[2]?.prompt).toBe(
      fitPrompt(sponsorshipRadio, promptCtx, {
        outcome: 'answer',
        value: 'Yes',
        sources: [{ kind: 'answer', id: 'sponsorship-future' }],
        derivation: 'fitted',
        inferences: [],
      }),
    );
  });

  it('stops at a blind rejection without running fit', async () => {
    const sponsorAnswer = src({ kind: 'answer', id: 'sponsorship-future' });
    const { result, requests } = await run(
      sponsorshipRadio,
      [pick('Yes', 'fitted', [sponsorAnswer]), pick('No')],
      0,
    );
    expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
    expect(requests).toHaveLength(2);
  });

  it('compares a multi-select as a set of options', async () => {
    const group = q({
      label: 'Where are you authorized to work?',
      type: 'checkbox-group',
      options: ['United Kingdom', 'European Union', 'United States'],
    });
    const { result } = await run(group, [
      pick(['United Kingdom']),
      pick(['united kingdom']),
    ]);
    expect(result).toMatchObject({
      status: 'backed',
      value: ['United Kingdom'],
    });

    const mismatch = await run(
      group,
      [pick(['United Kingdom']), pick(['United Kingdom', 'European Union'])],
      0,
    );
    expectBlocked(
      mismatch.result,
      'verifier-rejected',
      'verifier rejected: blind',
    );
  });

  describe('a number', () => {
    const salary = q({
      label: 'Expected monthly salary in USD',
      type: 'number',
    });
    const salarySrc = src({
      kind: 'answer',
      id: 'salary-expectation-monthly-usd',
    });
    const gen = pick('5000', 'fitted', [salarySrc]);

    it('compares numerically, then runs fit', async () => {
      const { result, requests } = await run(salary, [
        gen,
        pick('5000.0'),
        () => ({ fits: true, why: 'Monthly, in USD.' }),
      ]);
      expect(result).toMatchObject({ status: 'backed', value: '5000' });
      expect(requests).toHaveLength(3);
    });

    it('rejects a different number and says so without the number', async () => {
      const { result, requests } = await run(salary, [
        gen,
        pick('6000'),
        () => cannot('bank-silent'),
      ]);
      expectBlocked(result, 'bank-silent', 'generator: bank-silent');
      expect(requests[2]?.prompt).toBe(
        generatorPrompt(salary, promptCtx, [
          'the verifier picked a different number',
        ]),
      );
      expect(requests[2]?.prompt).not.toContain('6000');
    });

    it('rejects a verifier value that is not a number', async () => {
      const { result } = await run(salary, [gen, pick('about 5000')], 0);
      expectBlocked(result, 'verifier-rejected', 'verifier rejected: blind');
    });
  });

  it('rejects an as-written answer the verifier says does not fit', async () => {
    const heard = q({ label: 'How did you hear about us?' });
    const why = 'The entry is about heard-from, a secret reason text.';
    const { result, requests } = await run(heard, [
      pick('LinkedIn', 'as-written', [
        src({ kind: 'answer', id: 'heard-from' }),
      ]),
      () => ({ fits: false, why }),
      () => cannot('bank-silent'),
    ]);
    expect(requests.map((r) => r.role)).toEqual(['answer', 'verify', 'answer']);
    const feedbackPrompt = requests[2]?.prompt ?? '';
    expect(feedbackPrompt).toContain(
      'the cited entry does not answer this question',
    );
    expect(feedbackPrompt).toContain(why);
    expectBlocked(result, 'bank-silent', 'generator: bank-silent');

    const once = await run(
      heard,
      [
        pick('LinkedIn', 'as-written', [
          src({ kind: 'answer', id: 'heard-from' }),
        ]),
        () => ({ fits: false, why }),
      ],
      0,
    );
    expectBlocked(once.result, 'verifier-rejected', 'verifier rejected: fit');
    if (once.result.status === 'blocked')
      expect(once.result.detail).not.toContain(why);
  });

  it('blocks a composed answer with an unsupported claim, rejected twice', async () => {
    const story = q({
      label: 'Tell us about a time you missed a deadline.',
      type: 'textarea',
    });
    const value =
      'I told my manager the same day that we would miss the date, and we launched two weeks late.';
    const composed = pick(value, 'composed', [
      src({ kind: 'story', id: 'missed-launch-date' }),
    ]);
    const claim = 'The author led a team of nine engineers.';
    const claims = () => ({
      claims: [
        {
          claim: 'The author told their manager the same day.',
          mark: 'backed',
          source: 'story missed-launch-date',
        },
        { claim, mark: 'unsupported', source: null },
      ],
      storyDetailAdded: true,
    });
    const { result, requests } = await run(story, [
      composed,
      claims,
      composed,
      claims,
    ]);
    expectBlocked(result, 'verifier-rejected', 'verifier rejected: claims');
    expect(result.calls).toHaveLength(4);
    const second = requests[2]?.prompt ?? '';
    expect(second).toContain(claim);
    expect(second).toContain('unsupported');
    expect(second).toContain('a story detail was added');
    expect(second).not.toContain('told their manager the same day');
    if (result.status === 'blocked') expect(result.detail).not.toContain(claim);
  });

  it('confirms a composed answer whose claims are all backed or inferred', async () => {
    const story = q({ label: 'Tell us about a hard bug.', type: 'textarea' });
    const { result, requests } = await run(story, [
      pick(
        'I found that two workers could claim the same job, and added a lock.',
        'composed',
        [src({ kind: 'story', id: 'intermittent-queue-bug' })],
      ),
      () => ({
        claims: [
          {
            claim: 'Found the race.',
            mark: 'inferred',
            source: 'story intermittent-queue-bug',
          },
        ],
        storyDetailAdded: false,
      }),
    ]);
    expect(result).toMatchObject({
      status: 'backed',
      derivation: 'composed',
      verification: { verdict: 'confirmed', rounds: 1 },
    });
    expect(requests.map((r) => r.role)).toEqual(['answer', 'verify']);
  });

  it('blocks a regenerated candidate that fails a check as check-failed', async () => {
    const { result } = await run(sponsorshipRadio, [
      pick('Yes'),
      pick('No'),
      pick('Maybe'),
    ]);
    expectBlocked(result, 'check-failed', 'option not offered');
    expect(result.calls).toHaveLength(3);
  });
});

describe('answerQuestion: model failures', () => {
  const fail = () => {
    throw new ModelCallError('model call failed after retries');
  };

  it('blocks a generator ModelCallError as model-error', async () => {
    const { result } = await run(sponsorshipRadio, [fail]);
    expectBlocked(result, 'model-error', 'model call failed');
    expect(result.calls).toEqual([]);
  });

  it('blocks a verifier ModelCallError as model-error, keeping earlier stats', async () => {
    const { result } = await run(sponsorshipRadio, [pick('Yes'), fail]);
    expectBlocked(result, 'model-error', 'model call failed');
    expect(result.calls).toHaveLength(1);
  });

  it('blocks a bad output combination as model-error', async () => {
    const { result } = await run(sponsorshipRadio, [
      () => out({ value: 'Yes' }),
    ]);
    expectBlocked(result, 'model-error', 'model call failed');
  });

  it('rethrows a ModelUnavailableError', async () => {
    const unavailable = () => {
      throw new ModelUnavailableError('not signed in');
    };
    await expect(run(sponsorshipRadio, [unavailable])).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    await expect(
      run(sponsorshipRadio, [pick('Yes'), unavailable]),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe('verifier checks', () => {
  const text = q({ type: 'text' });
  it('names the checks per type and derivation, in order', () => {
    expect(checksFor(sponsorshipRadio, 'fitted')).toEqual(['blind', 'fit']);
    expect(checksFor(sponsorshipRadio, 'bucket')).toEqual(['blind']);
    expect(checksFor(sponsorshipRadio, 'composed')).toEqual([
      'blind',
      'claims',
    ]);
    expect(checksFor(q({ type: 'number' }), 'as-written')).toEqual([
      'blind',
      'fit',
    ]);
    expect(checksFor(text, 'math')).toEqual(['blind']);
    expect(checksFor(text, 'bucket')).toEqual(['blind']);
    expect(checksFor(text, 'as-written')).toEqual(['fit']);
    expect(checksFor(text, 'fitted')).toEqual(['fit']);
    expect(checksFor(text, 'composed')).toEqual(['claims']);
  });

  it('rejects, never confirms, a round with no check (unreachable from answerQuestion)', async () => {
    // No answer derivation gets zero checks, so only a forced one reaches the guard.
    const forced = {
      outcome: 'answer',
      value: 'x',
      sources: [],
      derivation: 'field',
      inferences: [],
    } as unknown as Extract<Candidate, { outcome: 'answer' }>;
    expect(checksFor(text, forced.derivation)).toEqual([]);
    const caller = fakeCaller([]);
    const calls: CallStat[] = [];
    const verdict = await verifyCandidate(
      text,
      {
        ...promptCtx,
        models: { answerModel: 'g', verifyModel: 'v', maxRegenerations: 1 },
        caller,
      },
      forced,
      'x',
      calls,
    );
    expect(verdict).toEqual({
      verdict: 'rejected',
      check: 'none',
      feedback: [],
    });
    expect(caller.requests).toHaveLength(0);
  });
});

describe('answerQuestion: detail', () => {
  it('never holds a bank value or a question label', () => {
    const values = [
      ...(Object.keys(FIELD_PATTERNS) as FieldKey[]).map((k) =>
        fieldValue(k, bank),
      ),
      ...bank.facts.map((f) => f.text),
      ...bank.answers.flatMap((a) =>
        a.variants ? a.variants.map((v) => v.answer) : [a.answer],
      ),
      ...bank.stories.flatMap((s) => [s.title, s.story]),
    ]
      .filter((v): v is string => v !== undefined)
      .map((v) => v.trim())
      .filter((v) => v.length > 3);
    expect(values.length).toBeGreaterThan(20);
    expect(blockedResults.length).toBeGreaterThan(15);
    for (const { result, label } of blockedResults) {
      if (result.status !== 'blocked') continue;
      expect(result.detail).not.toContain(label);
      for (const v of values) expect(result.detail).not.toContain(v);
    }
  });
});
