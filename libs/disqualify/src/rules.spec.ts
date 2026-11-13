import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRules, loadRules, RulesError } from './rules.js';

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'disqualify.example.yaml',
);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rules-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

describe('disqualify.example.yaml', () => {
  it('loads with Morocco', () => {
    const r = checkRules(examplePath);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ authorizedCountries: 1 });
    expect(loadRules(examplePath)).toEqual({ authorizedCountries: ['MA'] });
  });
});

describe('checkRules', () => {
  it('normalises lower case to upper case', () => {
    const r = checkRules(
      write('lower.yaml', 'authorizedCountries: [ma, fr]\n'),
    );
    expect(r.rules?.authorizedCountries).toEqual(['MA', 'FR']);
  });

  it('de-duplicates silently', () => {
    const r = checkRules(write('dup.yaml', 'authorizedCountries: [MA, ma]\n'));
    expect(r.ok).toBe(true);
    expect(r.rules?.authorizedCountries).toEqual(['MA']);
    expect(r.counts.authorizedCountries).toBe(1);
  });

  it('reports a missing file as one problem without throwing', () => {
    const r = checkRules(join(dir, 'nope.yaml'));
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.rules).toBeUndefined();
  });

  it.each([
    ['empty list', 'authorizedCountries: []\n', null],
    ['region', 'authorizedCountries: [EU]\n', 'EU'],
    ['unassigned code', 'authorizedCountries: [XX]\n', 'XX'],
    ['UK alias', 'authorizedCountries: [UK]\n', 'UK'],
    [
      'unknown key',
      'authorizedCountries: [MA]\nsecretkeyname: 1\n',
      'secretkeyname',
    ],
    ['missing key', 'other: 1\n', null],
    ['not a mapping', '- MA\n', null],
    ['not a list', 'authorizedCountries: MA\n', 'MA'],
    ['syntax error', 'authorizedCountries: [MA\n', null],
    ['empty file', '', null],
  ])('gives a problem for %s without echoing the value', (_n, text, bad) => {
    const r = checkRules(write('bad.yaml', text));
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
    if (bad) {
      for (const p of r.problems) expect(p).not.toContain(bad);
    }
  });

  it('names the position of a bad entry', () => {
    const r = checkRules(write('pos.yaml', 'authorizedCountries: [MA, XX]\n'));
    expect(r.problems).toEqual([
      'authorizedCountries[1]: is not a country code',
    ]);
  });
});

describe('loadRules', () => {
  it('throws RulesError with the problems on a bad file', () => {
    const p = write('bad2.yaml', 'authorizedCountries: [EU]\n');
    expect(() => loadRules(p)).toThrow(RulesError);
    try {
      loadRules(p);
    } catch (e) {
      expect((e as RulesError).problems.length).toBeGreaterThan(0);
    }
  });
});
