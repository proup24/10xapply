import type {
  AnswerResult,
  AnswerValue,
  CallStat,
  FormQuestion,
  Job,
} from '@xapply/answerer';
import type {
  CheckJob,
  CheckQuestion,
  Claim,
  ExtractResult,
  Rules,
} from '@xapply/disqualify';
import type { FactBank } from '@xapply/fact-bank';
import type { UnknownField } from '../linkedin/types.js';
import type { Pace } from '../pace/pace.js';
import type { JobStatus, RecordStore } from './record.js';
import type { TerminalIO } from '../terminal/author-mode.js';
import type { FillPage, FillProblem, Resume } from './fill.js';

export type SafetyStop =
  | 'security-check'
  | 'signed-out'
  | 'unknown-field'
  | 'unexpected-page'
  | 'step-did-not-change'
  | 'too-many-rounds'
  | 'check-failed'
  | 'record-changed';

export type StopKind =
  SafetyStop | 'bridge' | 'error' | 'author' | 'needs-author';

export type ApplyOutcome =
  | 'reached-review'
  | 'disqualified'
  | 'not-easy-apply'
  | 'already-applied'
  | 'submitted'
  | 'submit-unconfirmed'
  | 'safety-stop'
  | 'needs-author'
  | 'stopped'
  | 'bridge-unavailable';

export interface QuestionRecord {
  step: number;
  question: FormQuestion;
  /** Null when the answerer wasn't reached. */
  result: AnswerResult | null;
  by: 'bot' | 'author' | 'blank' | 'needs-author';
  filled: AnswerValue | null;
  changedFromLinkedIn: boolean;
  /** The known-answer id the author's answer was saved as. */
  savedAs?: string;
  fillProblem?: FillProblem;
}

/** One requirements check: the job page's, or one round of a step's. */
export interface CheckRecord {
  at: 'job-page' | 'step';
  /** The form step, null for the job page. */
  step: number | null;
  /** False when the check failed (`check-failed`): its claims are not known. */
  ok: boolean;
  /** Empty when the check failed. */
  claims: Claim[];
  /** Kept even when the check failed. */
  calls: CallStat[];
}

export interface ApplyRun {
  jobId: string;
  startedAt: string;
  outcome: ApplyOutcome;
  stop?: {
    /**
     * `bridge`: `stopReason()` was set (Ctrl+C is `interrupted`). `error`:
     * anything else thrown. `author`: the author typed s at a prompt.
     * `needs-author`: a blocked required question with no author present.
     */
    kind: StopKind;
    step: number | null;
    /**
     * Our own words, the stop reason, or an error's name; never a label or
     * a value. For the full report only.
     */
    detail: string;
    /**
     * `error` only: the first line of the error's message, at most 200
     * characters. It can quote the page, so it is for the full report only.
     */
    error?: string;
    /** LinkedIn's error text on a step that didn't change; full report only. */
    pageErrors?: string[];
    /** `pathPrefix` of the page's path at the stop, or null if unreadable. */
    pathPrefix: string | null;
  };
  job: Job | null;
  questions: QuestionRecord[];
  unknownFields: UnknownField[];
  /** Every requirements check made, in order. */
  checks: CheckRecord[];
  /** `disqualified` only: the claims that disqualified, the first the headline. */
  disqualification: Claim[] | null;
  /**
   * `already-applied` and `disqualified` only: whether the record or
   * LinkedIn's own page said so.
   */
  via: 'record' | 'linkedin' | null;
  /** The job's status in the record before the run and after it. */
  record: {
    before: JobStatus | null;
    beforeAt: string | null;
    after: JobStatus | null;
  };
  timings: {
    totalMs: number;
    perStepMs: number[];
    submit: {
      clickToSentMs: number | null;
      sentToMarkerMs: number | null;
    } | null;
  };
}

/** The run tab. `goto` and `close` are navigation, not input. */
export interface ApplyPage extends FillPage {
  goto(url: string): Promise<void>;
  /** The page URL's path. */
  path(): string;
  /** The page's HTML, open shadow roots serialised as templates. */
  html(): Promise<string>;
  close(): Promise<void>;
}

export interface ApplyDeps {
  openPage(): Promise<ApplyPage>;
  pace(page: ApplyPage): Pace;
  /** Non-null once the run must end: Ctrl+C ('interrupted') or the bridge. */
  stopReason(): string | null;
  answer(q: FormQuestion, bank: FactBank, job: Job): Promise<AnswerResult>;
  loadBank(): FactBank;
  saveAnswer(
    entry: { question: string; answer: string },
    job: Job,
  ): { ok: true; id: string } | { ok: false; problems: string[] };
  /** Null outside author mode. */
  io: TerminalIO | null;
  resume: Resume;
  now(): number;
  wait(ms: number): Promise<void>;
  /** The job page's requirements check. */
  checkJob(job: CheckJob): Promise<ExtractResult>;
  /** One round's requirements check, over all its fresh questions. */
  checkQuestions(qs: CheckQuestion[], job: CheckJob): Promise<ExtractResult>;
  rules: Rules;
  /** Null: a dry run whose record didn't load; nothing is read or written. */
  record: RecordStore | null;
  /** False for `--dry-run`. */
  submit: boolean;
}
