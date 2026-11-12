import { describe, expect, it } from 'vitest';
import { formatProblem, problemsFromZod, whereOf } from './problems.js';
import { factBankSchema } from './schema.js';
import { validFile } from './testing/valid-file.js';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function lines(raw: Obj): string[] {
  const r = factBankSchema.safeParse(raw);
  if (r.success) return [];
  return problemsFromZod(r.error, raw).map(formatProblem);
}

describe('whereOf', () => {
  it('adds the id after an answers or stories segment', () => {
    const raw = validFile();
    raw.answers[1].id = 'contractor-rate';
    expect(whereOf(['answers', 1, 'variants', 0, 'answer'], raw)).toBe(
      'answers[1] (id: contractor-rate).variants[0].answer',
    );
    expect(whereOf(['stories', 0, 'tags'], raw)).toBe(
      'stories[0] (id: migration-project).tags',
    );
  });

  it('does not add an id that is not kebab-case, and none for facts', () => {
    const raw = validFile();
    raw.answers[0].id = 'Secret Value';
    expect(whereOf(['answers', 0, 'id'], raw)).toBe('answers[0].id');
    expect(whereOf(['facts', 3], raw)).toBe('facts[3]');
    expect(whereOf(['fields', 'links', 'linkedin'], raw)).toBe(
      'fields.links.linkedin',
    );
  });
});

describe('problemsFromZod messages', () => {
  const cases: [string, (f: Obj) => void, string, string?][] = [
    [
      'bad email',
      (f) => (f.fields.email = 'sam.example.com'),
      'fields.email: must be an email address',
      'sam.example.com',
    ],
    [
      'bad country code',
      (f) => (f.fields.phone.countryCode = '44'),
      'fields.phone.countryCode: must start with + and digits',
    ],
    [
      'bad number',
      (f) => (f.fields.phone.number = '07700-abc'),
      'fields.phone.number: must be digits only',
      '07700-abc',
    ],
    [
      'bad linkedin',
      (f) => (f.fields.links.linkedin = 'http://www.linkedin.com/in/sam'),
      'fields.links.linkedin: must start with https://',
      'http://',
    ],
    [
      'bad date',
      (f) => (f.facts = [{ text: 'A fact.', confirmed: '2026-02-30' }]),
      'facts[0].confirmed: must be a date written YYYY-MM-DD',
      '2026-02-30',
    ],
    [
      'bad date in a variant',
      (f) => (f.answers[1].variants[0].confirmed = '2026-10-1'),
      'answers[1] (id: contractor-rate).variants[0].confirmed: must be a date written YYYY-MM-DD',
      '2026-10-1',
    ],
    [
      'bad id',
      (f) => (f.answers[0].id = 'Contractor_Rate'),
      'answers[0].id: must be kebab-case',
      'Contractor_Rate',
    ],
    [
      'bad tag',
      (f) => (f.stories[0].tags = ['Current Job']),
      'stories[0] (id: migration-project).tags[0]: must be kebab-case',
      'Current Job',
    ],
    [
      'both answer and variants',
      (f) => (f.answers[0].variants = [{ when: 'x', answer: 'y' }]),
      'answers[0] (id: notice-period): needs exactly one of answer or variants',
    ],
    [
      'neither',
      (f) => delete f.answers[0].answer,
      'answers[0] (id: notice-period): needs exactly one of answer or variants',
    ],
    [
      'missing key',
      (f) => delete f.fields.links.linkedin,
      'fields.links.linkedin: is required',
    ],
    [
      'wrong type',
      (f) => (f.fields.city = 5),
      'fields.city: must be a text value',
    ],
    [
      'null facts',
      (f) => (f.facts = null),
      'facts: must be a list (write [] for none)',
    ],
    [
      'unknown key',
      (f) => (f.answers[0].answr = 'x'),
      'answers[0] (id: notice-period): unknown key `answr`',
    ],
    [
      'unknown top-level key',
      (f) => (f.extra = 1),
      '(top level): unknown key `extra`',
    ],
    [
      'empty variants',
      (f) => {
        delete f.answers[0].answer;
        f.answers[0].variants = [];
      },
      'answers[0] (id: notice-period).variants: is not valid',
    ],
    [
      'empty value gives one message',
      (f) => (f.fields.links.github = ''),
      'fields.links.github: must not be empty',
    ],
    [
      'story without tags',
      (f) => (f.stories[0].tags = []),
      'stories[0] (id: migration-project).tags: is not valid',
    ],
  ];

  for (const [name, mutate, expected, secret] of cases) {
    it(name, () => {
      const f = validFile();
      mutate(f);
      const out = lines(f);
      expect(out).toContain(expected);
      if (secret) for (const l of out) expect(l).not.toContain(secret);
    });
  }

  it('does not echo an unsafe unknown key', () => {
    const f = validFile();
    f.fields['+44 7700900123'] = 'x';
    const out = lines(f);
    expect(out).toEqual(['fields: unknown key']);
  });

  it('reports a bad fact object at its full path, not as a union failure', () => {
    const f = validFile();
    f.facts = ['ok', 'ok', { text: 'A fact.', confirmed: '2026-02-30' }];
    expect(lines(f)).toEqual([
      'facts[2].confirmed: must be a date written YYYY-MM-DD',
    ]);
    const g = validFile();
    g.facts = [{ text: 'A fact.', nope: 1 }];
    expect(lines(g)).toEqual(['facts[0]: unknown key `nope`']);
    const h = validFile();
    h.facts = [{ tags: ['x'] }];
    expect(lines(h)).toEqual(['facts[0].text: is required']);
  });

  it('reports an empty value exactly once', () => {
    const f = validFile();
    f.fields.links.github = '';
    expect(lines(f)).toEqual(['fields.links.github: must not be empty']);
  });

  it('reports a fact of the wrong type simply', () => {
    const f = validFile();
    f.facts = [5];
    expect(lines(f)).toEqual(['facts[0]: is not valid']);
  });

  it('never prints a received value', () => {
    const f = validFile();
    f.fields.city = 12345;
    f.fields.firstName = '';
    for (const l of lines(f)) expect(l).not.toContain('12345');
  });
});
