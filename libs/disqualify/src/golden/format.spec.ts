import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DisqualifyGoldenError, loadDisqualifyGolden } from './format.js';

const dir = mkdtempSync(join(tmpdir(), 'disq-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(text: string): string {
  const path = join(dir, `set-${n++}.yaml`);
  writeFileSync(path, text);
  return path;
}

const header = `
rules:
  authorizedCountries: [ma]
defaultJob:
  title: Backend Engineer
  company: Acme
  description: A job.
cases:
`;
const q = `
    questions:
      - { label: Are you authorized to work in the US?, type: radio, options: [Yes, No] }
`;
const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
};

describe('loadDisqualifyGolden', () => {
  it('loads a valid file, defaulting checkJob and normalising the rules', () => {
    const g = loadDisqualifyGolden(
      write(`${header}
  - id: a
    group: authorization${q}
    expect:
      verdict: disqualified
      claims: [{ kind: asks-authorization, countries: [US] }]
  - id: b
    group: job-page
    job: { title: T, company: C, description: D }
    expect: { verdict: pass, claims: [] }
`),
    );
    expect(g.rules.authorizedCountries).toEqual(['MA']);
    expect(g.cases.map((c) => [c.id, c.checkJob])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(g.cases[0]?.job).toBeUndefined();
  });

  it('rejects a duplicate id', () => {
    const e = thrown(() =>
      loadDisqualifyGolden(
        write(`${header}
  - id: a
    group: authorization${q}
    expect: { verdict: pass, claims: [] }
  - id: a
    group: authorization${q}
    expect: { verdict: pass, claims: [] }
`),
      ),
    );
    expect(e).toBeInstanceOf(DisqualifyGoldenError);
    expect(e.message).toContain('duplicated case ids: a');
  });

  it('rejects an unknown group', () => {
    const e = thrown(() =>
      loadDisqualifyGolden(
        write(`${header}
  - id: a
    group: nonsense${q}
    expect: { verdict: pass, claims: [] }
`),
      ),
    );
    expect(e).toBeInstanceOf(DisqualifyGoldenError);
    expect(e.message).toContain('case a');
  });

  it('rejects a bad country in an expected claim', () => {
    const e = thrown(() =>
      loadDisqualifyGolden(
        write(`${header}
  - id: a
    group: authorization${q}
    expect:
      verdict: disqualified
      claims: [{ kind: asks-authorization, countries: [Narnia] }]
`),
      ),
    );
    expect(e).toBeInstanceOf(DisqualifyGoldenError);
    expect(e.message).toContain('case a');
    expect(e.message).not.toContain('Narnia');
  });

  it('rejects bad rules', () => {
    const e = thrown(() =>
      loadDisqualifyGolden(
        write(
          header.replace('[ma]', '[ZZ]') +
            `
  - id: a
    group: authorization${q}
    expect: { verdict: pass, claims: [] }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(DisqualifyGoldenError);
    expect(e.message).toContain('rules');
  });

  it('rejects a case with neither job nor questions', () => {
    const e = thrown(() =>
      loadDisqualifyGolden(
        write(`${header}
  - id: a
    group: authorization
    expect: { verdict: pass, claims: [] }
`),
      ),
    );
    expect(e).toBeInstanceOf(DisqualifyGoldenError);
    expect(e.message).toContain('case a');
  });

  it('rejects a missing file and bad YAML', () => {
    expect(() => loadDisqualifyGolden(join(dir, 'nope.yaml'))).toThrow(
      DisqualifyGoldenError,
    );
    expect(() => loadDisqualifyGolden(write('a: [1'))).toThrow(
      DisqualifyGoldenError,
    );
  });
});
