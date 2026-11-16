import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { loadMisses, MissesError } from '../apply/misses.js';

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
    missesPath?: string;
    log?: (line: string) => void;
  } = {},
): number {
  const log = opts.log ?? console.log;
  const path = opts.path ? resolve(REPO_ROOT, opts.path) : undefined;
  const result = checkFactBank(path);
  log(formatCheck(result));
  const rules = checkRules(opts.rulesPath ?? DEFAULT_RULES_PATH);
  log(formatRulesCheck(rules));
  const rulesFile = opts.rulesPath ?? DEFAULT_RULES_PATH;
  const misses = checkMissesFile(
    opts.missesPath ?? join(dirname(rulesFile), 'answer-misses.yaml'),
    log,
  );
  return result.ok && rules.ok && misses ? 0 : 1;
}

/**
 * Validates the misses file when it exists: a count, or the error's own
 * message (it names the file and the schema problem, never a value).
 */
function checkMissesFile(path: string, log: (line: string) => void): boolean {
  if (!existsSync(path)) return true;
  try {
    log(`misses ${loadMisses(path).misses.length}`);
    return true;
  } catch (e) {
    log('misses: errors:');
    log(`  ${e instanceof MissesError ? e.message : 'cannot read the file'}`);
    return false;
  }
}
