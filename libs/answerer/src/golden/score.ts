import type { FactBank } from '@xapply/fact-bank';
import { fieldValue, fillPlaceholders } from '../sources.js';
import type { AnswerResult, AnswerValue, Job, Source } from '../types.js';
import type { Expect, ExpectSource, GoldenCase } from './format.js';
import type { JudgeRun } from './judge.js';

/**
 * One run of one case. `problems` are fixed text with case-file ids, enum
 * values and counts only: never a value, a fact, a label or a judge finding.
 */
export interface CaseScore {
  id: string;
  pass: boolean;
  /** A wrong backed answer: the hard bar. */
  hardFail: boolean;
  /** Backed was expected and blocked came back. */
  needlessBlock: boolean;
  problems: string[];
}

export interface ScoreContext {
  bank: FactBank;
  /** The case's job, for filling placeholders in `valueFrom: { answer }`. */
  job: Job;
}

/** The expected value from the case, or from the bank for valueFrom. Null when it cannot resolve. */
function expectedValue(e: Expect, ctx: ScoreContext): AnswerValue | null {
  if (e.value !== undefined) return e.value;
  const from = e.valueFrom;
  if (from === undefined) return null;
  if ('field' in from) return fieldValue(from.field, ctx.bank);
  const answer = ctx.bank.answers.find((a) => a.id === from.answer)?.answer;
  return answer === undefined ? null : fillPlaceholders(answer, ctx.job);
}

function sameValue(expected: AnswerValue, actual: AnswerValue): boolean {
  if (typeof expected === 'string' || typeof actual === 'string') {
    return (
      typeof expected === 'string' &&
      typeof actual === 'string' &&
      expected.trim() === actual.trim()
    );
  }
  const want = new Set(expected.map((v) => v.trim()));
  const got = new Set(actual.map((v) => v.trim()));
  return want.size === got.size && [...want].every((v) => got.has(v));
}

function sourceName(s: ExpectSource): string {
  if ('fact' in s) return `fact:${s.fact}`;
  if ('answer' in s) return `answer:${s.answer}`;
  if ('story' in s) return `story:${s.story}`;
  if ('field' in s) return `field:${s.field}`;
  return 'job-post';
}

function hasSource(want: ExpectSource, got: Source[], bank: FactBank): boolean {
  return got.some((s) => {
    if ('fact' in want) {
      const fact = bank.facts[want.fact];
      return (
        fact !== undefined &&
        s.kind === 'fact' &&
        s.text.trim() === fact.text.trim()
      );
    }
    if ('answer' in want) return s.kind === 'answer' && s.id === want.answer;
    if ('story' in want) return s.kind === 'story' && s.id === want.story;
    if ('field' in want) return s.kind === 'field' && s.key === want.field;
    return s.kind === 'job-post';
  });
}

/**
 * Scores one result against its case. A hard failure is a backed result where
 * blocked was expected, a value, valueFrom, source or derivation that does not
 * match, or a judge finding. A judge model error, or a result blocked as
 * model-error where that was not expected, fails the case without being a
 * hard failure or a needless block.
 */
export function scoreCase(
  c: GoldenCase,
  r: AnswerResult,
  ctx: ScoreContext,
  judge?: JudgeRun,
): CaseScore {
  const e = c.expect;
  const problems: string[] = [];
  let hardFail = false;
  let needlessBlock = false;
  const hard = (problem: string) => {
    hardFail = true;
    problems.push(problem);
  };

  if (
    r.status === 'blocked' &&
    r.reason === 'model-error' &&
    e.reason !== 'model-error'
  ) {
    // A model error says nothing about the answerer's rules: never a pass.
    problems.push('model error');
  } else if (e.status === 'blocked') {
    if (r.status === 'backed') {
      hard('expected blocked, got backed');
    } else if (e.reason !== undefined && e.reason !== r.reason) {
      problems.push(`expected reason ${e.reason}, got ${r.reason}`);
    }
  } else if (r.status === 'blocked') {
    needlessBlock = true;
    problems.push(`expected backed, got blocked (${r.reason})`);
  } else {
    if (e.value !== undefined || e.valueFrom !== undefined) {
      const expected = expectedValue(e, ctx);
      const from = e.valueFrom;
      if (expected === null) {
        const ref =
          from === undefined
            ? 'value'
            : 'answer' in from
              ? `answer:${from.answer}`
              : `field:${from.field}`;
        hard(`valueFrom ${ref} not resolvable`);
      } else if (!sameValue(expected, r.value)) {
        hard('value mismatch');
      }
    }
    for (const want of e.sources ?? []) {
      if (!hasSource(want, r.sources, ctx.bank)) {
        hard(`missing source ${sourceName(want)}`);
      }
    }
    if (e.derivation !== undefined && e.derivation !== r.derivation) {
      hard(`expected derivation ${e.derivation}, got ${r.derivation}`);
    }
  }

  if (r.status === 'backed' && judge !== undefined) {
    if (judge.status === 'model-error') {
      problems.push('judge: model error');
    } else if (judge.status === 'judged') {
      if (judge.unsupported.length > 0)
        hard(`judge: ${judge.unsupported.length} unsupported`);
      if (judge.mustNotClaimHits.length > 0)
        hard(`judge: ${judge.mustNotClaimHits.length} mustNotClaim`);
    }
  }

  return {
    id: c.id,
    pass: problems.length === 0,
    hardFail,
    needlessBlock,
    problems,
  };
}
