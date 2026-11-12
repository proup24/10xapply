import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bank, job } from '../testing/bank.js';
import type { Candidate, FormQuestion } from '../types.js';
import { renderBank, renderContext, renderQuestion } from './bank-text.js';
import { GENERATOR_SYSTEM, generatorPrompt } from './generator.js';
import {
  claimsOutput,
  fitOutput,
  generatorOutput,
  toCandidate,
  type GeneratorOutput,
} from './schemas.js';
import {
  blindPrompt,
  claimsPrompt,
  fitPrompt,
  VERIFY_SYSTEM,
} from './verifier.js';

type Answer = Extract<Candidate, { outcome: 'answer' }>;

const ctx = { bank, job, runDate: '2026-11-12' };

const q = (over: Partial<FormQuestion> = {}): FormQuestion => ({
  id: 'q1',
  label: 'Expected yearly salary, in USD',
  type: 'number',
  required: true,
  ...over,
});

const nullSource = {
  key: null,
  text: null,
  id: null,
  variant: null,
  quote: null,
};

const out = (over: Partial<GeneratorOutput> = {}): GeneratorOutput => ({
  outcome: 'answer',
  reason: null,
  value: '5000',
  sources: [
    {
      ...nullSource,
      kind: 'answer',
      id: 'contractor-rate',
      variant: 1,
    },
  ],
  derivation: 'fitted',
  inferences: [],
  math: null,
  ...over,
});

const candidate: Answer = {
  outcome: 'answer',
  value: '60000',
  sources: [{ kind: 'answer', id: 'contractor-rate', variant: 1 }],
  derivation: 'fitted',
  inferences: [],
};

describe('renderBank', () => {
  const text = renderBank(bank);
  it('numbers facts from 0 in bank order', () => {
    expect(text).toContain('[fact 0] I am a British citizen.');
    expect(text).toContain('[fact 3] My notice period is one month.');
  });
  it('renders variants with their 0-based index and when', () => {
    expect(text).toContain(
      '[answer contractor-rate variant 1] when: the form asks for a rate per month A: 5000 USD per month',
    );
  });
  it('renders known answers and stories', () => {
    expect(text).toContain('[answer salary-expectation-monthly-usd] Q: ');
    expect(text).toContain('[story missed-launch-date]');
  });
  it('lists fields by the key a field source uses', () => {
    expect(text).toContain('email: sam@example.com');
    expect(text).toContain('phone: +44 7700900123');
  });
  it('keeps the sections in order', () => {
    const at = (s: string) => text.indexOf(s);
    expect(at('FIELDS')).toBeGreaterThanOrEqual(0);
    expect(at('FIELDS')).toBeLessThan(at('FACTS'));
    expect(at('FACTS')).toBeLessThan(at('KNOWN ANSWERS'));
    expect(at('KNOWN ANSWERS')).toBeLessThan(at('STORIES'));
  });
});

describe('renderContext', () => {
  it('holds the bank, the job post and the run date as a citable source', () => {
    const text = renderContext(ctx);
    expect(text).toContain(renderBank(bank));
    expect(text).toContain(job.description);
    expect(text).toContain('Acme Payments');
    expect(text).toContain('2026-11-12');
    expect(text).toContain('run-date');
  });
});

describe('generatorPrompt', () => {
  const question = q();
  it('starts with the context and ends with the question', () => {
    const prompt = generatorPrompt(question, ctx, []);
    expect(prompt.startsWith(renderContext(ctx))).toBe(true);
    expect(prompt.endsWith(renderQuestion(question))).toBe(true);
    expect(prompt).not.toContain('<feedback>');
  });
  it('includes the feedback lines when given', () => {
    const prompt = generatorPrompt(question, ctx, [
      'The claim about Terraform has no source.',
      'The cited answer gives a monthly amount.',
    ]);
    expect(prompt).toContain('The claim about Terraform has no source.');
    expect(prompt).toContain('The cited answer gives a monthly amount.');
    expect(prompt.endsWith(renderQuestion(question))).toBe(true);
  });
  it('renders the options, limits and help text of the question', () => {
    const text = renderQuestion(
      q({
        label: 'What is your notice period?',
        type: 'select',
        options: ['Immediate', 'Less than 2 weeks', 'One month'],
        helpText: 'Pick one',
        maxLength: 200,
        stepTitle: 'Additional questions',
      }),
    );
    for (const s of [
      'What is your notice period?',
      'select',
      '- Less than 2 weeks',
      'Pick one',
      '200',
      'Additional questions',
    ]) {
      expect(text).toContain(s);
    }
  });
});

