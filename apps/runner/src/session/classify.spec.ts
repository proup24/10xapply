import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import {
  CHALLENGE,
  SIGN_IN_FORM,
  classifySession,
  type PageResult,
} from './classify.js';

describe('classifySession', () => {
  it.each<[string, number, number, PageResult]>([
    ['/feed/foryou/', 0, 0, 'signed-in'],
    ['/feed/', 1, 0, 'signed-out'],
    ['/login', 0, 0, 'signed-out'],
    ['/uas/login', 0, 0, 'signed-out'],
    ['/authwall', 0, 0, 'signed-out'],
    ['/checkpoint/challenge/x', 0, 0, 'security-check'],
    ['/feed/', 0, 1, 'security-check'],
    ['/login', 0, 1, 'security-check'],
    ['/jobs/view/1', 0, 0, 'unexpected-page'],
  ])(
    '%s forms=%i challenges=%i -> %s',
    (path, signInForms, challenges, want) => {
      expect(classifySession({ path, signInForms, challenges })).toBe(want);
    },
  );
});

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
// Rows of the README table: | file | path | expected | source | scrubbed |
const rows = readFileSync(join(dir, 'README.md'), 'utf8')
  .split('\n')
  .filter((l) => /^\|\s*\S+\.html\s*\|/.test(l))
  .map((l) => l.split('|').map((c) => c.trim()))
  .map(([, file, path, expected]) => ({ file, path, expected }));

describe('fixtures', () => {
  it('lists at least one fixture', () => {
    expect(rows.length).toBeGreaterThan(0);
  });
  it('has a README row for every fixture file', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
    const listed = new Set(rows.map((r) => r.file));
    expect(files.filter((f) => !listed.has(f))).toEqual([]);
  });
  it.each(rows)(
    '$file at $path classifies as $expected',
    ({ file, path, expected }) => {
      const { document } = parseHTML(readFileSync(join(dir, file), 'utf8'));
      const result = classifySession({
        path,
        signInForms: document.querySelectorAll(SIGN_IN_FORM).length,
        challenges: document.querySelectorAll(CHALLENGE).length,
      });
      expect(result).toBe(expected);
    },
  );
});
