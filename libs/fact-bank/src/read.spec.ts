import { describe, expect, it } from 'vitest';
import { formatProblem } from './problems.js';
import { readYaml } from './read.js';

const MINIMAL = `version: "1"
fields:
  phone:
    number: 07700900123
facts:
  - 5000
  - Yes
  - 2026-10-01
`;

describe('readYaml', () => {
  it('keeps every scalar as a string', () => {
    const r = readYaml(MINIMAL);
    expect(r.problems).toEqual([]);
    const raw = r.raw as {
      fields: { phone: { number: unknown } };
      facts: unknown[];
    };
    expect(raw.fields.phone.number).toBe('07700900123');
    expect(raw.facts).toEqual(['5000', 'Yes', '2026-10-01']);
  });

  it('gives the same result for CRLF endings and a BOM', () => {
    const a = readYaml(MINIMAL);
    const b = readYaml('\uFEFF' + MINIMAL.replace(/\n/g, '\r\n'));
    expect(b.problems).toEqual([]);
    expect(b.raw).toEqual(a.raw);
  });

  it('reports a duplicate key with a line and column only', () => {
    const r = readYaml('a: 1\na: 2\n');
    expect(r.raw).toBeUndefined();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].where).toMatch(/^line \d+, column \d+$/);
    expect(r.problems[0].message).toBe('YAML syntax error');
  });

  it('reports a tab-indented line without quoting it', () => {
    const r = readYaml('a:\n\tsecret-value-here: 1\n');
    expect(r.problems.length).toBeGreaterThan(0);
    for (const p of r.problems) {
      expect(p.where).toMatch(/^line \d+, column \d+$/);
      expect(formatProblem(p)).not.toContain('secret-value-here');
    }
  });

  it('rejects anchors and aliases', () => {
    for (const text of ['a: &x 1\n', 'a: &x 1\nb: *x\n']) {
      const r = readYaml(text);
      expect(r.raw).toBeUndefined();
      expect(r.problems.map((p) => p.message)).toContain(
        'YAML anchors and aliases are not allowed',
      );
    }
    const alias = readYaml('a: &x 1\nb: *x\n');
    expect(alias.problems.length).toBeGreaterThan(0);
  });
});
