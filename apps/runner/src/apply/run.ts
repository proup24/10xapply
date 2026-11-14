import {
  readDiscard,
  readDismiss,
  readPromptDialog,
} from '../linkedin/close.js';
import type { Document } from '../linkedin/dom.js';
import { all, textOf } from '../linkedin/el.js';
import { readStep, stepKey } from '../linkedin/form-step.js';
import { readFormCompany, readJobPage } from '../linkedin/job-page.js';
import { jobViewUrl } from '../linkedin/job-url.js';
import {
  FORM_CONTENT,
  FORM_DIALOG,
  MORE_BUTTON,
  SENT_DIALOG,
} from '../linkedin/selectors.js';
import { readSent } from '../linkedin/sent.js';
import type { StepRead } from '../linkedin/types.js';
import { pathPrefix } from '../reports/write-report.js';
import { awaitCheck, checkJobOf, judge, offersOf } from './check.js';
import { ReadMismatchError } from './fill.js';
import { recordDisqualified, recordSet } from './record-run.js';
import { startDecision } from './record.js';
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
/** How long a leftover `submitting` waits before the one reload that rechecks it. */
export const LEFTOVER_RECHECK_MS = 10_000;
/** How long LinkedIn's "application sent" dialog gets after Submit. */
export const SENT_WAIT_MS = 15_000;
/** How long each job-page load after Submit gets to show the Applied marker. */
export const MARKER_WAIT_MS = 10_000;
export const REVIEW_PROMPT =
  'Review page reached. Press Enter to close the window.';
const STOP_PROMPT = 'The run stopped. Press Enter to close the window.';

/**
 * Walks one job's Easy Apply form to the review page. A dry run stops
 * there; otherwise the form is submitted once (`submitForm`). Before the
 * review page no control whose text or aria-label reads "submit" is ever
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
    checks: [],
    disqualification: null,
    via: null,
    record: { before: null, beforeAt: null, after: null },
    timings: { totalMs: 0, perStepMs: [], submit: null },
  };
  let page: ApplyPage | null = null;
  let w: Walk | null = null;
  let formOpen = false;
  try {
    checkStop(deps);
    const bank = deps.loadBank();
    checkStop(deps);
    const before = deps.record?.get(jobId) ?? null;
    run.record = {
      before: before?.status ?? null,
      beforeAt: before?.updatedAt ?? null,
      after: before?.status ?? null,
    };
    const decision = startDecision(before, !deps.submit);
    if (decision === 'refuse-applied' || decision === 'refuse-disqualified') {
      run.via = 'record';
      throw new RunEnd(
        decision === 'refuse-applied' ? 'already-applied' : 'disqualified',
      );
    }
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
      offers: [],
    };
    await openJob(w, decision === 'settle-leftover');
    formOpen = true;
    const review = await walkForm(w);
    // Dry runs too: the form is discarded anyway, and the path is exercised.
    await untickFollow(w, review);
    if (deps.submit) await submitForm(w, review);
    else run.outcome = 'reached-review';
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

/**
 * Loads and checks the job, reads the post, then clicks Easy Apply. The
 * requirements check runs while the post is read; Easy Apply is clicked
 * only once it has returned and passed.
 */
async function openJob(w: Walk, leftover: boolean): Promise<void> {
  const { page, pace, run } = w;
  checkStop(w.deps);
  await page.goto(jobViewUrl(run.jobId));
  let { doc, jr } = await settleJobPage(w, JOB_WAIT_MS);
  if (leftover && !jr.applied) {
    // A Submit that may have gone through: give LinkedIn time, look once more.
    await w.deps.wait(LEFTOVER_RECHECK_MS);
    checkStop(w.deps);
    await page.goto(jobViewUrl(run.jobId));
    ({ doc, jr } = await settleJobPage(w, JOB_WAIT_MS));
    if (!jr.applied) {
      recordSet(w, { status: 'failed', reason: 'submit-unconfirmed' });
      throw new RunEnd('submit-unconfirmed');
    }
  }
  if (jr.applied) {
    run.via = 'linkedin';
    recordSet(w, { status: 'applied', source: 'linkedin-marker' });
    throw new RunEnd('already-applied');
  }
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
  const check = w.deps.checkJob(checkJobOf(run.job));
  // Awaited below; until then an early failure must not go unhandled.
  check.catch(() => undefined);
  await pace.read(jr.description.length);
  if (pace.maybe('scroll-description') && all(doc, MORE_BUTTON).length === 1) {
    await pace.scroll(page.locator(MORE_BUTTON));
  }
  await pace.pause();
  const claims = await awaitCheck(w, 'job-page', null, check);
  w.offers = offersOf(claims);
  judge(w, claims, w.offers, (reasons) => recordDisqualified(w, reasons));
  await pace.click(page.locator(jr.easyApply));
}