describe('system prompts', () => {
  it('hold no bank, job or question text', () => {
    for (const system of [GENERATOR_SYSTEM, VERIFY_SYSTEM]) {
      expect(system).not.toMatch(/\bSam\b/);
      expect(system).not.toContain('Acme');
      expect(system).not.toContain('contractor-rate');
      expect(system).not.toContain('2026-11-12');
    }
  });
  it('state the backed rules', () => {
    for (const s of [
      'bank-silent',
      'no-story-fits',
      'boundary',
      'years-since',
      'Silence is not "No"',
      'maxLength',
      'Never use arithmetic for years since a date; always use years-since.',
      "The run date's numbers are never usable in arithmetic",
      "Every inference's source must also be listed in sources",
    ]) {
      expect(GENERATOR_SYSTEM).toContain(s);
    }
    expect(GENERATOR_SYSTEM).not.toContain('strong engineer');
  });
});

describe('verifier prompts', () => {
  it('blindPrompt never shows the candidate', () => {
    const prompt = blindPrompt(q(), ctx);
    expect(prompt).not.toContain(candidate.value as string);
    expect(prompt).not.toContain('fitted');
    expect(prompt.startsWith(renderContext(ctx))).toBe(true);
    expect(prompt.endsWith(renderQuestion(q()))).toBe(true);
  });
  it('fitPrompt shows the cited entry with its variant and when', () => {
    const prompt = fitPrompt(q(), ctx, candidate);
    expect(prompt.startsWith(renderContext(ctx))).toBe(true);
    expect(prompt.endsWith(renderQuestion(q()))).toBe(true);
    expect(prompt).toContain(
      '[answer contractor-rate variant 1] Q: What is your expected rate (USD gross) for a B2B or contractor contract? when: the form asks for a rate per month A: 5000 USD per month',
    );
    expect(prompt).toContain('60000');
  });
  it('claimsPrompt shows the answer, its sources and its inferences', () => {
    const composed: Answer = {
      outcome: 'answer',
      value: 'I am comfortable with containers at Example Ltd.',
      sources: [
        {
          kind: 'fact',
          text: 'I am currently a Backend Engineer at Example Ltd, employed full-time.',
        },
        { kind: 'story', id: 'missed-launch-date' },
        { kind: 'job-post', quote: 'run services on Kubernetes' },
        { kind: 'answer', id: 'why-this-role' },
      ],
      derivation: 'composed',
      inferences: [
        {
          claim: 'comfortable with containers',
          source: { kind: 'story', id: 'missed-launch-date' },
        },
      ],
    };
    const prompt = claimsPrompt(
      q({ type: 'textarea', label: 'Tell us about you' }),
      ctx,
      composed,
    );
    expect(prompt.startsWith(renderContext(ctx))).toBe(true);
    expect(prompt).toContain(composed.value as string);
    expect(prompt).toContain(
      '[fact 4] I am currently a Backend Engineer at Example Ltd',
    );
    expect(prompt).toContain('[story missed-launch-date]');
    expect(prompt).toContain('"run services on Kubernetes"');
    // A cited answer shows with its placeholders filled.
    expect(prompt).toContain('Backend Engineer role at Acme Payments');
    expect(prompt).toContain('comfortable with containers');
    expect(
      prompt.endsWith(
        renderQuestion(q({ type: 'textarea', label: 'Tell us about you' })),
      ),
    ).toBe(true);
  });
});

