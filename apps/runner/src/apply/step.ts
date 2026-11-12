import type { AnswerValue, FormQuestion, Job } from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import { all } from '../linkedin/el.js';
import { FORM_DIALOG } from '../linkedin/selectors.js';
import { parsePage, type Document } from '../linkedin/dom.js';
import { readStep, stepKey } from '../linkedin/form-step.js';
import type { ReadField, StepRead } from '../linkedin/types.js';
import type { Pace } from '../pace/pace.js';
import {
  CHALLENGE,
  SIGN_IN_FORM,
  classifySession,
} from '../session/classify.js';
import { askBlocked, askSave } from '../terminal/ask.js';
import { fillField } from './fill.js';
import { authorStop, checkStop, needsAuthor, safety } from './stop.js';
import type {
  ApplyDeps,
  ApplyPage,
  ApplyRun,
  QuestionRecord,
} from './types.js';

/** At most this many read-answer-fill rounds per step. */
export const MAX_ROUNDS = 3;
export const POLL_MS = 500;

/** What one run carries from step to step. */
export interface Walk {
  deps: ApplyDeps;
  page: ApplyPage;
  /** Guarded: `stopReason()` is checked before each action. */
  pace: Pace;
  /** The same pace unguarded, for the close-out after Ctrl+C only. */
  unguarded: Pace;
  run: ApplyRun;
  bank: FactBank;
  /** The form step being walked (1-based), null before the form opens. */
  step: number | null;
}

type FormRead = Exclude<StepRead, { kind: 'none' }>;

/**
 * Reads the page and classifies it with slice 03's session signals, so a
 * security check or a sign-in page is caught on every read.
 */
export async function look(w: Pick<Walk, 'page'>): Promise<Document> {
  const doc = parsePage(await w.page.html());
  const seen = classifySession({
    path: w.page.path(),
    signInForms: all(doc, SIGN_IN_FORM).length,
    challenges: all(doc, CHALLENGE).length,
  });
  if (seen === 'security-check') {
    throw safety('security-check', 'a security check or captcha is showing');
  }
  if (seen === 'signed-out') {
    throw safety('signed-out', 'LinkedIn is showing a sign-in page');
  }
  return doc;
}

/** How long a settled step with no fields gets for its fields to show. */
export const EMPTY_SETTLE_MS = 2_000;

const isEmpty = (r: StepRead) =>
  r.kind !== 'none' && r.fields.length === 0 && r.unknown.length === 0;

/**
 * Reads the form every 500 ms, for up to `ms`, until a read that `accept`s
 * has settled: the same `stepKey` on two reads in a row. A settled step
 * with no fields and no unknowns is read for up to 2 s more, in case its
 * fields are still coming, before it is taken as empty. When time runs out
 * the last read is returned if it wasn't accepted (the caller deals with
 * it); an accepted read that never settled is a safety stop.
 */
export async function settleStep(
  w: Walk,
  ms: number,
  accept: (r: StepRead) => boolean,
): Promise<StepRead> {
  let prev: string | null = null;
  let emptyFrom: number | null = null;
  for (let i = 0; ; i++) {
    const r = readStep(await look(w));
    const key = accept(r) ? stepKey(r) : null;
    const settled = key !== null && key === prev;
    if (settled && !isEmpty(r)) return r;
    if (settled) {
      emptyFrom ??= i;
      if (i - emptyFrom >= EMPTY_SETTLE_MS / POLL_MS) return r;
    } else {
      emptyFrom = null;
    }
    if (i >= ms / POLL_MS) {
      if (key === null || settled) return r;
      throw safety('unexpected-page', 'the form did not settle');
    }
    prev = key;
    checkStop(w.deps);
    await w.deps.wait(POLL_MS);
  }
}

/**
 * Answers and fills every field of a step (or of a review page that still
 * has fields), re-reading after each round: a fill can reveal a follow-up
 * field. Returns the last read. A field that disappeared is dropped from
 * the report.
 */
