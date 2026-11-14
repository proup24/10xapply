import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  goldenFileSchema,
  type AnswerResult,
  type FormQuestion,
  type Job,
} from '@xapply/answerer';
import {
  loadMisses,
  mergeMisses,
  missesFromRun,
  missesToGolden,
  saveMisses,
  type Miss,
  type MissesFile,
} from './misses.js';
import type { ApplyRun, QuestionRecord } from './types.js';

// Midday, so the local date is the same in every time zone the tests run in.
const STARTED = '2026-11-14T12:00:00.000Z';
const LATER = '2026-11-15T12:00:00.000Z';

const JOB: Job = {
  title: 'Engineer',
  company: 'Acme',
  description: 'Build things.',
  source: 'LinkedIn',
};

const calls = [
  {
    role: 'answer' as const,
    model: 'm',
    latencyMs: 5,
    costUsd: 0.01,
    ok: true,
  },
];

function question(over: Partial<FormQuestion> = {}): FormQuestion {
  return {
    id: 's1-q1',
    label: 'Years of experience with Go?',
    type: 'number',
    required: true,
    stepLabels: ['Other question'],
    ...over,
  };
}

const blockedResult = (q: FormQuestion): AnswerResult => ({
  questionId: q.id,
  required: q.required,
  calls,
  status: 'blocked',
  reason: 'bank-silent',
  detail: 'no fact about Go',
});

const backedResult = (q: FormQuestion): AnswerResult => ({
  questionId: q.id,
  required: q.required,
  calls,
  status: 'backed',
  value: '3',
  sources: [{ kind: 'run-date' }],
  derivation: 'math',
  inferences: [],
  verification: { verdict: 'not-needed', rounds: 0 },
});

function rec(over: Partial<QuestionRecord> = {}): QuestionRecord {
  const q = over.question ?? question();
  return {
    step: 1,
    question: q,
    result: blockedResult(q),
    by: 'author',
    filled: '5',
    changedFromLinkedIn: false,
    ...over,
  };
}

function makeRun(
  questions: QuestionRecord[],
  over: Partial<ApplyRun> = {},
): ApplyRun {
  return {
    jobId: '123',
    startedAt: STARTED,
    outcome: 'reached-review',
    job: JOB,
    questions,
    unknownFields: [],
    checks: [],
    disqualification: null,
    via: null,
    record: { before: null, beforeAt: null, after: null },
    timings: { totalMs: 10, perStepMs: [5], submit: null },
    ...over,
  };
}

const empty = (): MissesFile => ({ version: 1, jobs: {}, misses: [] });

function only(ms: Miss[]): Miss {
  expect(ms).toHaveLength(1);
  return ms[0] as Miss;
}

