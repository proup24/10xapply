import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelUnavailableError, type ModelCaller } from '@xapply/answerer';
import { answersEvalCommand } from './answers.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SECRET = 'Zorblaxian';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers every model call with "cannot answer", so a case expected backed is a needless block. */
const silentCaller: ModelCaller = {
  async call(req) {
    return {
      value: req.schema.parse({
        outcome: 'cannot-answer',
        reason: 'bank-silent',
        value: null,
        sources: [],
        derivation: null,
        inferences: [],
        math: null,
      }),
      stat: {
        role: req.role,
        model: req.model,
        latencyMs: 1,
        costUsd: null,
        ok: true,
      },
    };
  },
};

const VALUE_SECRET = 'Quxvalue';
const FINDING_SECRET = 'Wibblefinding';
const HIT_SECRET = 'Snarkclaim';

/** Backs a composed answer carrying a secret, confirms every check, and has the judge quote secrets. */
const composedCaller: ModelCaller = {
  async call(req) {
    const generated = {
      outcome: 'answer',
      reason: null,
      value: `I led the ${VALUE_SECRET} work.`,
      sources: [
        {
          kind: 'fact',
          key: null,
          text: `I am a ${SECRET} citizen.`,
          id: null,
          variant: null,
          quote: null,
        },
      ],
      derivation: 'composed',
      inferences: [],
      math: null,
    };
    const replies: unknown[] =
      req.role === 'judge'
        ? [{ unsupported: [FINDING_SECRET], mustNotClaimHits: [HIT_SECRET] }]
        : [
            { fits: true, why: '' },
            { claims: [], storyDetailAdded: false },
            generated,
          ];
    const reply = req.role === 'answer' ? generated : undefined;
    const value =
      reply ??
      replies.map((r) => req.schema.safeParse(r)).find((r) => r.success)?.data;
    return {
      value: value as never,
      stat: {
        role: req.role,
        model: req.model,
        latencyMs: 1,
        costUsd: null,
        ok: true,
      },
    };
  },
};

const unavailableCaller: ModelCaller = {
  async call() {
    throw new ModelUnavailableError('claude is not signed in');
  },
};

const bankYaml = (first: string) => `version: 1
fields:
  firstName: ${first}
  lastName: ${SECRET}Last
  email: ${SECRET.toLowerCase()}@example.com
  phone:
    countryCode: '+44'
    number: '7700900123'
    country: United Kingdom
  city: ${SECRET}City
  country: United Kingdom
  links:
    linkedin: https://www.linkedin.com/in/${SECRET.toLowerCase()}
  resume: resume.pdf
facts:
  - I am a ${SECRET} citizen.
answers: []
stories: []
`;

const goldenYaml = (secondExpect: string) => `runDate: '2026-11-12'
jobs:
  default:
    title: Engineer
    company: Acme
    description: Build services.
cases:
  - id: field-first-name
    question: { label: First name, type: text, required: true }
    expect:
      status: backed
      valueFrom: { field: firstName }
      sources: [{ field: firstName }]
      derivation: field
  - id: needs-model
    question: { label: Tell us about the ${SECRET} project, type: textarea, required: true }
    expect:
${secondExpect}
`;

const BACKED = '      status: backed\n      derivation: composed';
const BLOCKED = '      status: blocked';

/** A temporary repo layout: an example set and a private set. */
function layout(secondExpect: string) {
  const root = mkdtempSync(join(tmpdir(), 'answers-'));
  dirs.push(root);
  const pdf = join(REPO, 'libs/fact-bank/test-fixtures/resume.pdf');
  const ex = join(root, 'libs/fact-bank');
  mkdirSync(ex, { recursive: true });
  writeFileSync(join(ex, 'fact-bank.example.yaml'), bankYaml('Sam'));
  cpSync(pdf, join(ex, 'resume.pdf'));
  mkdirSync(join(root, 'libs/answerer/golden'), { recursive: true });
  writeFileSync(
    join(root, 'libs/answerer/golden/example.yaml'),
    goldenYaml(secondExpect),
  );
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'private/fact-bank.yaml'), bankYaml(SECRET));
  cpSync(pdf, join(root, 'private/resume.pdf'));
  writeFileSync(
    join(root, 'private/answer-golden.yaml'),
    goldenYaml(secondExpect),
  );
  return { root, envFile: join(root, 'no-env') };
}

function run(
  paths: { root: string; envFile: string },
  opts: Parameters<typeof answersEvalCommand>[0] = {},
) {
  const lines: string[] = [];
  const now = () => new Date('2026-11-12T10:20:30.000Z');
  return answersEvalCommand({
    caller: silentCaller,
    log: (l) => lines.push(l),
    now,
    paths,
    ...opts,
  }).then((code) => ({ code, out: lines.join('\n') }));
}

