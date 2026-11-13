import { dirname, resolve } from 'node:path';
import {
  checkRules,
  DEFAULT_RULES_PATH,
  type RulesCheck,
} from '@xapply/disqualify';
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

/** The path, the country count and problems only. Never a country code. */
export function formatRulesCheck(result: RulesCheck): string {
  const lines = [
    `rules: ${result.path}`,
    `authorized countries ${result.counts.authorizedCountries}`,
    `located in ${result.counts.locatedIn}`,
  ];
  if (result.problems.length > 0) {
    lines.push('errors:', ...result.problems.map((p) => `  ${p}`));
  }
  return lines.join('\n');
}

export function factsCheckCommand(
  opts: {
    path?: string;
    rulesPath?: string;
    log?: (line: string) => void;
  } = {},
): number {
  const log = opts.log ?? console.log;
  const path = opts.path ? resolve(REPO_ROOT, opts.path) : undefined;
  const result = checkFactBank(path);
  log(formatCheck(result));
  const rules = checkRules(opts.rulesPath ?? DEFAULT_RULES_PATH);
  log(formatRulesCheck(rules));
  return result.ok && rules.ok ? 0 : 1;
}
