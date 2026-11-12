import type { FactBank } from '@xapply/fact-bank';
import { answerQuestion } from '../answer.js';
import { ModelCallError, type ModelCaller } from '../model/caller.js';
import {
  TEXT_TYPES,
  type AnswerContext,
  type AnswerResult,
  type ModelConfig,
} from '../types.js';
import { GoldenError, type GoldenCase, type GoldenFile } from './format.js';
import { judgeAnswer, type JudgeRun } from './judge.js';
import { scoreCase, type CaseScore } from './score.js';

export interface CaseReport {
  id: string;
  /** One score per run. */
  runs: CaseScore[];
  /** True only when every run passed. */
  pass: boolean;
  /** One result per run. */
  results: AnswerResult[];
  /** One per run. Findings are model text and may hold bank text. */
  judges: JudgeRun[];
}

export interface EvalReport {
  cases: CaseReport[];
  totals: {
    cases: number;
    passed: number;
    /** Runs with a hard failure. */
    hardFails: number;
    /** Needless-block runs over the runs expected to be backed; 0 when none are. */
    needlessBlockRate: number;
    /** Every call's reported cost, the judge's included; calls with no cost are skipped. */
    costUsd: number;
  };
  /** No hard failure and needless blocks at or under 10%. */
  barsHeld: boolean;
}

export interface RunGoldenOptions {
  file: GoldenFile;
  bank: FactBank;
  caller: ModelCaller;
  models: ModelConfig & { judgeModel: string };
  /** Runs per case. */
  repeat: number;
  /** Run only this case. */
  caseId?: string;
  /** Called after each run. */
  onCase?: (s: CaseScore, r: AnswerResult) => void;
}

export const NEEDLESS_BLOCK_BAR = 0.1;

const isText = (type: string): boolean =>
  (TEXT_TYPES as readonly string[]).includes(type);

async function judgeRun(
  c: GoldenCase,
  r: AnswerResult,
  ctx: AnswerContext,
  judgeModel: string,
): Promise<JudgeRun> {
  // Only free text is judged: fields and short values are graded by value.
  if (
    r.status !== 'backed' ||
    !isText(c.question.type) ||
    r.derivation !== 'composed'
  ) {
    return { status: 'not-run' };
  }
  try {
    const finding = await judgeAnswer(ctx.caller, judgeModel, {
      q: c.question,
      value: r.value,
      ctx,
      mustNotClaim: c.expect.mustNotClaim ?? [],
    });
    return { status: 'judged', ...finding };
  } catch (e) {
    // A ModelUnavailableError (sign-in or usage limit) stops the eval.
    if (e instanceof ModelCallError) return { status: 'model-error' };
    throw e;
  }
}

/**
 * Runs a golden set: each case `repeat` times, one call at a time, judging
 * backed composed text answers. A case passes only when every run passes.
 */
export async function runGolden(opts: RunGoldenOptions): Promise<EvalReport> {
  const { file, bank, caller, models, repeat } = opts;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new GoldenError('repeat must be a whole number of at least 1');
  }
  const cases =
    opts.caseId === undefined
      ? file.cases
      : file.cases.filter((c) => c.id === opts.caseId);
  if (opts.caseId !== undefined && cases.length === 0) {
    throw new GoldenError(`no case with id ${opts.caseId}`);
  }

  const reports: CaseReport[] = [];
  let hardFails = 0;
  let needless = 0;
  let expectedBacked = 0;
  let costUsd = 0;

  for (const c of cases) {
    const job = file.jobs[c.job ?? 'default'];
    if (job === undefined) {
      throw new GoldenError(`case ${c.id}: job is not defined`);
    }
    const ctx: AnswerContext = {
      bank,
      job,
      runDate: file.runDate,
      models: {
        answerModel: models.answerModel,
        verifyModel: models.verifyModel,
        maxRegenerations: models.maxRegenerations,
      },
      caller,
    };
    const report: CaseReport = {
      id: c.id,
      runs: [],
      pass: true,
      results: [],
      judges: [],
    };

    for (let run = 0; run < repeat; run++) {
      const result = await answerQuestion(c.question, ctx);
      const judge = await judgeRun(c, result, ctx, models.judgeModel);
      const score = scoreCase(c, result, { bank, job }, judge);

      const stats =
        judge.status === 'judged'
          ? [...result.calls, judge.stat]
          : result.calls;
      for (const s of stats) if (s.costUsd !== null) costUsd += s.costUsd;
      if (score.hardFail) hardFails++;
      if (score.needlessBlock) needless++;
      if (c.expect.status === 'backed') expectedBacked++;

      report.runs.push(score);
      report.results.push(result);
      report.judges.push(judge);
      report.pass &&= score.pass;
      opts.onCase?.(score, result);
    }
    reports.push(report);
  }

  const needlessBlockRate =
    expectedBacked === 0 ? 0 : needless / expectedBacked;
  return {
    cases: reports,
    totals: {
      cases: reports.length,
      passed: reports.filter((r) => r.pass).length,
      hardFails,
      needlessBlockRate,
      costUsd,
    },
    barsHeld: hardFails === 0 && needlessBlockRate <= NEEDLESS_BLOCK_BAR,
  };
}
