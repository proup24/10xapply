import { describe, expect, it } from 'vitest';
import { REGIONS } from './countries.js';
import { EXTRACT_SYSTEM, jobPrompt, questionsPrompt } from './prompts.js';
import { LOG_KINDS, RULE_KINDS } from './types.js';

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

  const lineOf = (start: string) =>
    EXTRACT_SYSTEM.split('\n').find((l) => l.startsWith(start)) ?? '';

  it('names every kind', () => {
    const kinds = [...RULE_KINDS, ...LOG_KINDS];
    expect(kinds).toHaveLength(10);
    kinds.forEach((k, i) =>
      expect(EXTRACT_SYSTEM).toContain(`\n${i + 1}. ${k}:`),
    );
    expect(EXTRACT_SYSTEM).toContain('ten kinds');
    expect(EXTRACT_SYSTEM).not.toContain('location-requirement');
    expect(EXTRACT_SYSTEM).not.toContain('only logged');
  });

  it('relocation is not sponsorship, and willingness is not a claim', () => {
    expect(EXTRACT_SYSTEM).toContain(
      'A relocation package, relocation support or help moving is not offers-sponsorship',
    );
    expect(EXTRACT_SYSTEM).toContain(
      'Willingness to relocate ("Are you willing to relocate?", "Are you willing to relocate to Germany?", "Candidates must be willing to relocate to Berlin") is not a claim',
    );
  });

  it('soft wording and time zones are location-preference', () => {
    const kind = lineOf('9. location-preference');
    for (const s of ['preferably', 'Germany (Remote)', 'time zone'])
      expect(kind).toContain(s);
  });

  it('closed lists are asks-location', () => {
    expect(EXTRACT_SYSTEM).toContain('Which country are you based in?');
    expect(lineOf('8. asks-location')).toContain('"Other"');
    expect(EXTRACT_SYSTEM).toContain('open question');
  });

  it('region names', () => {
    for (const r of Object.keys(REGIONS)) expect(EXTRACT_SYSTEM).toContain(r);
    expect(EXTRACT_SYSTEM).toContain(Object.keys(REGIONS).join(', '));
  });

  it('location questions naming no place take the job place', () => {
    expect(EXTRACT_SYSTEM).toContain(
      'sponsorship, work authorization or location question',
    );
    expect(EXTRACT_SYSTEM).toContain("Are you located in the job's location?");
    expect(EXTRACT_SYSTEM).toContain('Claims of kinds 1 to 8');
    expect(EXTRACT_SYSTEM).toContain(
      'Candidates must be willing to relocate to Berlin',
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
      'names no country or place ("Will you now or in the future require sponsorship for employment visa status?"',
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
