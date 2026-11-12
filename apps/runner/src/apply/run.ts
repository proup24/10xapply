import { readDiscard, readDismiss } from '../linkedin/close.js';
import type { Document } from '../linkedin/dom.js';
import { all, textOf } from '../linkedin/el.js';
import { stepKey } from '../linkedin/form-step.js';
import { readFormCompany, readJobPage } from '../linkedin/job-page.js';
import { jobViewUrl } from '../linkedin/job-url.js';
import { FORM_DIALOG, MORE_BUTTON } from '../linkedin/selectors.js';
import type { StepRead } from '../linkedin/types.js';
import { pathPrefix } from '../reports/write-report.js';
import { RunEnd, asRunEnd, checkStop, guardPace, safety } from './stop.js';
import { POLL_MS, look, settleStep, walkStep, type Walk } from './step.js';
import type { ApplyDeps, ApplyPage, ApplyRun } from './types.js';

/**
 * How long the form gets to open, and a step to change after Next, before
 * it settles (two reads in a row agree).
 */
const STEP_WAIT_MS = 10_000;
/** How long the job page gets to render its details after the load event. */
const JOB_WAIT_MS = 10_000;
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
    const unguarded = deps.pace(page);
    w = {
      deps,
      page,
      pace: guardPace(unguarded, deps),
      unguarded,
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

/**
 * LinkedIn renders the job details after the load event. Reads every 500 ms,
 * for up to `ms`, until the page shows as applied, or has a description and
 * the same decision (Easy Apply present or not, same description length) on
 * two reads in a row. If time runs out the last read is returned. Every read
 * goes through `look`, so the sign-in and security checks run on each one.
 */
async function settleJobPage(w: Walk, ms: number) {
  let prev: string | null = null;
  for (let i = 0; ; i++) {
    const doc = await look(w);
    const jr = readJobPage(doc);
    if (jr.applied) return { doc, jr };
    const key =
      jr.description === null
        ? null
        : `${jr.easyApply !== null}:${jr.description.length}`;
    if (key !== null && key === prev) return { doc, jr };
    if (i >= ms / POLL_MS) return { doc, jr };
    prev = key;
    checkStop(w.deps);
    await w.deps.wait(POLL_MS);
  }
}

/** Loads and checks the job, reads the post, then clicks Easy Apply. */
async function openJob(w: Walk): Promise<void> {
  const { page, pace, run } = w;
  checkStop(w.deps);
  await page.goto(jobViewUrl(run.jobId));
  const { doc, jr } = await settleJobPage(w, JOB_WAIT_MS);
  if (jr.applied) throw new RunEnd('already-applied');
  // A page still missing its description is never judged on its button.
  if (jr.description === null) {
    throw safety('unexpected-page', 'no job description on the page');
  }
  if (jr.easyApply === null) throw new RunEnd('not-easy-apply');
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
  let read = await settleStep(w, STEP_WAIT_MS, (r) => r.kind !== 'none');
  if (read.kind === 'none') {
    throw safety('unexpected-page', 'no Easy Apply form after the click');
  }
  // A company the job page didn't name comes from the form's heading.
  if (w.run.job && w.run.job.company === '') {
    w.run.job.company = readFormCompany(await look(w)) ?? '';
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
    try {
      const done = await walkStep(w, read);
      if (done.kind === 'review') return;
      read = await advance(w, done);
    } finally {
      // A step that stopped is timed too.
      w.run.timings.perStepMs.push(w.deps.now() - t);
    }
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
  guardNext(await look(w), read.next);
  await pace.click(page.locator(read.next.selector), {
    within: page.locator(FORM_DIALOG),
  });
  const after = await settleStep(
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

const SUBMIT = /submit/i;

type Next = NonNullable<Extract<StepRead, { kind: 'step' }>['next']>;

/**
 * Belt and braces beside the reader: refuses a Next whose label, or whose
 * button's text or aria-label, reads "submit".
 */
export function guardNext(doc: Document, next: Next): void {
  const buttons = all(doc, next.selector);
  if (
    SUBMIT.test(next.label) ||
    buttons.some(
      (b) =>
        SUBMIT.test(textOf(b)) ||
        SUBMIT.test(b.getAttribute('aria-label') ?? ''),
    )
  ) {
    throw safety('unexpected-page', 'the next button reads Submit');
  }
}

/** The stop reason Ctrl+C sets (Task 13). */
export const INTERRUPTED = 'interrupted';

/**
 * Closes the run window. Once the form has opened, the author first gets
 * an Enter to look at the page (on review or a safety stop), then the form
 * is dismissed and LinkedIn's "Save this application?" answered with
 * Discard, so no draft is kept. Ctrl+C still gets the Dismiss and Discard,
 * without the Enter; any other bridge stop goes straight to closing.
 * Whatever fails here, the page closes.
 */
async function closeOut(w: Walk, formOpen: boolean): Promise<void> {
  const { deps, page, run } = w;
  /** A stop other than Ctrl+C: the bridge is going away, so don't act. */
  const bridgeGone = () => {
    const reason = deps.stopReason();
    return reason !== null && reason !== INTERRUPTED;
  };
  const bridgeStop =
    run.stop?.kind === 'bridge' && run.stop.detail !== INTERRUPTED;
  try {
    if (formOpen && !bridgeStop) {
      // Ctrl+C or end of input at the Enter still dismisses and discards.
      try {
        if (deps.io && run.outcome === 'reached-review') {
          await deps.io.ask(REVIEW_PROMPT);
        } else if (deps.io && run.outcome === 'safety-stop') {
          await deps.io.ask(STOP_PROMPT);
        }
      } catch {
        // Carry on to Dismiss and Discard.
      }
      await dismissAndDiscard(w, bridgeGone);
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

/**
 * Dismiss, then Discard once the save prompt shows (up to 5 s). Uses the
 * unguarded pace, so Ctrl+C doesn't block it; `bridgeGone` is checked
 * before each step instead.
 */
async function dismissAndDiscard(
  w: Walk,
  bridgeGone: () => boolean,
): Promise<void> {
  const { page, unguarded: pace } = w;
  if (bridgeGone()) return;
  const dismiss = readDismiss(await look(w));
  if (dismiss === null || bridgeGone()) return;
  await pace.click(page.locator(dismiss), {
    within: page.locator(FORM_DIALOG),
  });
  for (let i = 0; ; i++) {
    if (bridgeGone()) return;
    const selector = readDiscard(await look(w));
    if (selector !== null) {
      // The prompt is its own small dialog with no stable selector, so its
      // Discard is clicked against the window, not a `within` box.
      await pace.click(page.locator(selector));
      return;
    }
    if (i >= PROMPT_WAIT_MS / POLL_MS) return;
    await w.deps.wait(POLL_MS);
  }
}
