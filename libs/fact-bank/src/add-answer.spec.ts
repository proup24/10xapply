import {
  copyFileSync,
  chmodSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKnownAnswer, answerIdFrom, personalWords } from './add-answer.js';
import { loadFactBank } from './bank.js';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const opts = {
  company: null,
  jobTitle: null,
  today: '2026-11-12',
  stamp: '20261112T101500',
};

describe('answerIdFrom', () => {
  it('drops digits', () => {
    expect(answerIdFrom('Is +44 7700 900123 your number?', new Set())).toBe(
      'is-your-number',
    );
  });
  it('keeps the first 6 words', () => {
    expect(
      answerIdFrom('one two three four five six seven eight nine', new Set()),
    ).toBe('one-two-three-four-five-six');
  });
  it('numbers a taken id', () => {
    expect(answerIdFrom('Notice period', new Set(['notice-period']))).toBe(
      'notice-period-2',
    );
    expect(
      answerIdFrom(
        'Notice period',
        new Set(['notice-period', 'notice-period-2']),
      ),
    ).toBe('notice-period-3');
  });
  it('falls back to answer', () => {
    expect(answerIdFrom('123', new Set())).toBe('answer');
  });
  it("drops the bank owner's email and name words", () => {
    const own = personalWords({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane.doe@example.com',
    });
    expect(
      answerIdFrom('Is jane.doe@example.com your email?', new Set(), own),
    ).toBe('is-your-email');
    expect(answerIdFrom('Is JANE Doe your legal name?', new Set(), own)).toBe(
      'is-your-legal-name',
    );
  });
  it('splits email words on dots, underscores, dashes and plus signs', () => {
    expect(
      [
        ...personalWords({
          firstName: 'Ann-Marie',
          lastName: "O'Neil",
          email: 'a_b-c+d.e@mail.my-host.co.uk',
        }),
      ].sort(),
    ).toEqual(
      [
        'a',
        'ann',
        'b',
        'c',
        'co',
        'd',
        'e',
        'host',
        'mail',
        'marie',
        'my',
        'neil',
        'o',
        'uk',
      ].sort(),
    );
  });
});

