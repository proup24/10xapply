import {
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
import { disqualifyEvalCommand } from './disqualify.js';

const QUOTE = 'legally authorized to work in the United States';

const GOLDEN = `
rules:
  authorizedCountries: [MA]
  locatedIn: [MA]
defaultJob:
  title: Backend Engineer
  company: Acme
  description: Build services.
cases:
  - id: auth-us
    group: authorization
    questions:
      - label: Are you ${QUOTE}?
        type: radio
        options: [Yes, No]
    expect:
      verdict: disqualified
      claims:
        - kind: requires-authorization
          countries: [US]
  - id: clean
    group: near-miss
    questions:
      - label: Years of experience?
    expect:
      verdict: pass
      claims: []
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'disq-'));
  dirs.push(root);
  mkdirSync(join(root, 'libs', 'disqualify', 'golden'), { recursive: true });
  writeFileSync(
    join(root, 'libs', 'disqualify', 'golden', 'example.yaml'),
    GOLDEN,
  );
  return root;
}

/** Reports a US authorization requirement for the first case's question, nothing else. */
function caller(models: string[] = [], reports = true): ModelCaller {
  return {
    async call(req) {
      models.push(req.model);
      const hit = reports && req.prompt.includes('United States');
      const claims = hit
        ? [
            {
              kind: 'requires-authorization',
              countries: ['US'],
              countryFrom: 'text',
              quote: QUOTE,
              placeQuote: null,
              source: 's1-q1',
              detail: null,
            },
          ]
        : [];
      return {
        value: req.schema.parse({ claims }),
        stat: {
          role: req.role,
          model: req.model,
          latencyMs: 1,
          costUsd: 0.01,
          ok: true,
        },
      };
    },
  };
}

const NOW = () => new Date('2026-11-13T10:00:00.000Z');
const reportOf = (root: string) => {
  const dir = join(root, 'run-reports', 'disqualify-eval');
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]), 'utf8');
};

describe('disqualifyEvalCommand', () => {
  it('writes the report and returns 0 when every case passes', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    const models: string[] = [];
    const code = await disqualifyEvalCommand({
      root,
      caller: caller(models),
      log: (l) => lines.push(l),
      now: NOW,
      model: 'sonnet',
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(
      /auth-us\s+authorization\s+pass\s+disqualified/,
    );
    expect(new Set(models)).toEqual(new Set(['sonnet']));
    const report = JSON.parse(reportOf(root));
    expect(report.passed).toBe(true);
    expect(report.model).toBe('sonnet');
    expect(report.repeat).toBe(1);
    expect(report.cases.map((c: { id: string }) => c.id)).toEqual([
      'auth-us',
      'clean',
    ]);
  });

  it('returns 1 when a case fails', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    const code = await disqualifyEvalCommand({
      root,
      caller: caller([], false),
      log: (l) => lines.push(l),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('FAIL');
    expect(JSON.parse(reportOf(root)).passed).toBe(false);
  });

  it('repeats and filters by case', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    await disqualifyEvalCommand({
      root,
      caller: caller(),
      log: (l) => lines.push(l),
      now: NOW,
      repeat: 2,
      caseId: 'clean',
    });
    expect(lines.filter((l) => l.startsWith('clean'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('auth-us');
  });

  it('keeps quotes out of the terminal and the report', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    await disqualifyEvalCommand({
      root,
      caller: caller(),
      log: (l) => lines.push(l),
      now: NOW,
    });
    expect(lines.join('\n')).not.toContain(QUOTE);
    const text = reportOf(root);
    expect(text).not.toContain(QUOTE);
    expect(text).toContain('requires-authorization');
  });

  it('returns 1 with a message when the model is unavailable, writing no report', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    const code = await disqualifyEvalCommand({
      root,
      caller: {
        async call() {
          throw new ModelUnavailableError('claude is not installed');
        },
      },
      log: (l) => lines.push(l),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('claude is not installed');
    expect(existsSync(join(root, 'run-reports'))).toBe(false);
  });

  it('returns 1 for a missing golden file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disq-'));
    dirs.push(root);
    const lines: string[] = [];
    expect(
      await disqualifyEvalCommand({
        root,
        caller: caller(),
        log: (l) => lines.push(l),
      }),
    ).toBe(1);
    expect(lines.join('\n')).toContain('cannot read golden file');
  });
});
