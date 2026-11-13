import { ModelCallError, ModelUnavailableError } from '@xapply/answerer';
import { describe, expect, it } from 'vitest';
import {
  CheckFailedError,
  extractFromJob,
  extractFromQuestions,
} from './extract.js';
import { fakeCaller } from './testing/fake-caller.js';

const job = {
  title: 'Engineer',
  company: 'Acme',
  description: 'We cannot sponsor visas. Must be authorized to work in the US.',
};
const claim = (over: Record<string, unknown> = {}) => ({
  kind: 'no-sponsorship',
  countries: [],
  countryFrom: 'text',
  quote: 'We cannot sponsor visas.',
  placeQuote: null,
  source: 'job-page',
  detail: null,
  ...over,
});
const good = { claims: [claim()] };
const bad = { claims: [claim({ quote: 'invented sentence' })] };

describe('extractFromJob', () => {
  it('returns valid claims with one call stat', async () => {
    const caller = fakeCaller([() => good]);
    const r = await extractFromJob(job, { caller, model: 'm' });
    expect(r.claims).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].role).toBe('extract');
  });

  it('accepts an empty list', async () => {
    const caller = fakeCaller([() => ({ claims: [] })]);
    const r = await extractFromJob(job, { caller, model: 'm' });
    expect(r.claims).toEqual([]);
  });

  it('asks again once after invalid claims, naming the problem', async () => {
    const caller = fakeCaller([() => bad, () => good]);
    const r = await extractFromJob(job, { caller, model: 'm' });
    expect(r.claims).toHaveLength(1);
    expect(r.calls).toHaveLength(2);
    expect(caller.requests[1].prompt).toContain(
      'quote not found in its source',
    );
    expect(caller.requests[1].prompt).not.toContain('invented sentence');
    expect(caller.requests[1].system).toBe(caller.requests[0].system);
    expect(caller.requests[1].prompt).toContain(caller.requests[0].prompt);
  });

  it('fails after two invalid responses', async () => {
    const caller = fakeCaller([() => bad, () => bad]);
    const err = await extractFromJob(job, { caller, model: 'm' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CheckFailedError);
    expect(err.why).toBe('invalid-claims');
    expect(err.calls).toHaveLength(2);
  });

  it('maps ModelCallError to model-error, keeping earlier calls', async () => {
    const caller = fakeCaller([
      () => bad,
      () => {
        throw new ModelCallError('boom');
      },
    ]);
    const err = await extractFromJob(job, { caller, model: 'm' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CheckFailedError);
    expect(err.why).toBe('model-error');
    expect(err.calls).toHaveLength(1);
  });

  it('lets ModelUnavailableError through', async () => {
    const caller = fakeCaller([
      () => {
        throw new ModelUnavailableError('limit');
      },
    ]);
    await expect(
      extractFromJob(job, { caller, model: 'm' }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe('extractFromQuestions', () => {
  const questions = [
    { id: 's1-q1', label: 'Are you authorized to work in the UK?' },
  ];
  const qClaim = (over: Record<string, unknown> = {}) =>
    claim({
      kind: 'asks-authorization',
      countries: ['GB'],
      quote: 'authorized to work in the UK',
      source: 's1-q1',
      ...over,
    });

  it('validates quotes against the question', async () => {
    const caller = fakeCaller([() => ({ claims: [qClaim()] })]);
    const r = await extractFromQuestions(questions, job, {
      caller,
      model: 'm',
    });
    expect(r.claims[0].source).toBe('s1-q1');
    expect(caller.requests[0].role).toBe('extract');
  });

  it('rejects a job-page claim from the questions call', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim()] }),
      () => ({ claims: [qClaim()] }),
    ]);
    const r = await extractFromQuestions(questions, job, {
      caller,
      model: 'm',
    });
    expect(r.calls).toHaveLength(2);
    expect(r.claims[0].kind).toBe('asks-authorization');
  });

  it('accepts a job-description country with a place quote', async () => {
    const caller = fakeCaller([
      () => ({
        claims: [
          qClaim({
            countries: ['US'],
            countryFrom: 'job-description',
            placeQuote: 'authorized to work in the US',
          }),
        ],
      }),
    ]);
    const r = await extractFromQuestions(questions, job, {
      caller,
      model: 'm',
    });
    expect(r.claims).toHaveLength(1);
  });
});
