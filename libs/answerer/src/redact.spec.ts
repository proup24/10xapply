import { describe, expect, it } from 'vitest';
import { redactResult } from './redact.js';
import { bank } from './testing/bank.js';
import type { AnswerResult } from './types.js';

const calls = [
  {
    role: 'answer' as const,
    model: 'm',
    latencyMs: 5,
    costUsd: null,
    ok: true,
  },
];

describe('redactResult', () => {
  it('keeps no value, fact sentence, quote, claim or label', () => {
    const fact = bank.facts[0].text;
    const value = 'ZZ-secret-value-91';
    const quote = 'daily code review';
    const claim = 'Candidate enjoys unusual-claim-77';
    const label = 'Distinctive-label-55?';
    const r: AnswerResult = {
      questionId: 'q1',
      required: true,
      calls,
      status: 'backed',
      value,
      sources: [
        { kind: 'fact', text: fact },
        { kind: 'job-post', quote },
        { kind: 'story', id: 's1' },
        { kind: 'answer', id: 'a1', variant: 2 },
        { kind: 'field', key: 'email' },
        { kind: 'run-date' },
      ],
      derivation: 'composed',
      inferences: [{ claim, source: { kind: 'job-post', quote } }],
      verification: { verdict: 'confirmed', rounds: 2 },
    };
    const out = redactResult({ ...r, label } as unknown as AnswerResult, bank);
    expect(out.sources[0]).toEqual({ kind: 'fact', ref: 0 });
    expect(out.sources[1]).toEqual({ kind: 'job-post' });
    expect(out.sources[2]).toEqual({ kind: 'story', ref: 's1' });
    expect(out.sources[3]).toEqual({ kind: 'answer', ref: 'a1#2' });
    expect(out.sources[4]).toEqual({ kind: 'field', ref: 'email' });
    expect(out.sources[5]).toEqual({ kind: 'run-date' });
    expect(out.inferenceCount).toBe(1);
    expect(out.rounds).toBe(2);
    expect(out.derivation).toBe('composed');
    expect(out.calls).toEqual(calls);
    const json = JSON.stringify(out);
    for (const s of [value, fact, quote, claim, label]) {
      expect(json).not.toContain(s);
    }
  });

  it('uses ref -1 for an unknown fact and never its text', () => {
    const text = 'Not a bank fact sentence xyz';
    const out = redactResult(
      {
        questionId: 'q',
        required: false,
        calls: [],
        status: 'backed',
        value: 'v',
        sources: [{ kind: 'fact', text }],
        derivation: 'as-written',
        inferences: [],
        verification: { verdict: 'not-needed', rounds: 0 },
      },
      bank,
    );
    expect(out.sources).toEqual([{ kind: 'fact', ref: -1 }]);
    expect(JSON.stringify(out)).not.toContain(text);
  });

  it('keeps the reason of a blocked result and drops its detail', () => {
    const out = redactResult(
      {
        questionId: 'q',
        required: true,
        calls: [],
        status: 'blocked',
        reason: 'bank-silent',
        detail: 'detail-text-123',
      },
      bank,
    );
    expect(out).toEqual({
      questionId: 'q',
      required: true,
      status: 'blocked',
      reason: 'bank-silent',
      sources: [],
      inferenceCount: 0,
      calls: [],
    });
  });
});