describe('addKnownAnswer', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'add-answer-'));
    mkdirSync(join(dir, 'test-fixtures'));
    copyFileSync(
      join(libDir, 'test-fixtures', 'resume.pdf'),
      join(dir, 'test-fixtures', 'resume.pdf'),
    );
    path = join(dir, 'bank.yaml');
    writeFileSync(
      path,
      '# keep me\n' +
        readFileSync(join(libDir, 'fact-bank.example.yaml'), 'utf8'),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends a known answer and keeps comments', () => {
    const r = addKnownAnswer(
      path,
      { question: 'Do you like tea?', answer: 'Yes' },
      opts,
    );
    expect(r).toEqual({ ok: true, id: 'do-you-like-tea' });
    expect(readFileSync(path, 'utf8')).toContain('# keep me');
    expect(readFileSync(path, 'utf8')).toContain('# Known answers:');
    const a = loadFactBank(path).answers.find(
      (x) => x.id === 'do-you-like-tea',
    );
    expect(a?.answer).toBe('Yes');
    expect(a?.confirmed).toBe('2026-11-12');
    expect(existsSync(`${path}.20261112T101500.bak`)).toBe(true);
  });

  it('replaces company and job title with placeholders', () => {
    const r = addKnownAnswer(
      path,
      {
        question: 'Why do you want to work at ACME Corp as Staff Engineer?',
        answer: 'I admire acme corp and the staff engineer role.',
      },
      { ...opts, company: 'Acme Corp', jobTitle: 'Staff Engineer' },
    );
    expect(r.ok).toBe(true);
    const a = loadFactBank(path).answers.at(-1);
    expect(a?.question).toBe(
      'Why do you want to work at {company} as {jobTitle}?',
    );
    expect(a?.answer).toBe('I admire {company} and the {jobTitle} role.');
  });

  it('check failure restores the backup', () => {
    const before = readFileSync(path);
    const r = addKnownAnswer(
      path,
      { question: 'Anything?', answer: 'Hello {unknown}' },
      opts,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.length).toBeGreaterThan(0);
      expect(r.problems.join('\n')).not.toContain('Hello');
    }
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('matches whole occurrences only', () => {
    const r = addKnownAnswer(
      path,
      {
        question: 'Do you like search at Arc and software engineering?',
        answer: 'Arc is fine; Software Engineer too, not software engineering.',
      },
      { ...opts, company: 'Arc', jobTitle: 'Software Engineer' },
    );
    expect(r.ok).toBe(true);
    const a = loadFactBank(path).answers.at(-1);
    expect(a?.question).toBe(
      'Do you like search at {company} and software engineering?',
    );
    expect(a?.answer).toBe(
      '{company} is fine; {jobTitle} too, not software engineering.',
    );
  });

  it('does not let a title hit an inserted company token', () => {
    addKnownAnswer(
      path,
      { question: 'Tell me about Zed', answer: 'Zed is a company.' },
      { ...opts, company: 'Zed', jobTitle: 'Company' },
    );
    const a = loadFactBank(path).answers.at(-1);
    expect(a?.answer).toBe('{company} is a {jobTitle}.');
  });

  it('skips null and short values', () => {
    addKnownAnswer(
      path,
      { question: 'Is it at Ab as QA?', answer: 'Ab as QA.' },
      { ...opts, company: 'Ab', jobTitle: null },
    );
    const a = loadFactBank(path).answers.at(-1);
    expect(a?.question).toBe('Is it at Ab as QA?');
    expect(a?.answer).toBe('Ab as QA.');
  });

  it("leaves the bank owner's email and name out of the id", () => {
    const email = addKnownAnswer(
      path,
      { question: 'Is sam@example.com your email?', answer: 'Yes, it is' },
      opts,
    );
    expect(email).toEqual({ ok: true, id: 'is-your-email' });
    const name = addKnownAnswer(
      path,
      { question: 'Is Sam Example your full name?', answer: 'Yes, it is' },
      { ...opts, stamp: `${opts.stamp}-2` },
    );
    expect(name).toEqual({ ok: true, id: 'is-your-full-name' });
  });

  it('builds the id from the substituted question', () => {
    const r = addKnownAnswer(
      path,
      { question: 'Why Initech?', answer: 'Because.' },
      { ...opts, company: 'Initech', jobTitle: null },
    );
    expect(r).toEqual({ ok: true, id: 'why-company' });
  });

  it('keeps the author layout apart from the new block', () => {
    const before = readFileSync(path, 'utf8');
    addKnownAnswer(
      path,
      {
        question: 'Do you like tea?',
        answer: 'A long answer '.repeat(20).trim(),
      },
      opts,
    );
    const lines = readFileSync(path, 'utf8').split('\n');
    const i = lines.indexOf('  - id: do-you-like-tea');
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i, i + 4).join('\n')).toContain('confirmed');
    lines.splice(i, 4);
    expect(lines.join('\n')).toBe(before);
  });

  it('leaves no temp file and keeps the file mode', () => {
    chmodSync(path, 0o600);
    addKnownAnswer(path, { question: 'Tea?', answer: 'Yes' }, opts);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    addKnownAnswer(
      path,
      { question: 'Bad', answer: '{nope}' },
      { ...opts, stamp: 'x2' },
    );
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to overwrite an existing backup', () => {
    writeFileSync(`${path}.${opts.stamp}.bak`, 'old');
    const before = readFileSync(path);
    const r = addKnownAnswer(path, { question: 'Tea?', answer: 'Yes' }, opts);
    expect(r.ok).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}.${opts.stamp}.bak`, 'utf8')).toBe('old');
  });
});
