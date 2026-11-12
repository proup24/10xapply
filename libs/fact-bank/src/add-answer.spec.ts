import {
  copyFileSync,
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
import { addKnownAnswer, answerIdFrom } from './add-answer.js';
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
});