describe('missesFromRun', () => {
  it('a blocked question answered at the terminal is a typed miss', () => {
    const m = only(
      missesFromRun(makeRun([rec({ savedAs: 'go-years', filled: '5' })])),
    );
    expect(m).toEqual({
      id: '123-years-of-experience-with-go-number',
      jobId: '123',
      firstSeenAt: STARTED,
      lastSeenAt: STARTED,
      runDate: '2026-11-14',
      question: {
        label: 'Years of experience with Go?',
        type: 'number',
        required: true,
      },
      answer: { kind: 'typed', value: '5', via: 'terminal' },
      reason: 'bank-silent',
      detail: 'no fact about Go',
      sources: [],
      savedAs: 'go-years',
    });
  });

  it('needs-author is a stopped miss', () => {
    const m = only(
      missesFromRun(makeRun([rec({ by: 'needs-author', filled: null })])),
    );
    expect(m.answer).toEqual({ kind: 'stopped' });
    expect(m.savedAs).toBeNull();
  });

  it('blank is a blank miss', () => {
    const m = only(
      missesFromRun(makeRun([rec({ by: 'blank', filled: null })])),
    );
    expect(m.answer).toEqual({ kind: 'blank' });
  });

  it('a backed question is not a miss', () => {
    const q = question();
    expect(
      missesFromRun(
        makeRun([rec({ result: backedResult(q), by: 'bot', filled: '3' })]),
      ),
    ).toEqual([]);
  });

  it('a backed question with a fillProblem is not a miss either', () => {
    const q = question();
    expect(
      missesFromRun(
        makeRun([
          rec({
            result: backedResult(q),
            by: 'author',
            filled: '4',
            fillProblem: 'not-typeable',
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('result null with by needs-author is reason not-reached', () => {
    const m = only(
      missesFromRun(
        makeRun([rec({ result: null, by: 'needs-author', filled: null })]),
      ),
    );
    expect(m.reason).toBe('not-reached');
    expect(m.detail).toBe('');
    expect(m.answer).toEqual({ kind: 'stopped' });
  });
});

describe('mergeMisses', () => {
  it('merge keeps a chat answer', () => {
    const first = makeRun([rec({ by: 'needs-author', filled: null })]);
    let file = mergeMisses(empty(), first, missesFromRun(first));
    const edited = only(file.misses);
    file = {
      ...file,
      misses: [
        { ...edited, answer: { kind: 'typed', value: '6', via: 'chat' } },
      ],
    };
    const again = makeRun([rec({ by: 'needs-author', filled: null })], {
      startedAt: LATER,
    });
    const merged = mergeMisses(file, again, missesFromRun(again));
    const m = only(merged.misses);
    expect(m.answer).toEqual({ kind: 'typed', value: '6', via: 'chat' });
    expect(m.lastSeenAt).toBe(LATER);
    expect(m.firstSeenAt).toBe(STARTED);
    expect(m.runDate).toBe('2026-11-14');
  });

  it('merge replaces stopped with a new terminal answer', () => {
    const first = makeRun([rec({ by: 'needs-author', filled: null })]);
    const file = mergeMisses(empty(), first, missesFromRun(first));
    const again = makeRun([rec({ by: 'author', filled: '7' })], {
      startedAt: LATER,
    });
    const m = only(mergeMisses(file, again, missesFromRun(again)).misses);
    expect(m.answer).toEqual({ kind: 'typed', value: '7', via: 'terminal' });
    expect(m.lastSeenAt).toBe(LATER);
  });

  it('merge adds the job once under jobs', () => {
    const first = makeRun([rec()]);
    let file = mergeMisses(empty(), first, missesFromRun(first));
    const other = makeRun(
      [rec({ question: question({ label: 'Another question' }) })],
      { startedAt: LATER },
    );
    file = mergeMisses(file, other, missesFromRun(other));
    expect(Object.keys(file.jobs)).toEqual(['123']);
    expect(file.jobs['123']).toEqual(JOB);
    expect(file.misses).toHaveLength(2);
  });

  it('a run with no misses adds no job', () => {
    const q = question();
    const run = makeRun([rec({ result: backedResult(q), by: 'bot' })]);
    expect(mergeMisses(empty(), run, missesFromRun(run))).toEqual(empty());
  });
});

describe('missesToGolden', () => {
  function fileOf(records: QuestionRecord[]): MissesFile {
    const run = makeRun(records);
    return mergeMisses(empty(), run, missesFromRun(run));
  }

  it('a typed choice or number miss expects its value', () => {
    const file = fileOf([
      rec({
        question: question({
          id: 'a',
          label: 'Sponsorship?',
          type: 'radio',
          options: ['Yes', 'No'],
        }),
        filled: 'No',
      }),
      rec({
        question: question({
          id: 'b',
          label: 'Tools',
          type: 'checkbox-group',
          options: ['Go', 'Rust'],
        }),
        filled: ['Go', 'Rust'],
      }),
      rec({
        question: question({ id: 'c', label: 'Pick', type: 'select' }),
        filled: 'One',
      }),
      rec({
        question: question({ id: 'd', label: 'Agree', type: 'checkbox' }),
        filled: 'Yes',
      }),
      rec({
        question: question({ id: 'e', label: 'Years', type: 'number' }),
        filled: '5',
      }),
    ]);
    const g = missesToGolden(file);
    expect(g.cases.map((c) => c.expect)).toEqual([
      { status: 'backed', value: 'No' },
      { status: 'backed', value: ['Go', 'Rust'] },
      { status: 'backed', value: 'One' },
      { status: 'backed', value: 'Yes' },
      { status: 'backed', value: '5' },
    ]);
  });

  it('a typed date miss expects its YYYY-MM-DD value', () => {
    const file = fileOf([
      rec({
        question: question({
          id: 'a',
          label: 'Earliest start date',
          type: 'date',
        }),
        filled: '2026-11-19',
      }),
    ]);
    expect(missesToGolden(file).cases.map((c) => c.expect)).toEqual([
      { status: 'backed', value: '2026-11-19' },
    ]);
  });

  it('a typed text, textarea or typeahead miss expects backed only', () => {
    const file = fileOf(
      (['text', 'textarea', 'typeahead'] as const).map((type) =>
        rec({
          question: question({ id: type, label: `Q ${type}`, type }),
          filled: 'my words',
        }),
      ),
    );
    expect(missesToGolden(file).cases.map((c) => c.expect)).toEqual([
      { status: 'backed' },
      { status: 'backed' },
      { status: 'backed' },
    ]);
  });

  it('leaves out blank and stopped misses', () => {
    const file = fileOf([
      rec({
        question: question({ id: 'a', label: 'Blank one' }),
        by: 'blank',
        filled: null,
      }),
      rec({
        question: question({ id: 'b', label: 'Stopped one' }),
        by: 'needs-author',
        filled: null,
      }),
      rec({ question: question({ id: 'c', label: 'Typed one' }) }),
    ]);
    expect(missesToGolden(file).cases.map((c) => c.id)).toEqual([
      '123-typed-one-number',
    ]);
  });

  it('gives each case its run date and job, and passes the golden schema', () => {
    const first = makeRun(
      [rec({ question: question({ label: 'Later one' }) })],
      {
        startedAt: LATER,
      },
    );
    let file = mergeMisses(empty(), first, missesFromRun(first));
    const second = makeRun(
      [rec({ question: question({ label: 'Earlier one' }) })],
      { jobId: '456' },
    );
    file = mergeMisses(file, second, missesFromRun(second));
    const g = missesToGolden(file);
    expect(g.bank).toBeUndefined();
    expect(g.runDate).toBe('2026-11-14');
    expect(
      g.cases.map((c) => ({ id: c.id, job: c.job, runDate: c.runDate })),
    ).toEqual([
      { id: '123-later-one-number', job: '123', runDate: '2026-11-15' },
      { id: '456-earlier-one-number', job: '456', runDate: '2026-11-14' },
    ]);
    expect(Object.keys(g.jobs).sort()).toEqual(['123', '456']);
    expect(g.cases[0]?.question).toEqual({
      id: '123-later-one-number',
      label: 'Later one',
      type: 'number',
      required: true,
    });
    expect(goldenFileSchema.safeParse(g).success).toBe(true);
  });
});

describe('loadMisses and saveMisses', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'misses-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file is empty', () => {
    expect(loadMisses(join(dir, 'none.yaml'))).toEqual(empty());
  });

  it('round-trips through YAML', () => {
    const run = makeRun([
      rec({ savedAs: 'go-years' }),
      rec({
        question: question({
          label: 'Tools',
          type: 'checkbox-group',
          options: ['Go', 'Rust'],
          helpText: 'Pick any',
        }),
        filled: ['Go'],
      }),
      rec({
        question: question({ label: 'Not reached' }),
        result: null,
        by: 'needs-author',
        filled: null,
      }),
    ]);
    const file = mergeMisses(empty(), run, missesFromRun(run));
    const path = join(dir, 'sub', 'answer-misses.yaml');
    saveMisses(path, file);
    expect(readFileSync(path, 'utf8')).toContain('version: 1');
    expect(loadMisses(path)).toEqual(file);
  });

  it('loadMisses rejects a file that fails the schema', () => {
    const SENTINEL = 'SENTINEL-SECRET-VALUE-42';
    const path = join(dir, 'answer-misses.yaml');
    writeFileSync(
      path,
      [
        'version: 1',
        'jobs: {}',
        'misses:',
        `  - id: ${SENTINEL}`,
        '    jobId: "123"',
        `    firstSeenAt: ${SENTINEL}`,
        `    lastSeenAt: ${SENTINEL}`,
        `    runDate: ${SENTINEL}`,
        '    question:',
        `      label: ${SENTINEL}`,
        '      type: text',
        '      required: true',
        '    answer:',
        `      kind: ${SENTINEL}`,
        `      value: ${SENTINEL}`,
        `    reason: ${SENTINEL}`,
        `    detail: ${SENTINEL}`,
        '    sources: []',
        '    savedAs: null',
        `    extra: ${SENTINEL}`,
        '',
      ].join('\n'),
    );
    let message = '';
    try {
      loadMisses(path);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(path);
    expect(message).toMatch(/misses\.0\.runDate/);
    expect(message).toMatch(/misses\.0\.answer/);
    expect(message).toMatch(/misses\.0\.reason/);
    expect(message).toMatch(/extra/);
    expect(message).not.toContain('SENTINEL');
  });

  it('loadMisses rejects bad YAML without quoting it', () => {
    const path = join(dir, 'answer-misses.yaml');
    writeFileSync(path, 'version: 1\nmisses: [SENTINEL-VALUE\n');
    expect(() => loadMisses(path)).toThrow(/YAML syntax error/);
    try {
      loadMisses(path);
    } catch (e) {
      expect((e as Error).message).not.toContain('SENTINEL');
    }
  });
});