export async function walkStep(w: Walk, first: FormRead): Promise<FormRead> {
  const step = w.step ?? 0;
  const title = first.kind === 'step' ? first.title : null;
  const seen = new Set<string>();
  const keyOf = new Map<QuestionRecord, string>();
  let read = first;
  let n = 0;
  for (let round = 1; ; round++) {
    if (read.unknown.length > 0) {
      w.run.unknownFields.push(...read.unknown);
      throw safety(
        'unknown-field',
        `${read.unknown.length} field(s) of a type the runner can't fill`,
      );
    }
    const fresh = read.fields.filter((f) => !seen.has(f.key));
    if (fresh.length === 0) break;
    if (round > MAX_ROUNDS) {
      throw safety(
        'too-many-rounds',
        `new fields still appearing after ${MAX_ROUNDS} rounds`,
      );
    }
    for (const f of fresh) {
      seen.add(f.key);
      const rec = await answerField(
        w,
        f,
        `s${step}-q${++n}`,
        title,
        read.fields,
      );
      keyOf.set(rec, f.key);
      await w.pace.pause();
    }
    const again = readStep(await look(w));
    if (again.kind !== read.kind) {
      throw safety('unexpected-page', 'the form changed while being filled');
    }
    read = again;
  }
  const kept = new Set(read.fields.map((f) => f.key));
  w.run.questions = w.run.questions.filter((q) => {
    const key = keyOf.get(q);
    return key === undefined || kept.has(key);
  });
  return read;
}

const asSaved = (v: AnswerValue) => (Array.isArray(v) ? v.join('; ') : v);

/** One field: the answerer, then the author if it blocks, then pace. */
async function answerField(
  w: Walk,
  f: ReadField,
  id: string,
  title: string | null,
  onStep: ReadField[],
): Promise<QuestionRecord> {
  const q: FormQuestion = {
    ...f.question,
    id,
    stepLabels: onStep.filter((o) => o !== f).map((o) => o.question.label),
  };
  if (title !== null) q.stepTitle = title;
  checkStop(w.deps);
  const result = await w.deps.answer(q, w.bank, jobOf(w));
  const rec: QuestionRecord = {
    step: w.step ?? 0,
    question: q,
    result,
    by: 'bot',
    filled: null,
    changedFromLinkedIn: false,
  };
  w.run.questions.push(rec);
  let why: string;
  if (result.status === 'backed') {
    // fillField refuses text it can't type (not-typeable) before acting.
    const fill = await fillField(f, result.value, ctx(w));
    if (fill.ok) {
      rec.filled = result.value;
      rec.changedFromLinkedIn = fill.changedFromLinkedIn;
      return rec;
    }
    rec.fillProblem = fill.reason;
    why = fill.reason;
  } else {
    why = result.detail ? `${result.reason}: ${result.detail}` : result.reason;
  }
  await blocked(w, f, rec, why, title);
  return rec;
}

/**
 * A blocked question. Without an author, a required one ends the run
 * unfilled and an optional one is left blank. With one, the author answers,
 * leaves it blank or stops; an answer that won't fill is asked again.
 */
async function blocked(
  w: Walk,
  f: ReadField,
  rec: QuestionRecord,
  why: string,
  title: string | null,
): Promise<void> {
  const { io } = w.deps;
  const q = rec.question;
  if (io === null) {
    if (q.required) {
      rec.by = 'needs-author';
      throw needsAuthor(q.id);
    }
    rec.by = 'blank';
    return;
  }
  for (;;) {
    const reply = await askBlocked(io, q, title, why);
    if (reply.kind === 'stop') {
      rec.by = 'needs-author';
      throw authorStop();
    }
    if (reply.kind === 'blank') {
      rec.by = 'blank';
      return;
    }
    const fill = await fillField(f, reply.value, ctx(w));
    if (!fill.ok) {
      why = fill.reason;
      io.print(`That answer could not be filled (${fill.reason}).`);
      continue;
    }
    rec.by = 'author';
    rec.filled = reply.value;
    rec.changedFromLinkedIn = fill.changedFromLinkedIn;
    if (await askSave(io)) save(w, rec, reply.value);
    return;
  }
}

/** Saves the author's answer, then reloads the bank for later questions. */
function save(w: Walk, rec: QuestionRecord, value: AnswerValue): void {
  const io = w.deps.io;
  const saved = w.deps.saveAnswer(
    { question: rec.question.label, answer: asSaved(value) },
    jobOf(w),
  );
  if (!saved.ok) {
    io?.print(`Not saved: ${saved.problems.join('; ')}`);
    return;
  }
  rec.savedAs = saved.id;
  try {
    w.bank = w.deps.loadBank();
    io?.print(`Saved as ${saved.id}.`);
  } catch {
    io?.print(`Saved as ${saved.id}, but the bank did not reload.`);
  }
}

/** Every fill keeps to the form's `<dialog>`, whose content scrolls on its own. */
const ctx = (w: Walk) => ({
  pace: w.pace,
  page: w.page,
  resume: w.deps.resume,
  within: FORM_DIALOG,
});

function jobOf(w: Walk): Job {
  if (!w.run.job) throw new Error('no job read before the form');
  return w.run.job;
}
