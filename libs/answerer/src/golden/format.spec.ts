import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GoldenError, loadGolden } from './format.js';

const dir = mkdtempSync(join(tmpdir(), 'golden-format-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(text: string): string {
  const path = join(dir, `set-${n++}.yaml`);
  writeFileSync(path, text);
  return path;
}

const header = `
runDate: '2026-11-12'
jobs:
  default:
    title: Backend Engineer
    company: Acme Payments
    description: A job.
cases:
`;

const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
};

describe('loadGolden', () => {
  it('loads a valid file, defaulting the question id, job source and job name', () => {
    const file = loadGolden(
      write(
        header +
          `
  - id: notice
    question: { label: What is your notice period?, type: select, options: [A, B], required: true }
    expect: { status: backed, value: A, sources: [{ fact: 3 }], derivation: bucket }
  - id: blog
    question: { id: q-blog, label: A blog?, type: textarea, required: false }
    job: default
    expect: { status: blocked }
`,
      ),
    );
    expect(file.runDate).toBe('2026-11-12');
    expect(file.jobs.default?.source).toBe('LinkedIn');
    expect(file.cases.map((c) => c.question.id)).toEqual(['notice', 'q-blog']);
    expect(file.cases[0]?.expect).toEqual({
      status: 'backed',
      value: 'A',
      sources: [{ fact: 3 }],
      derivation: 'bucket',
    });
    expect(file.bank).toBeUndefined();
  });

  it('resolves bank relative to the golden file folder', () => {
    const file = loadGolden(write(`bank: ../bank.yaml\n${header}  []\n`));
    expect(file.bank).toBe(join(dir, '..', 'bank.yaml'));
  });

  it('throws naming the case id when a value is TODO-author', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: salary-yearly
    question: { label: Salary?, type: text, required: true }
    expect: { status: backed, value: TODO-author, sources: [{ answer: x }] }
  - id: options-pick
    question: { label: Pick, type: checkbox-group, options: [A, B], required: true }
    expect: { status: backed, value: [A, TODO-author], sources: [{ fact: 0 }] }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('salary-yearly');
    expect(e.message).toContain('options-pick');
  });

  it('throws on an unknown key', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: a
    question: { label: A, type: text, required: true, colour: red }
    expect: { status: blocked }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('colour');
  });

  it('throws on an unknown key in expect', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: a
    question: { label: A, type: text, required: true }
    expect: { status: blocked, because: reasons }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('because');
  });

  it('throws naming the case id when its job is not defined', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: other-job-case
    question: { label: A, type: text, required: true }
    job: frontend
    expect: { status: blocked }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('other-job-case');
  });

  it('throws when a case uses the default job and none is defined', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          `runDate: '2026-11-12'
jobs:
  other: { title: T, company: C, description: D }
cases:
  - id: needs-default
    question: { label: A, type: text, required: true }
    expect: { status: blocked }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('needs-default');
  });

  it('throws naming duplicated ids', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: twice
    question: { label: A, type: text, required: true }
    expect: { status: blocked }
  - id: twice
    question: { label: B, type: text, required: true }
    expect: { status: blocked }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).toContain('twice');
  });

  it('throws when value and valueFrom are both given, or reason on a backed case', () => {
    for (const expectYaml of [
      '{ status: backed, value: A, valueFrom: { field: city } }',
      '{ status: backed, reason: bank-silent }',
    ]) {
      const e = thrown(() =>
        loadGolden(
          write(
            header +
              `
  - id: bad-expect
    question: { label: A, type: text, required: true }
    expect: ${expectYaml}
`,
          ),
        ),
      );
      expect(e).toBeInstanceOf(GoldenError);
      expect(e.message).toContain('bad-expect');
    }
  });

  it('throws on a bad block reason, derivation or runDate', () => {
    for (const text of [
      header +
        `
  - id: a
    question: { label: A, type: text, required: true }
    expect: { status: blocked, reason: not-a-reason }
`,
      header +
        `
  - id: a
    question: { label: A, type: text, required: true }
    expect: { status: backed, derivation: guessed }
`,
      header.replace("'2026-11-12'", "'12/11/2026'") + '  []\n',
    ]) {
      expect(thrown(() => loadGolden(write(text)))).toBeInstanceOf(GoldenError);
    }
  });

  it('never echoes a value from the file in an error', () => {
    const e = thrown(() =>
      loadGolden(
        write(
          header +
            `
  - id: a
    question: { label: My secret label, type: 42, required: true }
    expect: { status: backed, value: secret-value-text, sources: [{ fact: secret }] }
`,
        ),
      ),
    );
    expect(e).toBeInstanceOf(GoldenError);
    expect(e.message).not.toContain('secret');
  });

  it('prints nothing on a YAML warning, which would quote the source', () => {
    // The yaml library warns through process.emitWarning, or console.warn without it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emit = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
    try {
      const file = loadGolden(
        write(
          header.replace(
            "runDate: '2026-11-12'",
            "runDate: !secret-tag '2026-11-12'",
          ) + '  []\n',
        ),
      );
      expect(file.runDate).toBe('2026-11-12');
      expect(warn).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      emit.mockRestore();
    }
  });

  it('throws a GoldenError on a YAML syntax error or a missing file', () => {
    expect(thrown(() => loadGolden(write('cases: [\n')))).toBeInstanceOf(
      GoldenError,
    );
    expect(thrown(() => loadGolden(join(dir, 'missing.yaml')))).toBeInstanceOf(
      GoldenError,
    );
  });
});
