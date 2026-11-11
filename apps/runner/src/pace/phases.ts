import type { PageInfo, RecordedEvent, Recording } from './recording.js';

export type Phase =
  'job-page' | 'description' | 'easy-apply-step' | 'review' | 'submitted';

export interface PhaseTag {
  phase: Phase;
  /** 1-based Easy Apply step for `easy-apply-step`, otherwise null. */
  step: number | null;
}

/** What tagging one event needs to know about the whole application. */
export interface PhaseContext {
  /** Distinct non-100 progress values seen in the application, ascending. */
  steps: number[];
  /** Time from which the application counts as submitted, or null. */
  submitAt: number | null;
}

/** The dialog's progress value on the review step. */
export const REVIEW_PROGRESS = 100;
/** The description counts as expanded once its height grows by more than this. */
const GROWTH = 0.2;

const isPress = (e: RecordedEvent) => e.type === 'pointerdown';
const inForm = (e: RecordedEvent) => e.ctx.progress !== null;

/** True when the recording holds an Easy Apply dialog (any progress value). */
export function isApplication(rec: Recording): boolean {
  return rec.events.some(inForm);
}

/**
 * The submit press: the last button click on the review step after which no
 * press lands in a dialog with a progress bar (the dialog closed, or, on the
 * practice page, there is nothing left to press). Returns the time of the
 * pointerdown that started that click, or the click's own time.
 */
function submitTime(events: RecordedEvent[]): number | null {
  let lastFormPress = -Infinity;
  for (const e of events) if (isPress(e) && inForm(e)) lastFormPress = e.t;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'click') continue;
    if (e.ctx.progress !== REVIEW_PROGRESS || e.target.kind !== 'button') {
      continue;
    }
    // A press after this click's own pointerdown means the form went on.
    let down: RecordedEvent | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (isPress(events[j])) {
        down = events[j];
        break;
      }
    }
    const start = down?.t ?? e.t;
    return lastFormPress <= start ? start : null;
  }
  return null;
}

/** Works out the application-wide facts once, from time-ordered events. */
export function phaseContext(events: RecordedEvent[]): PhaseContext {
  const steps = [
    ...new Set(
      events
        .map((e) => e.ctx.progress)
        .filter((p): p is number => p !== null && p !== REVIEW_PROGRESS),
    ),
  ].sort((a, b) => a - b);
  return { steps, submitAt: submitTime(events) };
}

/** When the description of `path` first grew by more than 20%, or null. */
export function growthTime(pages: PageInfo[], path: string): number | null {
  let base: number | null = null;
  for (const p of [...pages].sort((a, b) => a.t - b.t)) {
    if (p.ctx.path !== path || !p.desc) continue;
    if (base === null) base = p.desc.height;
    else if (p.desc.height > base * (1 + GROWTH)) return p.t;
  }
  return null;
}

/**
 * Tags one event with its phase, from its path, dialog and progress, its
 * target and the page records — never from text. `context` carries what one
 * event cannot show: the step values seen and the submit time
 * (`phasesOf` builds it for a whole recording).
 */
export function phaseOf(
  e: RecordedEvent,
  pages: PageInfo[],
  context: PhaseContext = { steps: [], submitAt: null },
): PhaseTag {
  if (context.submitAt !== null && e.t >= context.submitAt) {
    return { phase: 'submitted', step: null };
  }
  const p = e.ctx.progress;
  if (p === REVIEW_PROGRESS) return { phase: 'review', step: null };
  if (p !== null) {
    const seen = context.steps.includes(p)
      ? context.steps
      : [...context.steps, p].sort((a, b) => a - b);
    return { phase: 'easy-apply-step', step: seen.indexOf(p) + 1 };
  }
  if (!e.ctx.dialog) {
    if (e.target.inDescription) return { phase: 'description', step: null };
    const grown = growthTime(pages, e.ctx.path);
    if (grown !== null && e.t >= grown) {
      return { phase: 'description', step: null };
    }
  }
  return { phase: 'job-page', step: null };
}

/** Time-ordered events of a recording (stable for equal times). */
export function sortedEvents(rec: Recording): RecordedEvent[] {
  return [...rec.events].sort((a, b) => a.t - b.t);
}

/** Phase of every event of `rec`, in time order (see `sortedEvents`). */
export function phasesOf(rec: Recording): PhaseTag[] {
  const events = sortedEvents(rec);
  const context = phaseContext(events);
  return events.map((e) => phaseOf(e, rec.pages, context));
}
