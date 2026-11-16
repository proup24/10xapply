import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createClaudeCliCaller,
  GoldenError,
  loadGolden,
  ModelUnavailableError,
  redactResult,
  runGolden,
  type CaseReport,
  type EvalReport,
  type GoldenCase,
  type GoldenFile,
  type JudgeRun,
  type ModelCaller,
} from '@xapply/answerer';
import {
  DEFAULT_FACT_BANK_PATH,
  FactBankError,
  loadFactBank,
  type FactBank,
} from '@xapply/fact-bank';
import { loadMisses, MissesError, missesToGolden } from '../apply/misses.js';
import { ConfigError, ENV_FILE, loadAnswerConfig } from '../config.js';

const REPO_ROOT = dirname(dirname(DEFAULT_FACT_BANK_PATH));

export type EvalSet = 'example' | 'private' | 'misses';

export interface AnswersPaths {
  /** Where the golden files, the banks and the report folders live. */
  root: string;
  /** The runner's env file. */
  envFile: string;
}

export interface AnswersEvalOptions {
  set?: EvalSet;
  answerModel?: string;
  verifyModel?: string;
  judgeModel?: string;
  repeat?: number;
  caseId?: string;
  caller?: ModelCaller;
  log?: (line: string) => void;
  now?: () => Date;
  /** For tests. */
  paths?: AnswersPaths;
}

const stamp = (d: Date): string => d.toISOString().replaceAll(':', '-');

const dollars = (n: number): string => `$${n.toFixed(2)}`;

const expectText = (c: GoldenCase): string =>
  c.expect.status === 'blocked' && c.expect.reason
    ? `blocked:${c.expect.reason}`
    : c.expect.status;

function runCost(r: CaseReport, i: number): number {
  const judge = r.judges[i];
  const stats =
    judge?.status === 'judged'
      ? [...r.results[i].calls, judge.stat]
      : r.results[i].calls;
  return stats.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
}

function judgeCounts(j: JudgeRun): string | null {
  if (j.status === 'judged') {
    return `unsupported ${j.unsupported.length}, mustNotClaim hits ${j.mustNotClaimHits.length}`;
  }
  return j.status === 'model-error' ? 'judge model-error' : null;
}

/** One block per run: a line of ids, kinds and counts, then (example set only) the value and findings. */
function formatCase(
  c: GoldenCase,
  r: CaseReport,
  bank: FactBank,
  showValues: boolean,
  repeat: number,
): string[] {
  const lines: string[] = [];
  r.runs.forEach((score, i) => {
    const result = r.results[i];
    const red = redactResult(result, bank);
    const actual =
      red.status === 'blocked' ? `blocked:${red.reason}` : 'backed';
    const sources =
      red.sources.map((s) => `${s.kind}:${s.ref ?? ''}`).join(',') || '-';
    const run = repeat > 1 ? ` run ${i + 1}/${repeat}` : '';
    lines.push(
      [
        `${score.pass ? 'PASS' : 'FAIL'} ${c.id}${run}`,
        `${expectText(c)}→${actual}`,
        red.derivation ?? '-',
        sources,
        `rounds ${red.rounds ?? '-'}`,
        dollars(runCost(r, i)),
      ].join('  '),
    );
    for (const p of score.problems) lines.push(`  problem: ${p}`);
    const judge = r.judges[i];
    const counts = judgeCounts(judge);
    if (counts) lines.push(`  ${counts}`);
    if (showValues) {
      if (result.status === 'backed') {
        const v = Array.isArray(result.value)
          ? result.value.join(' | ')
          : result.value;
        lines.push(`  value: ${v}`);
      } else {
        lines.push(`  detail: ${result.detail}`);
      }
      if (judge.status === 'judged') {
        for (const u of judge.unsupported) lines.push(`  unsupported: ${u}`);
        for (const m of judge.mustNotClaimHits) {
          lines.push(`  mustNotClaim hit: ${m}`);
        }
      }
    }
  });
  return lines;
}

/** The report for run-reports: ids, enums and counts only. No value, no label, no finding text. */
function redactedReport(report: EvalReport, bank: FactBank) {
  return {
    totals: report.totals,
    barsHeld: report.barsHeld,
    cases: report.cases.map((c) => ({
      id: c.id,
      pass: c.pass,
      runs: c.runs.map((s) => ({
        pass: s.pass,
        hardFail: s.hardFail,
        needlessBlock: s.needlessBlock,
        problems: s.problems,
      })),
      results: c.results.map((r) => redactResult(r, bank)),
      judges: c.judges.map((j) =>
        j.status === 'judged'
          ? {
              status: j.status,
              unsupported: j.unsupported.length,
              mustNotClaimHits: j.mustNotClaimHits.length,
              stat: j.stat,
            }
          : { status: j.status },
      ),
    })),
  };
}