type Review = Extract<StepRead, { kind: 'review' }>;

/**
 * Each step in turn until the review page; its fields too, if it has any.
 * Returns the review page's last read.
 */
async function walkForm(w: Walk): Promise<Review> {
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
      return read;
    }
    w.step = n;
    const t = w.deps.now();
    try {
      const done = await walkStep(w, read);
      if (done.kind === 'review') return done;
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
    within: page.locator(FORM_CONTENT),
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

/**
 * LinkedIn's "Follow <company>" box on the review page comes ticked; the
 * author wants it unticked. Its state is read live: ticked, it gets one
 * press, inside the form, and must read unticked after, or the run stops
 * before anything is written or submitted. Unticked, nothing is pressed.
 * Details are fixed words: the box's label names the company.
 */
async function untickFollow(w: Walk, review: Review): Promise<void> {
  const { follow } = review;
  if (follow === null) return;
  const { page, pace } = w;
  if (!(await followTicked(w, follow.box))) return;
  await pace.click(page.locator(follow.press), {
    within: page.locator(FORM_DIALOG),
  });
  if (await followTicked(w, follow.box)) {
    throw safety('unexpected-page', 'the follow box stayed ticked');
  }
}

/** The box's checked state; a read that times out or misses is a stop. */
async function followTicked(w: Walk, box: string): Promise<boolean> {
  try {
    return await w.page.checked(box);
  } catch (e) {
    const soft =
      e instanceof ReadMismatchError ||
      (e instanceof Error && e.name === 'TimeoutError');
    if (soft) throw safety('unexpected-page', 'could not read the follow box');
    throw e;
  }
}

/**
 * Submits the form, once. In order: the record is re-read and must be as
 * the run found it; `submitting` is written (flushed) before anything is
 * pressed; the Submit selector comes from a fresh read of the review page;
 * `submitClicked` is set before the click goes out, so no path presses
 * anything after it. Then LinkedIn's "application sent" dialog is waited
 * for and closed, and the job page reloaded until it shows as applied (one
 * more reload after `LEFTOVER_RECHECK_MS` if not). Submit is never clicked
 * a second time, whatever the page does.
 */
async function submitForm(w: Walk, review: Review): Promise<void> {
  const { deps, page, pace, run } = w;
  if (w.submitClicked) throw new Error('Submit was already clicked');
  if (review.submit === null) {
    throw safety('unexpected-page', 'no single Submit button');
  }
  checkStop(deps);
  const now = deps.record?.get(run.jobId) ?? null;
  if (
    (now?.status ?? null) !== run.record.before ||
    (now?.updatedAt ?? null) !== run.record.beforeAt
  ) {
    throw safety('record-changed', 'the record changed during the run');
  }
  if (!recordSet(w, { status: 'submitting' })) {
    throw safety('unexpected-page', 'could not write the record');
  }
  // LinkedIn re-renders ids: the selector must come from the page as it is.
  const fresh = readStep(await look(w));
  if (fresh.kind !== 'review' || fresh.submit === null) {
    throw safety('unexpected-page', 'no single Submit button');
  }
  const timing: NonNullable<ApplyRun['timings']['submit']> = {
    clickToSentMs: null,
    sentToMarkerMs: null,
  };
  run.timings.submit = timing;
  w.submitClicked = true;
  const clickedAt = deps.now();
  await pace.click(page.locator(fresh.submit), {
    within: page.locator(FORM_DIALOG),
  });
  const sentAt = await closeSent(w);
  if (sentAt !== null) timing.clickToSentMs = sentAt - clickedAt;
  let applied = await reloadForMarker(w);
  if (!applied) {
    await deps.wait(LEFTOVER_RECHECK_MS);
    applied = await reloadForMarker(w);
  }
  if (applied) {
    if (sentAt !== null) timing.sentToMarkerMs = deps.now() - sentAt;
    recordSet(w, { status: 'applied', source: 'submit' });
    run.outcome = 'submitted';
  } else {
    recordSet(w, { status: 'failed', reason: 'submit-unconfirmed' });
    run.outcome = 'submit-unconfirmed';
  }
}

/**
 * Waits up to `SENT_WAIT_MS` for the "application sent" dialog and closes
 * it with its own Dismiss, inside the dialog. A dialog whose Dismiss can't
 * be pinned is left for the reload. Returns when it was seen, or null.
 */
async function closeSent(w: Walk): Promise<number | null> {
  const { deps, page, pace } = w;
  for (let i = 0; ; i++) {
    checkStop(deps);
    const sent = readSent(await look(w));
    if (sent) {
      const at = deps.now();
      if (sent.close !== null) {
        try {
          await pace.click(page.locator(sent.close), {
            within: page.locator(SENT_DIALOG),
          });
        } catch (e) {
          // Submit already went out: a refused Dismiss must not end the run
          // before the marker reload. Real stops (Ctrl+C, bridge gone,
          // RunEnd) still propagate.
          const end = asRunEnd(e, deps);
          const refused =
            !(e instanceof RunEnd) &&
            end.outcome === 'safety-stop' &&
            end.stop?.kind === 'unexpected-page';
          if (!refused) throw e;
        }
      }
      return at;
    }
    if (i >= SENT_WAIT_MS / POLL_MS) return null;
    await deps.wait(POLL_MS);
  }
}

/**
 * Loads the job page and reads it every `POLL_MS` until it shows as
 * applied, for up to `MARKER_WAIT_MS`. A page that is stable but not yet
 * applied is read again: after a submit the marker can be slow. True once
 * the marker shows. Every read goes through `look`.
 */
async function reloadForMarker(w: Walk): Promise<boolean> {
  const { deps } = w;
  checkStop(deps);
  await w.page.goto(jobViewUrl(w.run.jobId));
  for (let i = 0; ; i++) {
    if (readJobPage(await look(w)).applied) return true;
    if (i >= MARKER_WAIT_MS / POLL_MS) return false;
    checkStop(deps);
    await deps.wait(POLL_MS);
  }
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
 * without the Enter; any other bridge stop goes straight to closing. Once
 * Submit was clicked (or was about to be), nothing is pressed and nothing
 * asked: the page just closes. Whatever fails here, the page closes.
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
    if (formOpen && !bridgeStop && !w.submitClicked) {
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
 * Closes the form without keeping a draft. A save prompt already open (a
 * press that landed on the backdrop opens it) gets its Discard straight
 * away. Otherwise the form's own Dismiss, then Discard once the prompt
 * shows (up to 5 s). Save is never clicked, and neither is a Discard whose
 * dialog can't be pinned for `within`. Uses the unguarded pace, so
 * Ctrl+C doesn't block it; `bridgeGone` is checked before each step
 * instead.
 */
async function dismissAndDiscard(
  w: Walk,
  bridgeGone: () => boolean,
): Promise<void> {
  const { page, unguarded: pace } = w;
  if (bridgeGone()) return;
  const doc = await look(w, { prompt: 'allow' });
  if (bridgeGone()) return;
  if (await discard(w, doc)) return;
  const dismiss = readDismiss(doc);
  if (dismiss === null) return;
  await pace.click(page.locator(dismiss), {
    within: page.locator(FORM_DIALOG),
  });
  for (let i = 0; ; i++) {
    if (bridgeGone()) return;
    if (await discard(w, await look(w, { prompt: 'allow' }))) return;
    if (i >= PROMPT_WAIT_MS / POLL_MS) return;
    await w.deps.wait(POLL_MS);
  }
}

/**
 * When the save prompt shows on `doc`, clicks its Discard inside the
 * prompt's own dialog. A prompt whose dialog no selector picks out alone
 * gets no press at all (the page is closed instead). True when the prompt
 * showed, pressed or not.
 */
async function discard(w: Walk, doc: Document): Promise<boolean> {
  const selector = readDiscard(doc);
  if (selector === null) return false;
  const dialog = readPromptDialog(doc);
  if (dialog === null) return true;
  const { page, unguarded: pace } = w;
  await pace.click(page.locator(selector), { within: page.locator(dialog) });
  return true;
}
