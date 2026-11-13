import {
  ModelCallError,
  type CallStat,
  type ModelCaller,
} from '@xapply/answerer';
import {
  EXTRACT_SYSTEM,
  extractOutput,
  jobPrompt,
  questionsPrompt,
  retryPrompt,
} from './prompts.js';
import type { Claim, CheckJob, CheckQuestion } from './types.js';
import { validateClaims } from './validate.js';

export interface ExtractContext {
  caller: ModelCaller;
  model: string;
}
export interface ExtractResult {
  claims: Claim[];
  calls: CallStat[];
}

/** The check could not be made. Safety stop `check-failed`; the job may be tried again. */
export class CheckFailedError extends Error {
  constructor(
    readonly why: 'invalid-claims' | 'model-error',
    readonly calls: CallStat[],
  ) {
    super(`check failed: ${why}`);
    this.name = 'CheckFailedError';
  }
}

async function extract(
  prompt: string,
  sources: Map<string, string>,
  place: string,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const calls: CallStat[] = [];
  let problems: string[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await ctx.caller.call({
        role: 'extract',
        model: ctx.model,
        system: EXTRACT_SYSTEM,
        prompt: attempt === 0 ? prompt : retryPrompt(prompt, problems),
        schema: extractOutput,
      });
      calls.push(res.stat);
      const claims: Claim[] = res.value.claims;
      problems = validateClaims(claims, { sources, place });
      if (problems.length === 0) return { claims, calls };
    }
  } catch (e) {
    if (e instanceof ModelCallError)
      throw new CheckFailedError('model-error', calls);
    throw e;
  }
  throw new CheckFailedError('invalid-claims', calls);
}

const placeOf = (job: CheckJob) => `${job.title}\n${job.description}`;

export function extractFromJob(
  job: CheckJob,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  return extract(
    jobPrompt(job),
    new Map([['job-page', placeOf(job)]]),
    placeOf(job),
    ctx,
  );
}

export function extractFromQuestions(
  questions: CheckQuestion[],
  job: CheckJob,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  if (questions.length === 0) return Promise.resolve({ claims: [], calls: [] });
  const sources = new Map(
    questions.map((q) => [
      q.id,
      [q.label, q.helpText ?? '', ...(q.options ?? [])].join('\n'),
    ]),
  );
  return extract(questionsPrompt(questions, job), sources, placeOf(job), ctx);
}