/**
 * A miss's id holds its question's label, so the misses set runs under
 * display ids: `${jobId}-${hash8}-${type}`, hash8 the first 8 hex chars of
 * the real id's sha256. Stable across runs, so `--case` keeps working.
 */
function displayMisses(file: GoldenFile): {
  file: GoldenFile;
  realIds: Record<string, string>;
} {
  const realIds: Record<string, string> = {};
  const cases = file.cases.map((c) => {
    const hash = createHash('sha256').update(c.id).digest('hex').slice(0, 8);
    const id = `${c.job}-${hash}-${c.question.type}`;
    realIds[id] = c.id;
    return { ...c, id, question: { ...c.question, id } };
  });
  return { file: { ...file, cases }, realIds };
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Runs a golden set through the answerer with the author's subscription.
 * Exit code: 0 when the bars held, else 1. On the private and misses sets
 * nothing but ids, enums and counts goes to stdout or run-reports; the full
 * results go to private/answers-eval/. The misses set is the answered misses
 * in private/answer-misses.yaml, against the private bank.
 */
export async function answersEvalCommand(
  opts: AnswersEvalOptions = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  const root = opts.paths?.root ?? REPO_ROOT;
  const envFile = opts.paths?.envFile ?? ENV_FILE;
  const set = opts.set ?? 'example';
  // The misses set is the author's own questions and answers: redacted as the private set.
  const isPrivate = set !== 'example';
  try {
    const defaults = loadAnswerConfig(process.env, envFile);
    const models = {
      answerModel: opts.answerModel ?? defaults.answerModel,
      verifyModel: opts.verifyModel ?? defaults.verifyModel,
      judgeModel: opts.judgeModel ?? defaults.judgeModel,
      maxRegenerations: defaults.maxRegenerations,
    };
    const bankPath = isPrivate
      ? join(root, 'private', 'fact-bank.yaml')
      : join(root, 'libs', 'fact-bank', 'fact-bank.example.yaml');
    let file: GoldenFile;
    let realIds: Record<string, string> | null = null;
    let caseId = opts.caseId;
    if (set === 'misses') {
      // Not through loadGolden: a text miss expects only `backed`, which its
      // "unpinned" check refuses by design.
      const shown = displayMisses(
        missesToGolden(loadMisses(join(root, 'private', 'answer-misses.yaml'))),
      );
      file = shown.file;
      realIds = shown.realIds;
      if (file.cases.length === 0) {
        log('no answered misses');
        return 0;
      }
      // --case takes a display id or a real one.
      const byReal = Object.entries(realIds).find(([, r]) => r === caseId);
      if (byReal) caseId = byReal[0];
    } else {
      file = loadGolden(
        set === 'private'
          ? join(root, 'private', 'answer-golden.yaml')
          : join(root, 'libs', 'answerer', 'golden', 'example.yaml'),
      );
    }
    const bank = loadFactBank(bankPath);
    const repeat = opts.repeat ?? 1;
    const startedAt = now();

    const report = await runGolden({
      file,
      bank,
      caller: opts.caller ?? createClaudeCliCaller(),
      models,
      repeat,
      caseId,
    });

    for (const r of report.cases) {
      const c = file.cases.find((x) => x.id === r.id);
      if (c) {
        for (const l of formatCase(c, r, bank, !isPrivate, repeat)) log(l);
      }
    }
    const t = report.totals;
    log(
      `cases ${t.passed}/${t.cases} passed · hard fails ${t.hardFails} · needless blocks ${(t.needlessBlockRate * 100).toFixed(1)}% · ${dollars(t.costUsd)}`,
    );
    log(report.barsHeld ? 'bars held' : 'bars NOT held');

    const meta = { set, startedAt: startedAt.toISOString(), models, repeat };
    const reportPath = join(
      root,
      'run-reports',
      'answers-eval',
      `${stamp(startedAt)}-${set}.json`,
    );
    writeJson(
      reportPath,
      isPrivate
        ? { ...meta, ...redactedReport(report, bank) }
        : { ...meta, ...report },
    );
    log(`report: ${reportPath}`);
    if (isPrivate) {
      const fullPath = join(
        root,
        'private',
        'answers-eval',
        `${stamp(startedAt)}.json`,
      );
      writeJson(fullPath, {
        ...meta,
        ...(realIds === null ? {} : { realIds }),
        ...report,
      });
      log(`full results: ${fullPath}`);
    }
    return report.barsHeld ? 0 : 1;
  } catch (e) {
    if (
      e instanceof ModelUnavailableError ||
      e instanceof GoldenError ||
      e instanceof MissesError ||
      e instanceof ConfigError ||
      e instanceof FactBankError
    ) {
      log(e.message);
      return 1;
    }
    throw e;
  }
}