function files(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('answersEvalCommand', () => {
  it('example set: prints values, writes a report, exits 0 when bars hold', async () => {
    const paths = layout(BLOCKED);
    const { code, out } = await run(paths);
    expect(code).toBe(0);
    expect(out).toContain('PASS field-first-name');
    expect(out).toContain('value: Sam');
    expect(out).toContain('bars held');
    const dir = join(paths.root, 'run-reports/answers-eval');
    expect(files(dir)).toEqual(['2026-11-12T10-20-30.000Z-example.json']);
    const report = JSON.parse(
      readFileSync(join(dir, files(dir)[0]), 'utf8'),
    ) as { set: string; barsHeld: boolean };
    expect(report.set).toBe('example');
    expect(report.barsHeld).toBe(true);
    expect(files(join(paths.root, 'private/answers-eval'))).toEqual([]);
  });

  it('returns 1 when the bars fail, still printing the cases', async () => {
    const paths = layout(BACKED);
    const { code, out } = await run(paths);
    expect(code).toBe(1);
    expect(out).toContain('FAIL needs-model');
    expect(out).toContain('bars NOT held');
  });

  it('private set: no private value reaches stdout or run-reports; the full file goes to private/', async () => {
    const paths = layout(BACKED);
    const { code, out } = await run(paths, { set: 'private' });
    expect(code).toBe(1);
    expect(out).toContain('FAIL needs-model');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('Tell us');
    const dir = join(paths.root, 'run-reports/answers-eval');
    const [name] = files(dir);
    expect(name).toBe('2026-11-12T10-20-30.000Z-private.json');
    const text = readFileSync(join(dir, name), 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Tell us');
    expect(text).toContain('needs-model');
    const full = join(paths.root, 'private/answers-eval');
    expect(files(full)).toEqual(['2026-11-12T10-20-30.000Z.json']);
    expect(readFileSync(join(full, files(full)[0]), 'utf8')).toContain(SECRET);
  });

  it('private set: a backed composed answer and the judge findings stay out of stdout and run-reports', async () => {
    const paths = layout(`${BACKED}\n      mustNotClaim: [${HIT_SECRET}]`);
    const { out } = await run(paths, {
      set: 'private',
      caller: composedCaller,
      caseId: 'needs-model',
    });
    expect(out).toContain('needs-model');
    expect(out).toContain('unsupported 1');
    for (const secret of [VALUE_SECRET, FINDING_SECRET, HIT_SECRET]) {
      expect(out).not.toContain(secret);
    }
    const dir = join(paths.root, 'run-reports/answers-eval');
    const text = readFileSync(join(dir, files(dir)[0]), 'utf8');
    const full = join(paths.root, 'private/answers-eval');
    const fullText = readFileSync(join(full, files(full)[0]), 'utf8');
    for (const secret of [VALUE_SECRET, FINDING_SECRET, HIT_SECRET]) {
      expect(text).not.toContain(secret);
    }
    expect(fullText).toContain(VALUE_SECRET);
    expect(fullText).toContain(FINDING_SECRET);
    expect(fullText).toContain(HIT_SECRET);
  });

  it('prints a ModelUnavailableError message and returns 1', async () => {
    const paths = layout(BACKED);
    const { code, out } = await run(paths, { caller: unavailableCaller });
    expect(code).toBe(1);
    expect(out).toContain('claude is not signed in');
  });

  it('prints a GoldenError for an unknown case id and returns 1', async () => {
    const paths = layout(BLOCKED);
    const { code, out } = await run(paths, { caseId: 'nope' });
    expect(code).toBe(1);
    expect(out).toContain('no case with id nope');
  });

  it('rejects a bad repeat and returns 1', async () => {
    const paths = layout(BLOCKED);
    const { code, out } = await run(paths, { repeat: 0 });
    expect(code).toBe(1);
    expect(out).toContain('repeat');
  });

  it('runs a case several times with --repeat', async () => {
    const paths = layout(BLOCKED);
    const { code, out } = await run(paths, {
      repeat: 2,
      caseId: 'field-first-name',
    });
    expect(code).toBe(0);
    expect(out).toContain('run 1/2');
    expect(out).toContain('run 2/2');
  });

  it('returns 1 when the golden file is missing', async () => {
    const paths = layout(BLOCKED);
    rmSync(join(paths.root, 'private/answer-golden.yaml'));
    const { code, out } = await run(paths, { set: 'private' });
    expect(code).toBe(1);
    expect(out).toContain('cannot read golden file');
  });
});
