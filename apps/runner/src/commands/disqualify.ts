import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createClaudeCliCaller,
  ModelUnavailableError,
  type ModelCaller,
} from '@xapply/answerer';
import {
  DisqualifyGoldenError,
  loadDisqualifyGolden,
  runDisqualifyGolden,
  type DisqCase,
  type DisqEvalReport,
  type DisqRun,
} from '@xapply/disqualify';
import { DEFAULT_FACT_BANK_PATH } from '@xapply/fact-bank';
import { ConfigError, ENV_FILE, loadAnswerConfig } from '../config.js';

const REPO_ROOT = dirname(dirname(DEFAULT_FACT_BANK_PATH));

export interface DisqualifyEvalOptions {
  model?: string;
  repeat?: number;
  caseId?: string;
  caller?: ModelCaller;
  log?: (line: string) => void;
  now?: () => Date;
  /** Where libs/ and run-reports/ live. For tests. */
  root?: string;
}

const stamp = (d: Date): string => d.toISOString().replaceAll(':', '-');
const dollars = (n: number): string => `$${n.toFixed(2)}`;

const claimShape = (r: DisqRun) =>
  r.claims.map((c) => ({
    kind: c.kind,
    countries: c.countries,
    countryFrom: c.countryFrom,
    source: c.source,
  }));

/** Ids, groups, verdicts and claim kinds and countries only. No quote, detail or place text. */
function redactedReport(report: DisqEvalReport) {
  return {
    passed: report.passed,
    cost: report.cost,
    cases: report.cases.map((c) => ({
      id: c.id,
      group: c.group,
      runs: c.runs.map((r) => ({
        pass: r.pass,
        verdict: r.verdict,
        claims: claimShape(r),
        calls: r.calls,
        ...(r.error === undefined ? {} : { error: r.error }),
      })),
    })),
  };
}

/**
 * Runs the committed example golden set through the extractor with the
 * author's subscription. Exit code: 0 when every run passed, else 1.
 */
export async function disqualifyEvalCommand(
  opts: DisqualifyEvalOptions = {},
): Promise<number> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  const root = opts.root ?? REPO_ROOT;
  try {
    const model =
      opts.model ?? loadAnswerConfig(process.env, ENV_FILE).extractModel;
    const golden = loadDisqualifyGolden(
      join(root, 'libs', 'disqualify', 'golden', 'example.yaml'),
    );
    const repeat = opts.repeat ?? 1;
    const startedAt = now();

    const report = await runDisqualifyGolden({
      golden,
      ctx: { caller: opts.caller ?? createClaudeCliCaller(), model },
      repeat,
      caseId: opts.caseId,
      onRun: (c: DisqCase, r: DisqRun) => {
        const kinds = r.claims.map((x) => x.kind).join(',') || '-';
        log(
          `${c.id}  ${c.group}  ${r.pass ? 'pass' : 'FAIL'}  ${r.verdict}  ${kinds}`,
        );
      },
    });

    const runs = report.cases.flatMap((c) => c.runs);
    const passedRuns = runs.filter((r) => r.pass).length;
    log(
      `runs ${passedRuns}/${runs.length} passed · cases ${report.cases.length} · ${dollars(report.cost)}`,
    );
    const reportPath = join(
      root,
      'run-reports',
      'disqualify-eval',
      `${stamp(startedAt)}.json`,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          startedAt: startedAt.toISOString(),
          model,
          repeat,
          ...redactedReport(report),
        },
        null,
        2,
      )}\n`,
    );
    log(`report: ${reportPath}`);
    return report.passed ? 0 : 1;
  } catch (e) {
    if (
      e instanceof ModelUnavailableError ||
      e instanceof DisqualifyGoldenError ||
      e instanceof ConfigError
    ) {
      log(e.message);
      return 1;
    }
    throw e;
  }
}
