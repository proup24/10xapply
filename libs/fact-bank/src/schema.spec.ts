import { describe, expect, it } from 'vitest';
import { factBankSchema } from './schema.js';
import { validFile } from './testing/valid-file.js';

const ok = (v: unknown) => factBankSchema.safeParse(v).success;

describe('factBankSchema', () => {
  it('accepts a full valid file', () => {
    expect(factBankSchema.safeParse(validFile()).success).toBe(true);
  });

  it('accepts facts as a string and as an object', () => {
    const f = validFile();
    f.facts = [
      'I am willing to relocate.',
      {
        text: 'I am a Backend Engineer.',
        tags: ['current-job'],
        confirmed: '2026-10-01',
      },
    ];
    expect(ok(f)).toBe(true);
  });

  it('rejects an answer with both answer and variants, neither, or empty variants', () => {
    const both = validFile();
    both.answers[0].variants = [{ when: 'x', answer: 'y' }];
    expect(ok(both)).toBe(false);
    const neither = validFile();
    delete neither.answers[0].answer;
    expect(ok(neither)).toBe(false);
    const empty = validFile();
    delete empty.answers[0].answer;
    empty.answers[0].variants = [];
    expect(ok(empty)).toBe(false);
  });

  it('accepts a variant with tags and confirmed', () => {
    const f = validFile();
    f.answers[1].variants[0].tags = ['contract-work'];
    f.answers[1].variants[0].confirmed = '2026-10-01';
    expect(ok(f)).toBe(true);
    f.answers[1].variants[0].tags = ['Contract Work'];
    expect(ok(f)).toBe(false);
  });

  it('rejects a story with no tags', () => {
    const f = validFile();
    f.stories[0].tags = [];
    expect(ok(f)).toBe(false);
  });

  it('rejects unknown keys', () => {
    const a = validFile();
    a.fields.links.twitter = 'https://x.example';
    expect(ok(a)).toBe(false);
    const b = validFile();
    b.extra = 1;
    expect(ok(b)).toBe(false);
  });

  it('requires linkedin but not github', () => {
    const a = validFile();
    delete a.fields.links.linkedin;
    expect(ok(a)).toBe(false);
    const b = validFile();
    delete b.fields.links.github;
    expect(ok(b)).toBe(true);
  });

  it('rejects non kebab-case ids and tags', () => {
    const a = validFile();
    a.answers[0].id = 'Contractor_Rate';
    expect(ok(a)).toBe(false);
    const b = validFile();
    b.stories[0].tags = ['Current Job'];
    expect(ok(b)).toBe(false);
  });

  it('rejects bad dates', () => {
    for (const bad of ['2026-02-30', '2026-10-1']) {
      const f = validFile();
      f.facts = [{ text: 'A fact.', confirmed: bad }];
      expect(ok(f)).toBe(false);
    }
  });

  it('rejects bad formats', () => {
    const a = validFile();
    a.fields.phone.countryCode = '44';
    expect(ok(a)).toBe(false);
    const b = validFile();
    b.fields.email = 'sam.example.com';
    expect(ok(b)).toBe(false);
    const c = validFile();
    c.fields.links.linkedin = 'http://www.linkedin.com/in/sam';
    expect(ok(c)).toBe(false);
  });

  it('reports facts: null at path facts', () => {
    const f = validFile();
    f.facts = null;
    const r = factBankSchema.safeParse(f);
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'facts')).toBe(
      true,
    );
  });
});
