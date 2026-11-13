import { describe, expect, it } from 'vitest';
import { EXTRACT_SYSTEM, jobPrompt, questionsPrompt } from './prompts.js';

const job = {
  title: 'Senior Engineer',
  company: 'Acme',
  description: 'Build things. Visa sponsorship is not available.',
};

describe('prompts', () => {
  it('says relocation help alone is not a sponsorship offer', () => {
    const kind1 = EXTRACT_SYSTEM.split('\n').find((l) =>
      l.startsWith('1. offers-sponsorship'),
    );
    expect(kind1).toContain('Relocation help alone');
    expect(kind1).not.toContain('helps with relocation and visas');
    expect(EXTRACT_SYSTEM).toContain(
      'A relocation package, relocation support or help moving is not offers-sponsorship',
    );
  });

  it('the job prompt holds the title and description', () => {
    const p = jobPrompt(job);
    expect(p).toContain('Senior Engineer');
    expect(p).toContain('Visa sponsorship is not available.');
  });

  it('the questions prompt holds each id and label, and the job', () => {
    const p = questionsPrompt(
      [
        { id: 's1-q1', label: 'Are you authorized to work in the UK?' },
        {
          id: 's1-q2',
          label: 'Need sponsorship?',
          type: 'select',
          options: ['Yes', 'No'],
          helpText: 'Be honest',
          stepTitle: 'Work authorization',
        },
      ],
      job,
    );
    for (const s of [
      's1-q1',
      'Are you authorized to work in the UK?',
      's1-q2',
      'Need sponsorship?',
      'Be honest',
      'Work authorization',
      'Senior Engineer',
      'Build things.',
    ])
      expect(p).toContain(s);
  });

  it("sends a sponsorship question naming no country to the job's country", () => {
    expect(EXTRACT_SYSTEM).toContain(
      'names no country ("Will you now or in the future require sponsorship for employment visa status?"',
    );
    expect(EXTRACT_SYSTEM).toContain('is about the country of this job');
  });

  it('nothing mentions the rules or the bank', () => {
    const all =
      EXTRACT_SYSTEM +
      jobPrompt(job) +
      questionsPrompt([{ id: 'a', label: 'b' }], job);
    expect(all).not.toContain('authorizedCountries');
    expect(all.toLowerCase()).not.toContain('fact');
  });
});