describe('schemas', () => {
  it('convert to JSON schema', () => {
    expect(() => z.toJSONSchema(generatorOutput)).not.toThrow();
    expect(() => z.toJSONSchema(fitOutput)).not.toThrow();
    expect(() => z.toJSONSchema(claimsOutput)).not.toThrow();
  });
  it('parse a flat cannot-answer', () => {
    const parsed = generatorOutput.parse(
      out({
        outcome: 'cannot-answer',
        reason: 'bank-silent',
        value: null,
        sources: [],
        derivation: null,
      }),
    );
    expect(toCandidate(parsed)).toEqual({
      outcome: 'cannot-answer',
      reason: 'bank-silent',
    });
  });
  it('turn a flat answer into a candidate', () => {
    expect(toCandidate(out())).toEqual({
      outcome: 'answer',
      value: '5000',
      sources: [{ kind: 'answer', id: 'contractor-rate', variant: 1 }],
      derivation: 'fitted',
      inferences: [],
    });
    expect(
      toCandidate(
        out({
          value: 'Text',
          derivation: 'composed',
          sources: [
            { ...nullSource, kind: 'answer', id: 'ai-perspective' },
            { ...nullSource, kind: 'field', key: 'city' },
            { ...nullSource, kind: 'job-post', quote: 'daily code review' },
            { ...nullSource, kind: 'run-date' },
          ],
          inferences: [
            {
              claim: 'c',
              source: {
                ...nullSource,
                kind: 'story',
                id: 'missed-launch-date',
              },
            },
          ],
        }),
      ),
    ).toEqual({
      outcome: 'answer',
      value: 'Text',
      sources: [
        { kind: 'answer', id: 'ai-perspective' },
        { kind: 'field', key: 'city' },
        { kind: 'job-post', quote: 'daily code review' },
        { kind: 'run-date' },
      ],
      derivation: 'composed',
      inferences: [
        { claim: 'c', source: { kind: 'story', id: 'missed-launch-date' } },
      ],
    });
  });
  it('turn math into a MathSpec', () => {
    const fact = {
      ...nullSource,
      kind: 'fact' as const,
      text: 'I am a British citizen.',
    };
    expect(
      toCandidate(
        out({
          value: '5',
          derivation: 'math',
          sources: [fact],
          math: { kind: 'years-since', year: 2021, month: 3, expression: null },
        }),
      ),
    ).toMatchObject({ math: { kind: 'years-since', year: 2021, month: 3 } });
    const yearOnly = toCandidate(
      out({
        value: '5',
        derivation: 'math',
        sources: [fact],
        math: {
          kind: 'years-since',
          year: 2021,
          month: null,
          expression: null,
        },
      }),
    );
    expect(yearOnly).toMatchObject({
      math: { kind: 'years-since', year: 2021 },
    });
    expect(
      'math' in yearOnly && yearOnly.math && 'month' in yearOnly.math,
    ).toBe(false);
    expect(
      toCandidate(
        out({
          value: '5',
          derivation: 'math',
          sources: [fact],
          math: {
            kind: 'arithmetic',
            year: null,
            month: null,
            expression: '5000 / 30',
          },
        }),
      ),
    ).toMatchObject({
      math: { kind: 'arithmetic', expression: '5000 / 30' },
    });
  });

  const bad: Array<[string, GeneratorOutput]> = [
    ['an answer with a null value', out({ value: null })],
    ['an answer with a null derivation', out({ derivation: null })],
    [
      'an answer with a field derivation',
      out({
        derivation: 'field' as unknown as GeneratorOutput['derivation'],
      }),
    ],
    [
      'a cannot-answer with a reason outside the three',
      out({
        outcome: 'cannot-answer',
        reason: 'check-failed' as unknown as GeneratorOutput['reason'],
      }),
    ],
    ['a cannot-answer with no reason', out({ outcome: 'cannot-answer' })],
    [
      'a field source with no key',
      out({ sources: [{ ...nullSource, kind: 'field' }] }),
    ],
    [
      'a fact source with no text',
      out({ sources: [{ ...nullSource, kind: 'fact' }] }),
    ],
    [
      'an answer source with no id',
      out({ sources: [{ ...nullSource, kind: 'answer' }] }),
    ],
    [
      'a story source with no id',
      out({ sources: [{ ...nullSource, kind: 'story' }] }),
    ],
    [
      'a job-post source with no quote',
      out({ sources: [{ ...nullSource, kind: 'job-post' }] }),
    ],
    [
      'an inference whose source has no key',
      out({
        inferences: [{ claim: 'c', source: { ...nullSource, kind: 'story' } }],
      }),
    ],
    ['a math derivation with no math', out({ derivation: 'math' })],
    [
      'years-since with no year',
      out({
        derivation: 'math',
        math: {
          kind: 'years-since',
          year: null,
          month: null,
          expression: null,
        },
      }),
    ],
    [
      'arithmetic with no expression',
      out({
        derivation: 'math',
        math: { kind: 'arithmetic', year: null, month: null, expression: null },
      }),
    ],
  ];
  it.each(bad)('reject %s with a fixed message', (_name, o) => {
    expect(() => toCandidate(o)).toThrow();
    try {
      toCandidate(o);
    } catch (e) {
      const message = (e as Error).message;
      for (const s of ['5000', 'contractor-rate', 'Text']) {
        expect(message).not.toContain(s);
      }
    }
  });
});
