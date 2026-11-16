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
import {
  missId,
  saveMisses,
  type Miss,
  type MissesFile,
} from '../apply/misses.js';
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
            {
              // A non-empty answer needs at least one claim to be confirmed.
              claims: [{ claim: 'A claim.', mark: 'backed', source: 'fact' }],
              storyDetailAdded: false,
            },
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

  describe('misses set', () => {
    const TYPED_SECRET = 'Plonkanswer';

    const miss = (over: Partial<Miss>): Miss => ({
      id: 'x',
      jobId: '4242',
      firstSeenAt: '2026-11-12T10:00:00.000Z',
      lastSeenAt: '2026-11-12T10:00:00.000Z',
      runDate: '2026-11-12',
      question: { label: 'First name', type: 'text', required: true },
      answer: { kind: 'typed', value: TYPED_SECRET, via: 'terminal' },
      reason: 'bank-silent',
      detail: 'generator: bank-silent',
      sources: [],
      savedAs: null,
      ...over,
    });

    function missesLayout(misses: Miss[]) {
      const paths = layout(BLOCKED);
      const file: MissesFile = {
        version: 1,
        jobs: {
          '4242': {
            title: 'Engineer',
            company: 'Acme',
            description: 'Build services.',
            source: 'linkedin',
          },
          // A job whose title and company were never read.
          '5151': {
            title: '',
            company: '',
            description: '',
            source: 'linkedin',
          },
        },
        misses,
      };
      saveMisses(join(paths.root, 'private/answer-misses.yaml'), file);
      return paths;
    }

    it('misses set loads the misses file and the private bank, and prints ids and counts only', async () => {
      const label = `Years of ${SECRET} Gopherwork?`;
      const q = (l: string, type: string, extra = {}) => ({
        label: l,
        type,
        required: true,
        ...extra,
      });
      const first = q('First name', 'text');
      const years = q(label, 'select', { options: ['1', '2', TYPED_SECRET] });
      const unread = q('', 'text');
      const paths = missesLayout([
        miss({ id: missId('4242', first), question: first }),
        miss({ id: missId('4242', years), question: years }),
        // An unread label and job: must not crash the eval.
        miss({ id: missId('5151', unread), jobId: '5151', question: unread }),
        miss({
          id: missId('4242', q('Left blank', 'text')),
          question: q('Left blank', 'text'),
          answer: { kind: 'blank' },
        }),
      ]);
      const { out } = await run(paths, { set: 'misses' });
      const display = /^(PASS|FAIL) (\d+-[0-9a-f]{8}-\w+)/gm;
      const ids = [...out.matchAll(display)].map((m) => `${m[1]} ${m[2]}`);
      expect(ids).toHaveLength(3);
      expect(ids.filter((i) => i.startsWith('PASS 4242-'))).toHaveLength(1);
      expect(ids.some((i) => i.includes(' 5151-'))).toBe(true);
      expect(out).toContain('cases 1/3 passed');
      // Not `first`: the field source `field:firstName` is a bank key, not label text.
      const words = [
        'years',
        'gopherwork',
        'first-name',
        'left-blank',
        'blank',
      ];
      const banned = [SECRET, TYPED_SECRET, label, missId('4242', years)];
      const clean = (text: string) => {
        for (const b of banned) expect(text).not.toContain(b);
        for (const w of words) expect(text.toLowerCase()).not.toContain(w);
      };
      clean(out.replace(/report: .*|full results: .*/g, ''));
      const dir = join(paths.root, 'run-reports/answers-eval');
      const [name] = files(dir);
      expect(name).toBe('2026-11-12T10-20-30.000Z-misses.json');
      clean(readFileSync(join(dir, name), 'utf8'));
      const full = join(paths.root, 'private/answers-eval');
      expect(files(full)).toHaveLength(1);
      const fullData = JSON.parse(
        readFileSync(join(full, files(full)[0]), 'utf8'),
      ) as { realIds: Record<string, string> };
      expect(Object.values(fullData.realIds).sort()).toEqual(
        [
          missId('4242', first),
          missId('4242', years),
          missId('5151', unread),
        ].sort(),
      );
      expect(JSON.stringify(fullData)).toContain(SECRET);
    });

    it('misses set: --case takes a display id or a real id, the same across runs', async () => {
      const first = { label: 'First name', type: 'text', required: true };
      const real = missId('4242', first);
      const misses = [
        miss({ id: real, question: first }),
        miss({
          id: missId('4242', { label: 'Other', type: 'text' }),
          question: { label: 'Other', type: 'text', required: true },
        }),
      ];
      const a = await run(missesLayout(misses), {
        set: 'misses',
        caseId: real,
      });
      const shown = /^PASS (\S+)/m.exec(a.out)?.[1];
      expect(shown).toMatch(/^4242-[0-9a-f]{8}-text$/);
      expect(a.out).toContain('cases 1/1 passed');
      const b = await run(missesLayout(misses), {
        set: 'misses',
        caseId: shown,
      });
      expect(b.out).toContain(`PASS ${shown}`);
      expect(b.out).toContain('cases 1/1 passed');
    });

    it('misses set with no answered misses prints "no answered misses" and exits 0', async () => {
      const paths = missesLayout([
        miss({ id: '4242-left-blank-text', answer: { kind: 'blank' } }),
      ]);
      const { code, out } = await run(paths, { set: 'misses' });
      expect(code).toBe(0);
      expect(out).toBe('no answered misses');
      expect(files(join(paths.root, 'run-reports/answers-eval'))).toEqual([]);
    });

    it('misses set with no misses file prints "no answered misses" and exits 0', async () => {
      const paths = layout(BLOCKED);
      const { code, out } = await run(paths, { set: 'misses' });
      expect(code).toBe(0);
      expect(out).toBe('no answered misses');
    });

    it('a broken misses file prints its fixed message and returns 1', async () => {
      const paths = layout(BLOCKED);
      writeFileSync(
        join(paths.root, 'private/answer-misses.yaml'),
        `version: 2\nsecret: ${SECRET}\n`,
      );
      const { code, out } = await run(paths, { set: 'misses' });
      expect(code).toBe(1);
      expect(out).toContain('misses file');
      expect(out).not.toContain(SECRET);
    });
  });
});
