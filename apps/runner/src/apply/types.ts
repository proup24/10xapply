import type {
  AnswerResult,
  AnswerValue,
  FormQuestion,
  Job,
} from '@xapply/answerer';
import type { FactBank } from '@xapply/fact-bank';
import type { UnknownField } from '../linkedin/types.js';
import type { Pace } from '../pace/pace.js';
import type { TerminalIO } from '../terminal/author-mode.js';
import type { FillPage, FillResult, Resume } from './fill.js';

export type SafetyStop =
  | 'security-check'
  | 'signed-out'
  | 'unknown-field'
  | 'unexpected-page'
  | 'step-did-not-change'
  | 'too-many-rounds';

export type ApplyOutcome =
  | 'reached-review'
  | 'not-easy-apply'
  | 'already-applied'
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
  fillProblem?: Extract<FillResult, { ok: false }>['reason'];
}

export interface ApplyRun {
  jobId: string;
  startedAt: string;
  outcome: ApplyOutcome;
  stop?: {
    kind: SafetyStop | 'bridge';
    step: number | null;
    /** Our own words, or the bridge's; for the full report only. */
    detail: string;
    /** LinkedIn's error text on a step that didn't change; full report only. */
    pageErrors?: string[];
    /** `pathPrefix` of the page's path at the stop, or null if unreadable. */
    pathPrefix: string | null;
  };
  job: Job | null;
  questions: QuestionRecord[];
  unknownFields: UnknownField[];
  timings: { totalMs: number; perStepMs: number[] };
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
}
