import { jobViewUrl } from '../commands/snapshot.js';
import { readDiscard, readDismiss } from '../linkedin/close.js';
import { all } from '../linkedin/el.js';
import { stepKey } from '../linkedin/form-step.js';
import { readJobPage } from '../linkedin/job-page.js';
import { MORE_BUTTON } from '../linkedin/selectors.js';
import type { StepRead } from '../linkedin/types.js';
import { pathPrefix } from '../reports/write-report.js';
import { RunEnd, asRunEnd, checkStop, guardPace, safety } from './stop.js';
import { POLL_MS, look, pollStep, walkStep, type Walk } from './step.js';
import type { ApplyDeps, ApplyPage, ApplyRun } from './types.js';

/** How long the form gets to open, and a step to change after Next. */
const STEP_WAIT_MS = 10_000;
/** How long the "Save this application?" prompt gets after Dismiss. */
const PROMPT_WAIT_MS = 5_000;
export const REVIEW_PROMPT =
  'Review page reached. Press Enter to close the window.';
const STOP_PROMPT = 'The run stopped. Press Enter to close the window.';

/**
 * Walks one job's Easy Apply form to the review page and stops there. It
 * never submits: no control whose text or aria-label reads "submit" is ever
 * acted on. The page is closed whatever happens.
 */
export async function runApply(
  jobId: string,
  deps: ApplyDeps,
): Promise<ApplyRun> {
  const t0 = deps.now();
  const run: ApplyRun = {
    jobId,
    startedAt: new Date(t0).toISOString(),
    outcome: 'stopped',
    job: null,
    questions: [],
    unknownFields: [],
    timings: { totalMs: 0, perStepMs: [] },
  };
  let page: ApplyPage | null = null;
  let w: Walk | null = null;
  let formOpen = false;
  try {
    checkStop(deps);
    const bank = deps.loadBank();
    checkStop(deps);
    try {
      page = await deps.openPage();
    } catch {
      throw new RunEnd('bridge-unavailable', {
        kind: 'bridge',
        detail: 'could not open a run tab',
      });
    }
    w = {
      deps,
      page,
      pace: guardPace(deps.pace(page), deps),
      run,
      bank,
      step: null,
    };
    await openJob(w);
    formOpen = true;
    await walkForm(w);
    run.outcome = 'reached-review';
  } catch (e) {
    const end = asRunEnd(e, deps);
    run.outcome = end.outcome;
    if (end.stop) {
      run.stop = {
        ...end.stop,
        step: w?.step ?? null,
        pathPrefix: w ? prefixOf(w.page) : null,
      };
    }
  } finally {
    if (w) await closeOut(w, formOpen);
    else await page?.close().catch(() => undefined);
    run.timings.totalMs = deps.now() - t0;
  }
  return run;
}

function prefixOf(page: ApplyPage): string | null {
  try {
    return pathPrefix(page.path());
  } catch {
    return null;
  }
}

/** Loads and checks the job, reads the post, then clicks Easy Apply. */
async function openJob(w: Walk): Promise<void> {
  const { page, pace, run } = w;
  checkStop(w.deps);
  await page.goto(jobViewUrl(run.jobId));
  const doc = await look(w);
  const jr = readJobPage(doc);
  if (jr.applied) throw new RunEnd('already-applied');
  if (jr.easyApply === null) throw new RunEnd('not-easy-apply');
  if (jr.description === null) {
    throw safety('unexpected-page', 'no job description on the page');
  }
  run.job = {
    title: jr.title ?? '',
    company: jr.company ?? '',
    description: jr.description,
    source: 'LinkedIn',
  };
  if (jr.location !== null) run.job.location = jr.location;
  await pace.read(jr.description.length);
  if (pace.maybe('scroll-description') && all(doc, MORE_BUTTON).length === 1) {
    await pace.scroll(page.locator(MORE_BUTTON));
  }
  await pace.pause();
  await pace.click(page.locator(jr.easyApply));
}

/** Each step in turn until the review page; its fields too, if it has any. */
async function walkForm(w: Walk): Promise<void> {
  let read = await pollStep(w, STEP_WAIT_MS, (r) => r.kind !== 'none');
  if (read.kind === 'none') {
    throw safety('unexpected-page', 'no Easy Apply form after the click');
  }
  for (let n = 1; ; n++) {
    if (
      read.kind === 'review' &&
      read.fields.length === 0 &&
      read.unknown.length === 0
    ) {
      return;
    }
    w.step = n;
    const t = w.deps.now();
    const done = await walkStep(w, read);
    if (done.kind === 'review') {
      w.run.timings.perStepMs.push(w.deps.now() - t);
      return;
    }
    read = await advance(w, done);
    w.run.timings.perStepMs.push(w.deps.now() - t);
  }
}

/** Clicks Next or Review and waits for the step to change. */
async function advance(
  w: Walk,
  read: Extract<StepRead, { kind: 'step' }>,
): Promise<Exclude<StepRead, { kind: 'none' }>> {
  if (read.next === null) {
    throw safety('unexpected-page', 'no Next or Review button on the step');
  }
  const { pace, page } = w;
  const before = stepKey(read);
  await pace.click(page.locator(read.next.selector));
  const after = await pollStep(
    w,
    STEP_WAIT_MS,
    (r) => r.kind !== 'none' && stepKey(r) !== before,
  );
  if (after.kind === 'none') {
    throw safety('unexpected-page', 'the form went away after Next');
  }
  if (stepKey(after) === before) {
    throw safety(
      'step-did-not-change',
      `the step did not change after ${read.next.label}`,
      after.kind === 'step' ? after.errors : [],
    );
  }
  return after;
}

/**
 * Closes the run window. Once the form has opened (and unless the bridge
 * stopped the run), the author first gets an Enter to look at the page, then
 * the form is dismissed and LinkedIn's "Save this application?" answered
 * with Discard, so no draft is kept. Whatever fails here, the page closes.
 */
async function closeOut(w: Walk, formOpen: boolean): Promise<void> {
  const { deps, page, pace, run } = w;
  try {
    if (
      formOpen &&
      run.stop?.kind !== 'bridge' &&
      run.outcome !== 'bridge-unavailable'
    ) {
      if (deps.io && run.outcome === 'reached-review') {
        await deps.io.ask(REVIEW_PROMPT);
      } else if (deps.io && run.outcome === 'safety-stop') {
        await deps.io.ask(STOP_PROMPT);
      }
      checkStop(deps);
      const dismiss = readDismiss(await look(w));
      if (dismiss !== null) {
        await pace.click(page.locator(dismiss));
        await discard(w);
      }
    }
  } catch {
    // Closing the page below is what matters.
  }
  try {
    await page.close();
  } catch {
    // The tab is already gone.
  }
}

async function discard(w: Walk): Promise<void> {
  const { pace, page } = w;
  for (let i = 0; ; i++) {
    const selector = readDiscard(await look(w));
    if (selector !== null) {
      await pace.click(page.locator(selector));
      return;
    }
    if (i >= PROMPT_WAIT_MS / POLL_MS) return;
    checkStop(w.deps);
    await w.deps.wait(POLL_MS);
  }
}
