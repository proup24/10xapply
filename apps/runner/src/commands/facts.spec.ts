import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult } from '@xapply/fact-bank';
import { factsCheckCommand, formatCheck } from './facts.js';

const GOOD_RULES = 'authorizedCountries: [MA, FR]\nlocatedIn: [MA]\n';

const EXAMPLE = 'libs/fact-bank/fact-bank.example.yaml';

const okResult: CheckResult = {
  path: '/some/where/fact-bank.yaml',
  ok: true,
  counts: { facts: 3, answers: 5, stories: 2 },
  size: { characters: 12345, tokens: 3087 },
  warnings: [],
  errors: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('formatCheck', () => {
  it('prints the path, counts and size for an ok result', () => {
    const text = formatCheck(okResult);
    expect(text).toContain('/some/where/fact-bank.yaml');
    expect(text).toContain('facts 3 · answers 5 · stories 2');
    expect(text).toContain('12,345 characters (~3,087 tokens)');
    expect(text).not.toContain('errors:');
  });

  it('prints errors and warnings one line each', () => {
    const text = formatCheck({
      ...okResult,
      ok: false,
      warnings: [{ where: 'facts', message: 'is big' }],
      errors: [
        { where: 'a.b', message: 'is not valid' },
        { where: 'c', message: 'is missing' },
      ],
    });
    expect(text).toContain('warnings:\n  facts: is big');
    expect(text).toContain('errors:\n  a.b: is not valid\n  c: is missing');
  });
});

function tempRules(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rules-'));
  dirs.push(dir);
  const file = join(dir, 'disqualify.yaml');
  writeFileSync(file, text);
  return file;
}

describe('factsCheckCommand', () => {
  it('returns 0 for the example file', () => {
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: EXAMPLE,
        rulesPath: tempRules(GOOD_RULES),
        log: (l) => lines.push(l),
      }),
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('facts ');
    expect(text).toContain('rules: ');
    expect(text).toContain('authorized countries 2');
    expect(text).toContain('located in 1');
    expect(text).not.toMatch(/\bMA\b|\bFR\b/);
  });

  it('returns 1 for a bad rules file and prints no code', () => {
    const rulesPath = tempRules(
      'authorizedCountries: [MA, ZZ]\nlocatedIn: [MA]\nextra: Zorblax\n',
    );
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: EXAMPLE,
        rulesPath,
        log: (l) => lines.push(l),
      }),
    ).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`rules: ${rulesPath}`);
    expect(text).toContain('authorized countries 0');
    expect(text).toContain('unknown key');
    expect(text).not.toMatch(/\bMA\b|\bZZ\b|Zorblax/);
  });

  it('counts the misses file when it exists and returns 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'misses-'));
    dirs.push(dir);
    const missesPath = join(dir, 'answer-misses.yaml');
    writeFileSync(missesPath, 'version: 1\njobs: {}\nmisses: []\n');
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: EXAMPLE,
        rulesPath: tempRules(GOOD_RULES),
        missesPath,
        log: (l) => lines.push(l),
      }),
    ).toBe(0);
    expect(lines.join('\n')).toContain('misses 0');
  });

  it('returns 1 for a bad misses file and prints none of its values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'misses-'));
    dirs.push(dir);
    const missesPath = join(dir, 'answer-misses.yaml');
    writeFileSync(missesPath, 'version: 1\nzq9secret: Zorblax\nmisses: 7\n');
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: EXAMPLE,
        rulesPath: tempRules(GOOD_RULES),
        missesPath,
        log: (l) => lines.push(l),
      }),
    ).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('misses: errors:');
    expect(text).not.toContain('Zorblax');
  });

  it('returns 1 for a missing rules file', () => {
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: EXAMPLE,
        rulesPath: join(tmpdir(), 'no-such-rules-file.yaml'),
        log: (l) => lines.push(l),
      }),
    ).toBe(1);
    expect(lines.join('\n')).toContain('not found');
  });

  it('returns 1 for a broken file and logs none of its values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-'));
    dirs.push(dir);
    const file = join(dir, 'bank.yaml');
    writeFileSync(
      file,
      'version: 1\nfullName: Zorblax Quindleton\nemail: not-an-email-zq9\nphone: 555-0199-zq9\n',
    );
    const lines: string[] = [];
    expect(
      factsCheckCommand({
        path: file,
        rulesPath: tempRules(GOOD_RULES),
        log: (l) => lines.push(l),
      }),
    ).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('errors:');
    for (const secret of [
      'Zorblax',
      'Quindleton',
      'not-an-email-zq9',
      '0199',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
