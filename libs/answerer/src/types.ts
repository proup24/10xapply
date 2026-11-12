import type { FactBank } from '@xapply/fact-bank';
import type { ModelCaller } from './model/caller.js';

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'select',
  'radio',
  'checkbox-group',
  'checkbox',
  'file',
  'typeahead',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const CHOICE_TYPES: readonly FieldType[] = [
  'select',
  'radio',
  'checkbox-group',
  'checkbox',
];

export const TEXT_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'typeahead',
];

export interface FormQuestion {
  id: string;
  label: string;
  type: string;
  options?: string[];
  required: boolean;
  helpText?: string;
  maxLength?: number;
  stepTitle?: string;
  /** Labels of the other questions on the same step. */
  stepLabels?: string[];
}

export interface Job {
  title: string;
  company: string;
  location?: string;
  description: string;
  source: string;
}

export type FieldKey =
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'phone'
  | 'phoneCountryCode'
  | 'phoneCountry'
  | 'city'
  | 'location'
  | 'country'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'website'
  | 'resume';

export type Source =
  | { kind: 'field'; key: FieldKey }
  | { kind: 'fact'; text: string }
  | { kind: 'answer'; id: string; variant?: number }
  | { kind: 'story'; id: string }
  | { kind: 'job-post'; quote: string }
  | { kind: 'run-date' };

export type Derivation =
  'field' | 'as-written' | 'fitted' | 'math' | 'bucket' | 'composed';

export type BlockReason =
  | 'bank-silent'
  | 'no-story-fits'
  | 'boundary'
  | 'check-failed'
  | 'verifier-rejected'
  | 'unsupported-field'
  | 'model-error';

export type AnswerValue = string | string[];

export interface Inference {
  claim: string;
  source: Source;
}

export type MathSpec =
  | { kind: 'years-since'; year: number; month?: number }
  | { kind: 'arithmetic'; expression: string };

export type Role = 'answer' | 'verify' | 'judge';

export interface CallStat {
  role: Role;
  model: string;
  latencyMs: number;
  costUsd: number | null;
  ok: boolean;
}

export interface ModelConfig {
  answerModel: string;
  verifyModel: string;
  maxRegenerations: number;
}

export interface AnswerContext {
  bank: FactBank;
  job: Job;
  /** YYYY-MM-DD */
  runDate: string;
  models: ModelConfig;
  caller: ModelCaller;
}

export type Candidate =
  | {
      outcome: 'cannot-answer';
      reason: 'bank-silent' | 'no-story-fits' | 'boundary';
    }
  | {
      outcome: 'answer';
      value: AnswerValue;
      sources: Source[];
      derivation: Exclude<Derivation, 'field'>;
      inferences: Inference[];
      math?: MathSpec;
    };

interface ResultBase {
  questionId: string;
  required: boolean;
  calls: CallStat[];
}

export type AnswerResult = ResultBase &
  (
    | {
        status: 'backed';
        value: AnswerValue;
        sources: Source[];
        derivation: Derivation;
        inferences: Inference[];
        verification: { verdict: 'confirmed' | 'not-needed'; rounds: number };
      }
    | { status: 'blocked'; reason: BlockReason; detail: string }
  );
