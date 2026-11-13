import { ModelCallError } from '@xapply/answerer';
import { describe, expect, it } from 'vitest';
import { fakeCaller } from '../testing/fake-caller.js';
import type { DisqualifyGolden } from './format.js';
import { runDisqualifyGolden } from './run.js';

const job = {
  title: 'Engineer',
  company: 'Acme',
  description: 'We offer visa support. Based in Berlin.',
};
const label = 'Are you authorized to work in the US?';
const claim = (over: Record<string, unknown> = {}) => ({
  kind: 'asks-authorization',
  countries: ['US'],
  countryFrom: 'text',
  quote: label,
  placeQuote: null,
  source: 's1-q1',
  detail: null,
  ...over,
});
const offer = claim({
  kind: 'offers-sponsorship',
  countries: [],
  quote: 'We offer visa support.',
  source: 'job-page',
});

function golden(over: Record<string, unknown> = {}): DisqualifyGolden {
  return {
    rules: { authorizedCountries: ['MA'], locatedIn: ['MA'] },
    defaultJob: job,
    cases: [
      {
        id: 'c1',
        group: 'authorization',
        checkJob: false,
        questions: [{ label, type: 'radio', options: ['Yes', 'No'] }],
        expect: {
          verdict: 'disqualified',
          claims: [{ kind: 'asks-authorization', countries: ['US'] }],
        },
        ...over,
      },
    ],
  } as DisqualifyGolden;
}
const ctxOf = (caller: ReturnType<typeof fakeCaller>) => ({
  caller,
  model: 'm',
});

describe('runDisqualifyGolden', () => {
  it('passes a matching case, with the question id assigned', async () => {
    const caller = fakeCaller([() => ({ claims: [claim()] })]);
    const r = await runDisqualifyGolden({
      golden: golden(),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.passed).toBe(true);
    expect(r.cases[0]?.runs[0]).toMatchObject({
      pass: true,
      verdict: 'disqualified',
    });
    expect(caller.requests[0]?.prompt).toContain('s1-q1');
    expect(r.cases[0]?.runs[0]?.calls).toHaveLength(1);
  });

  it('fails on a wrong country', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim({ countries: ['CA'] })] }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden(),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.cases[0]?.runs[0]?.pass).toBe(false);
  });

  it('matches UK against GB and [] against []', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim({ countries: ['GB'] })] }),
      () => ({ claims: [claim({ countries: [] })] }),
    ]);
    const g = golden({
      expect: {
        verdict: 'disqualified',
        claims: [{ kind: 'asks-authorization', countries: ['UK'] }],
      },
    });
    const one = await runDisqualifyGolden({
      golden: g,
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(one.passed).toBe(true);
    const unclear = golden({
      expect: {
        verdict: 'pass',
        claims: [{ kind: 'asks-authorization', countries: [] }],
      },
    });
    const two = await runDisqualifyGolden({
      golden: unclear,
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(two.passed).toBe(true);
  });

  it('a kind list matches any of its kinds', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim({ kind: 'requires-authorization' })] }),
    ]);
    const g = golden({
      expect: {
        verdict: 'disqualified',
        claims: [
          {
            kind: ['requires-location', 'requires-authorization'],
            countries: ['US'],
          },
        ],
      },
    });
    const r = await runDisqualifyGolden({
      golden: g,
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.cases[0]?.runs[0]?.verdict).toBe('disqualified');
    expect(r.passed).toBe(true);
  });

  it('fails when the verdict differs', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim({ countries: ['MA'] })] }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden({
        expect: {
          verdict: 'disqualified',
          claims: [{ kind: 'asks-authorization', countries: ['MA'] }],
        },
      }),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.cases[0]?.runs[0]).toMatchObject({ pass: false, verdict: 'pass' });
  });

  it('passes with an extra rule claim that does not change the verdict', async () => {
    const caller = fakeCaller([
      () => ({
        claims: [
          claim({ countries: ['MA'] }),
          claim({ kind: 'asks-sponsorship', countries: ['MA'] }),
        ],
      }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden({
        expect: {
          verdict: 'pass',
          claims: [{ kind: 'asks-authorization', countries: ['MA'] }],
        },
      }),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.passed).toBe(true);
  });

  it('lets a job-page offer exempt a question claim', async () => {
    const caller = fakeCaller([
      () => ({ claims: [offer] }),
      () => ({ claims: [claim()] }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden({
        checkJob: true,
        job,
        expect: {
          verdict: 'pass',
          claims: [{ kind: 'asks-authorization', countries: ['US'] }],
        },
      }),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.cases[0]?.runs[0]).toMatchObject({ pass: true, verdict: 'pass' });
    expect(r.cases[0]?.runs[0]?.calls).toHaveLength(2);
  });

  it('relocation offers reach decide', async () => {
    const caller = fakeCaller([
      () => ({
        claims: [
          claim({
            kind: 'offers-relocation',
            countries: ['DE'],
            quote: 'Relocation package provided.',
            source: 'job-page',
          }),
        ],
      }),
      () => ({
        claims: [
          claim({
            kind: 'asks-location',
            countries: ['DE'],
            quote: label,
            detail: 'asks where the candidate lives',
          }),
        ],
      }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden({
        checkJob: true,
        job: {
          ...job,
          description: 'Relocation package provided. Based in Berlin.',
        },
        expect: {
          verdict: 'pass',
          claims: [{ kind: 'asks-location', countries: ['DE'] }],
        },
      }),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(r.cases[0]?.runs[0]).toMatchObject({ pass: true, verdict: 'pass' });
  });

  it('does not run the job check when checkJob is false, and offers are none', async () => {
    const caller = fakeCaller([() => ({ claims: [claim()] })]);
    await runDisqualifyGolden({
      golden: golden(),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    expect(caller.requests).toHaveLength(1);
    expect(caller.requests[0]?.prompt).toContain('Read these questions');
  });

  it('fails the run on a CheckFailedError, keeping the calls made', async () => {
    const caller = fakeCaller([
      () => {
        throw new ModelCallError('boom');
      },
    ]);
    const r = await runDisqualifyGolden({
      golden: golden(),
      ctx: ctxOf(caller),
      repeat: 1,
    });
    const run = r.cases[0]?.runs[0];
    expect(run?.pass).toBe(false);
    expect(run?.error).toBe('check failed: model-error: boom');
    expect(r.passed).toBe(false);
  });

  it('is not passed when one of three repeats fails, and sums cost', async () => {
    const caller = fakeCaller([
      () => ({ claims: [claim()] }),
      () => ({ claims: [claim({ countries: ['CA'] })] }),
      () => ({ claims: [claim()] }),
    ]);
    const r = await runDisqualifyGolden({
      golden: golden(),
      ctx: ctxOf(caller),
      repeat: 3,
    });
    expect(r.cases[0]?.runs.map((x) => x.pass)).toEqual([true, false, true]);
    expect(r.passed).toBe(false);
    expect(r.cost).toBe(0);
  });

  it('runs only the named case and rejects an unknown id', async () => {
    const caller = fakeCaller([() => ({ claims: [claim()] })]);
    await expect(
      runDisqualifyGolden({
        golden: golden(),
        ctx: ctxOf(caller),
        repeat: 1,
        caseId: 'nope',
      }),
    ).rejects.toThrow('no case with id nope');
  });
});
