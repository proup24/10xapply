import { dirname, resolve } from 'node:path';
import {
  checkFactBank,
  DEFAULT_FACT_BANK_PATH,
  formatProblem,
  type CheckResult,
} from '@xapply/fact-bank';

const REPO_ROOT = dirname(dirname(DEFAULT_FACT_BANK_PATH));

const num = (n: number): string => n.toLocaleString('en-US');

/** Counts, size and problems only. Never a value from the file. */
export function formatCheck(result: CheckResult): string {
  const { facts, answers, stories } = result.counts;
  const lines = [
    result.path,
    `facts ${facts} · answers ${answers} · stories ${stories}`,
    `${num(result.size.characters)} characters (~${num(result.size.tokens)} tokens)`,
  ];
  if (result.warnings.length > 0) {
    lines.push(
      'warnings:',
      ...result.warnings.map((p) => `  ${formatProblem(p)}`),
    );
  }
  if (result.errors.length > 0) {
    lines.push('errors:', ...result.errors.map((p) => `  ${formatProblem(p)}`));
  }
  return lines.join('\n');
}

export function factsCheckCommand(
  opts: { path?: string; log?: (line: string) => void } = {},
): number {
  const log = opts.log ?? console.log;
  const path = opts.path ? resolve(REPO_ROOT, opts.path) : undefined;
  const result = checkFactBank(path);
  log(formatCheck(result));
  return result.ok ? 0 : 1;
}
