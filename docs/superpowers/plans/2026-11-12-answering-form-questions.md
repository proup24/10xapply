# Answering Form Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A library, `libs/answerer`, that answers one Easy Apply form question from the fact bank and the job post, or blocks it. It comes with a golden-set eval command, `runner answers eval`.

**Architecture:** The answerer runs four stages, each in its own module:

1. Code-only field mapping.
2. A generator call.
3. Deterministic checks.
4. An independent verifier call, with one regeneration if the verifier rejects.

Every model call goes through a `ModelCaller` interface. The real implementation runs a locked-down `claude -p` child process on the author's subscription. Unit tests use a fake. The eval adds a third role, a judge, and scores cases against two golden files: a committed one on the example bank, and a private one.

**Tech Stack:** TypeScript (strict, nodenext), Nx 24, pnpm, Vitest, Zod 4 (`z.toJSONSchema`), `yaml`, `@xapply/fact-bank`, the `claude` CLI (2.1.322 seen).

**Spec:** `docs/superpowers/specs/2026-11-12-answering-form-questions-design.md`

## Global Constraints

- Every model call is `claude -p`. No OpenRouter, no API key, no model SDK dependencies.
- The child process's env has `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed, so `claude` uses the signed-in subscription. Nothing else is removed, so the sign-in keeps working.
- Each call runs from a fresh empty temporary directory, never the repo. Arguments: `-p --output-format json --json-schema <schema> --system-prompt <ours> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --model <model>`. The prompt goes in on stdin. (These flags were checked live: the result JSON has `structured_output`, `is_error`, `subtype`, `api_error_status`, `total_cost_usd`.)
- One model call at a time. Timeout of 180 s per call. 2 retries on a transient failure, then the question blocks as `model-error`. A sign-in problem or usage limit throws `ModelUnavailableError`.
- Prompts, stdin and stderr of model calls are never logged.
- Error messages and `detail` strings never contain a value: no bank text, no answer, no question label.
- The models come from `apps/runner/.env.local`: `ANSWER_MODEL`, `ANSWER_VERIFY_MODEL`, `ANSWER_JUDGE_MODEL` (each defaults to `opus`) and `ANSWER_MAX_REGENERATIONS` (default `1`).
- Year-only dates count from 1 January of that year. A date with a month counts from the 1st of that month. Whole years are rounded down.
- Block reasons are exactly `bank-silent`, `no-story-fits`, `boundary`, `check-failed`, `verifier-rejected`, `unsupported-field` and `model-error`.
- Derivations are exactly `field`, `as-written`, `fitted`, `math`, `bucket` and `composed`.
- Eval bars: zero hard failures, needless blocks ≤ 10%, and `--repeat n` passes only when every run passes.
- Placeholders are `{source}`, `{company}` and `{jobTitle}`, the `PLACEHOLDERS` list exported by `@xapply/fact-bank`.

## Review Focus

1. **LinkedIn label noise.** A label can carry a trailing `*`, a `?`, a doubled label ("First name First name"), or "(optional)". Field mapping should still map it. The test goes in Task 4.
2. **Option strings that differ only in whitespace or case** from the generator's value (`"Yes "` vs `"Yes"`). The value is accepted, and the result returns the option **exactly as offered**. The test goes in Task 3.
3. **A composed answer that leaves a placeholder unfilled**, or uses a brace that isn't a placeholder. It is blocked by `check-failed`. The test goes in Task 3.
4. **A number field given `"5,000"`, `"5000.00"` or `"5000 USD"`.** Only `^\d+(\.\d+)?$` passes. `"5,000"` blocks rather than being silently changed. The test goes in Task 3.
5. **`claude -p` printing something that isn't JSON** (an update notice, or empty stdout), or exiting non-zero with `is_error: true`. These are retried as transient. A sign-in or usage-limit message throws. The test goes in Task 5.

---

### Task 1: Scaffold `libs/answerer` and its types

**Files:**

- Create: `libs/answerer/` (generated), `libs/answerer/src/types.ts`, `libs/answerer/src/index.ts`
- Modify: `tsconfig.json` (the generator adds the reference), `apps/runner/package.json` (dependency), `apps/runner/tsconfig.app.json` (reference)
- Test: `libs/answerer/src/types.spec.ts`

**Interfaces:**

- Consumes: `FactBank` from `@xapply/fact-bank`.
- Produces (all exported from `index.ts`):

```ts
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
  runDate: string /* YYYY-MM-DD */;
  models: ModelConfig;
  caller: ModelCaller; /* Task 5 */
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
```

- [ ] **Step 1: Generate the library.** Check `pnpm nx g @nx/js:lib --help`, then generate `libs/answerer` with the same options as fact-bank: name `answerer`, import path `@xapply/answerer`, bundler `tsc`, unit test runner `vitest`, linter `eslint`. Copy `libs/fact-bank/eslint.config.mjs` and the `@xapply/source` export condition from `libs/fact-bank/package.json`. Add the dependencies `@xapply/fact-bank: workspace:*`, `zod@^4.6.7` and `yaml@^2.9.0`. Delete the generator's sample source and spec. Add `@xapply/answerer: workspace:*` to `apps/runner/package.json`, and a reference to `../../libs/answerer/tsconfig.lib.json` in `apps/runner/tsconfig.app.json`.
- [ ] **Step 2: Write `types.spec.ts`.** It asserts that `FIELD_TYPES` has exactly the 9 values listed above, and that `CHOICE_TYPES` and `TEXT_TYPES` are subsets of `FIELD_TYPES`.
- [ ] **Step 3: Run it.** `pnpm nx test answerer`. It should FAIL, because `types.ts` doesn't exist yet.
- [ ] **Step 4: Write `types.ts` and `index.ts`** with the interfaces above. `ModelCaller` is a forward import from `./model/caller.js`. Create that file now with just the interface from Task 5, so the code compiles.
- [ ] **Step 5: Run `pnpm nx run-many -t test lint typecheck build -p answerer runner`.** Everything should PASS.
- [ ] **Step 6: Commit** with the message `feat(answerer): scaffold the library and its types`.

### Task 2: Numbers and math

**Files:**

- Create: `libs/answerer/src/math.ts`
- Test: `libs/answerer/src/math.spec.ts`

**Interfaces:**

- Produces:
  - `numbersIn(text: string): number[]`. Every number in the text:
    - digits, with an optional decimal part and thousands commas (`5,000` gives 5000);
    - percentages (`30%` gives 30);
    - the number words `two` through `twenty`, `thirty`, `forty`, `fifty`, `sixty`, `seventy`, `eighty`, `ninety`, `hundred` and `thousand`. `one` and `a` are not counted.
  - `evaluate(expression: string): number`. It parses `+ - * / × ÷`, parentheses and decimal numbers with a recursive-descent parser. It throws `MathError` on anything else. Never `eval` or `Function`.
  - `expressionNumbers(expression: string): number[]`.
  - `yearsSince(spec: { year: number; month?: number }, runDate: string): number`. Whole years from the 1st of `month` (or 1 January) to `runDate`, rounded down. It throws `MathError` if the start is after `runDate`.
  - `MONTHS: Record<string, number>`, month names and three-letter forms, lower case, mapped to 1–12.
  - `class MathError extends Error`.

- [ ] **Step 1: Write the failing tests.**

```ts
expect(numbersIn('5000 USD per month, 30 USD per hour')).toEqual([5000, 30]);
expect(numbersIn('5,000 and 2.5 and 30%')).toEqual([5000, 2.5, 30]);
expect(numbersIn('led two teams for one year')).toEqual([2]);
expect(evaluate('2026 - 2021')).toBe(5);
expect(evaluate('(10 + 2) × 3 ÷ 4')).toBe(9);
expect(() => evaluate('process.exit()')).toThrow(MathError);
expect(() => evaluate('2 ** 3')).toThrow(MathError);
expect(yearsSince({ year: 2021 }, '2026-11-12')).toBe(5); // year only: from 1 January
expect(yearsSince({ year: 2021, month: 12 }, '2026-11-12')).toBe(4); // not yet 5 full years
expect(yearsSince({ year: 2021, month: 11 }, '2026-11-12')).toBe(5);
expect(() => yearsSince({ year: 2027 }, '2026-11-12')).toThrow(MathError);
```

- [ ] **Step 2: Run `pnpm nx test answerer -- math`.** It should FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement `math.ts`.**
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): number extraction and a safe math evaluator`.

### Task 3: Deterministic checks

**Files:**

- Create: `libs/answerer/src/checks.ts`, `libs/answerer/src/sources.ts`, `libs/answerer/src/testing/bank.ts` (a small `FactBank` built by loading `libs/fact-bank/fact-bank.example.yaml`, plus a `job` fixture)
- Test: `libs/answerer/src/checks.spec.ts`

**Interfaces:**

- Consumes: the types from Task 1, and `numbersIn`, `evaluate`, `expressionNumbers`, `yearsSince` and `MONTHS` from Task 2.
- Produces:
  - `sourceText(source: Source, ctx: Pick<AnswerContext,'bank'|'job'|'runDate'>): string | null`. The text a source points to, with placeholders filled. It returns `null` when the source doesn't exist.
  - `fillPlaceholders(text: string, job: Job): string`. Replaces `{source}`, `{company}` and `{jobTitle}`.
  - `matchOption(value: string, options: string[]): string | null`. Trims and compares case-insensitively, and returns the option exactly as offered.
  - `checkCandidate(q: FormQuestion, c: Extract<Candidate,{outcome:'answer'}>, ctx: AnswerContext): { ok: true; value: AnswerValue } | { ok: false; detail: string }`. On success, `value` is normalized: choice values become the offered strings. On failure, `detail` names the check that failed and never a value. The details are `unknown source`, `no source about the author`, `option not offered`, `not as written`, `number not in sources`, `math does not match`, `not a number`, `empty required answer`, `too long`, `unfilled placeholder`, `not the resume` and `math missing`.

The rules are the spec's "Check (deterministic)" list. These are the decisions it leaves open:

- **No source about the author** means every source has `kind` `job-post` or `run-date`.
- **The numbers rule** applies to values of `TEXT_TYPES` and `number`, whatever the derivation. A choice value's numbers come from the form's options, so they're not checked. The allowed numbers are:
  - the `numbersIn` of every cited source's text;
  - the run date's year, month and day;
  - for `math`, the computed result.
- **For `math` with `years-since`:** `year` must appear in a cited source. If `month` is set, its name (from `MONTHS`) must appear in a cited source too. The value must equal `yearsSince(...)`. **For `arithmetic`:** every number in `expressionNumbers` must be allowed, and `Math.floor(evaluate(...))` must equal the value.
- **For `as-written`:** the value equals `fillPlaceholders(source text)` after `trim()`. There must be exactly one `answer` source.
- **Any `{` or `}` left in a text value** fails with `unfilled placeholder`.

- [ ] **Step 1: Write the failing tests**, one `it` per rule, built on the example bank. They must include:

```ts
// Review Focus 2: whitespace and case
expect(
  check(
    q({ type: 'radio', options: ['Yes', 'No'] }),
    ans({
      value: 'yes ',
      derivation: 'fitted',
      sources: [{ kind: 'answer', id: 'sponsorship-future' }],
    }),
  ),
).toEqual({ ok: true, value: 'Yes' });
// Review Focus 3
expect(
  check(
    q({ type: 'textarea' }),
    ans({
      value: 'I want to join {company}',
      derivation: 'composed',
      sources: [{ kind: 'answer', id: 'why-this-role' }],
    }),
  ),
).toEqual({ ok: false, detail: 'unfilled placeholder' });
// Review Focus 4
for (const v of ['5,000', '5000.00x', '5000 USD'])
  expect(
    check(
      q({ type: 'number' }),
      ans({
        value: v,
        derivation: 'fitted',
        sources: [{ kind: 'answer', id: 'salary-expectation-monthly-usd' }],
      }),
    ).ok,
  ).toBe(false);
expect(
  check(
    q({ type: 'number' }),
    ans({
      value: '5000',
      derivation: 'fitted',
      sources: [{ kind: 'answer', id: 'salary-expectation-monthly-usd' }],
    }),
  ).ok,
).toBe(true);
// an added number in composed text
expect(
  check(
    q({ type: 'textarea' }),
    ans({
      value: 'I cut review time by 30%.',
      derivation: 'composed',
      sources: [{ kind: 'answer', id: 'ai-perspective' }],
    }),
  ),
).toEqual({ ok: false, detail: 'number not in sources' });
// the job post alone is not enough
expect(
  check(
    q({ type: 'textarea' }),
    ans({
      value: 'x',
      derivation: 'composed',
      sources: [
        { kind: 'job-post', quote: '<exact substring of fixture description>' },
      ],
    }),
  ).detail,
).toBe('no source about the author');
// details never hold a value
expect(JSON.stringify(failing)).not.toContain('5,000');
```

Also cover:

- each remaining detail string;
- `as-written` with placeholders filled;
- a job-post quote that differs from the description only in whitespace;
- `years-since` and `arithmetic` math, passing and failing;
- `maxLength`;
- an empty required answer;
- a `file` value that isn't `fields.resume`.
- [ ] **Step 2: Run `pnpm nx test answerer -- checks`.** It should FAIL.
- [ ] **Step 3: Implement `sources.ts` and `checks.ts`.**
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): deterministic answer checks`.

### Task 4: Field mapping

**Files:**

- Create: `libs/answerer/src/fields.ts`
- Test: `libs/answerer/src/fields.spec.ts`

**Interfaces:**

- Consumes: the types, `matchOption` (Task 3).
- Produces:
  - `normalizeLabel(label: string): string`. Lower case. Drops `*`, `(optional)`, `(required)` and punctuation. Collapses whitespace. Collapses a label that is the same phrase twice ("first name first name" becomes "first name").
  - `FIELD_PATTERNS: Record<FieldKey, string[]>`. Whole normalized labels.
  - `fieldValue(key: FieldKey, bank: FactBank): string | undefined`.
  - `mapField(q: FormQuestion, bank: FactBank): { kind: 'none' } | { kind: 'filled'; key: FieldKey; value: string } | { kind: 'blocked'; reason: 'bank-silent'; detail: string } | { kind: 'no-option'; detail: string }`.

Starting patterns. The builder may add more, but every pattern must be a whole label:

- `firstName`: first name, given name
- `lastName`: last name, surname, family name
- `fullName`: name, full name
- `email`: email, email address
- `phone`: phone, phone number, mobile, mobile phone number, mobile number
- `phoneCountryCode`: country code, phone country code
- `phoneCountry`: phone country
- `city`: city
- `location`: location, location city, current location
- `country`: country, country of residence
- `linkedin`: linkedin, linkedin profile, linkedin url, linkedin profile url
- `github`: github, github profile, github url
- `portfolio`: portfolio, portfolio url, portfolio website
- `website`: website, personal website
- `resume`: resume, cv, resume cv, upload resume

On a choice type, field mapping finds the option with `matchOption(bankValue)`. For `phoneCountryCode` and `phoneCountry` it also accepts an option that contains both the country name and the code, as in `United Kingdom (+44)`. For `phone` on a choice type it returns `no-option`. `resume` maps only when `q.type === 'file'`, and its value is `fields.resume`. Any other `file` question returns `none`, and the pipeline blocks it.

- [ ] **Step 1: Write the failing tests.**

```ts
expect(mapField(q({ label: 'First name*', type: 'text' }), bank)).toMatchObject(
  { kind: 'filled', key: 'firstName', value: 'Sam' },
);
expect(
  mapField(q({ label: 'First name First name', type: 'text' }), bank),
).toMatchObject({ key: 'firstName' }); // Review Focus 1
expect(
  mapField(q({ label: 'Mobile phone number (optional)', type: 'text' }), bank),
).toMatchObject({ key: 'phone', value: '+447700900123' });
expect(
  mapField(
    q({ label: 'Which city would you like to work in?', type: 'text' }),
    bank,
  ),
).toEqual({ kind: 'none' });
expect(
  mapField(
    q({
      label: 'Phone country code',
      type: 'select',
      options: ['France (+33)', 'United Kingdom (+44)'],
    }),
    bank,
  ),
).toMatchObject({ value: 'United Kingdom (+44)' });
expect(
  mapField(
    q({
      label: 'Email address',
      type: 'select',
      options: ['other@example.com'],
    }),
    bank,
  ),
).toMatchObject({ kind: 'no-option' });
expect(mapField(q({ label: 'Website', type: 'text' }), bank)).toMatchObject({
  kind: 'blocked',
  reason: 'bank-silent',
});
expect(mapField(q({ label: 'Resume', type: 'file' }), bank)).toMatchObject({
  key: 'resume',
});
expect(mapField(q({ label: 'Cover letter', type: 'file' }), bank)).toEqual({
  kind: 'none',
});
```

The example bank has no `website`. Match the phone value to whatever the loader derives as `phone.full`.

- [ ] **Step 2: Run `pnpm nx test answerer -- fields`.** It should FAIL.
- [ ] **Step 3: Implement `fields.ts`.**
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): code-only field mapping`.

### Task 5: `ModelCaller` and the `claude -p` caller

**Files:**

- Create: `libs/answerer/src/model/caller.ts`, `libs/answerer/src/model/claude-cli.ts`, `libs/answerer/src/testing/fake-caller.ts`
- Test: `libs/answerer/src/model/claude-cli.spec.ts`

**Interfaces:**

- Produces:

```ts
// caller.ts
export interface ModelRequest<T> {
  role: Role;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}
export interface ModelResponse<T> {
  value: T;
  stat: CallStat;
}
export interface ModelCaller {
  call<T>(req: ModelRequest<T>): Promise<ModelResponse<T>>;
}
export class ModelCallError extends Error {} // transient, after retries; message holds no prompt text
export class ModelUnavailableError extends Error {} // sign-in or usage limit; stops the run
// claude-cli.ts
export type Spawn = (
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
    timeoutMs: number;
  },
) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;
export function claudeArgs(req: {
  model: string;
  system: string;
  jsonSchema: object;
}): string[];
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function createClaudeCliCaller(opts?: {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  retries?: number;
  timeoutMs?: number;
  binary?: string;
}): ModelCaller;
// fake-caller.ts
export function fakeCaller(
  script: Array<(req: ModelRequest<unknown>) => unknown>,
): ModelCaller & { requests: ModelRequest<unknown>[] };
```

How it works:

- `claudeArgs` builds exactly the argument list in Global Constraints, with the JSON schema from `z.toJSONSchema(req.schema)`.
- `childEnv` copies the env without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- Each call does `mkdtemp` under `os.tmpdir()`, spawns in it, and removes it afterwards.
- It parses stdout as JSON. On success it takes `structured_output` and runs `schema.parse` on it.
- **Throws `ModelUnavailableError`, no retry:** `api_error_status` is 401 or 403, or `result` or stdout matches `/usage limit|rate limit|log ?in|not logged|authenticat|subscription/i`.
- **Transient, retried up to `retries` (default 2) more times, then `ModelCallError`:** a timeout, a non-zero exit, unparsable stdout, `is_error: true`, a missing `structured_output`, or a Zod failure.
- `stat.costUsd` comes from `total_cost_usd`, or `null` when it's missing.
- Never log stdin, stdout or stderr.
- The default `spawn` uses `node:child_process.spawn` with stdio pipes, and kills the child on timeout.

`fakeCaller` takes one function per call, in order. Each returns a value, or throws to simulate a failure. It records every request.

- [ ] **Step 1: Write the failing tests** with a fake `Spawn`:

```ts
expect(claudeArgs({ model: 'opus', system: 'S', jsonSchema: {} })).toEqual([
  '-p',
  '--output-format',
  'json',
  '--json-schema',
  '{}',
  '--system-prompt',
  'S',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--model',
  'opus',
]);
expect(
  childEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', PATH: '/bin' }),
).toEqual({ PATH: '/bin' });
// cwd is a fresh temp dir, not process.cwd(); stdin is the prompt
// success: structured_output parsed, costUsd from total_cost_usd
// Review Focus 5: 'Update available!\n' stdout, then valid JSON -> succeeds on the retry
// three transient failures -> ModelCallError, spawn called 3 times
// api_error_status 401 -> ModelUnavailableError, spawn called once
// result 'Claude usage limit reached' -> ModelUnavailableError
// thrown error messages never contain the prompt text
```

- [ ] **Step 2: Run `pnpm nx test answerer -- claude-cli`.** It should FAIL.
- [ ] **Step 3: Implement `caller.ts`, `claude-cli.ts` and `fake-caller.ts`.**
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Live check.** Run one real call through `createClaudeCliCaller()` from a throwaway script in the session scratchpad, with the schema `z.object({ n: z.number() })` and the prompt "Return 7 as n." It should return `{ n: 7 }` with a cost. Don't commit the script.
- [ ] **Step 6: Commit** with the message `feat(answerer): ModelCaller and the locked-down claude -p caller`.

### Task 6: Prompts and model-output schemas

**Files:**

- Create: `libs/answerer/src/prompts/bank-text.ts`, `libs/answerer/src/prompts/generator.ts`, `libs/answerer/src/prompts/verifier.ts`, `libs/answerer/src/prompts/schemas.ts`
- Test: `libs/answerer/src/prompts/prompts.spec.ts`

**Interfaces:**

- Consumes: the types, `fillPlaceholders`.
- Produces:
  - `renderBank(bank: FactBank): string`. Sections in order: `FIELDS` (key: value), `FACTS` (numbered from 0 as `[fact 3] …`, the same index the eval uses), `KNOWN ANSWERS` (`[answer id] Q: … A: …`, with variants as `[answer id variant 1] when: … A: …`) and `STORIES` (`[story id] title (tags): text`).
  - `renderContext(ctx): string`. The bank, the job post (`title`, `company`, `location`, `description`) and the run date. Each prompt puts this first and the question last, so the shared prefix stays the same within a form.
  - `renderQuestion(q: FormQuestion): string`
  - `GENERATOR_SYSTEM: string`, and `generatorPrompt(q, ctx, feedback: string[]): string`
  - `VERIFY_SYSTEM: string`, and three prompt builders:
    - `blindPrompt(q, ctx)`, which reuses the generator output schema;
    - `fitPrompt(q, ctx, c)`;
    - `claimsPrompt(q, ctx, c)`.
  - `generatorOutput`, a flat Zod object: `outcome`, `reason` (nullable), `value` (string or string array, nullable), `sources`, `derivation` (nullable), `inferences`, and `math` (nullable, `{kind, year?, month?, expression?}`). Sources use `{kind, key?, text?, id?, variant?, quote?}`. Add `toCandidate(o): Candidate`, which validates the combination and throws on a bad one. Flat shapes are used because a JSON schema with unions is less reliable for structured output.
  - `fitOutput`: `{ fits: boolean; why: string }`
  - `claimsOutput`: `{ claims: { claim: string; mark: 'backed'|'inferred'|'unsupported'|'company-not-in-post'; source: string | null }[]; storyDetailAdded: boolean }`

`GENERATOR_SYSTEM` must state these rules from the spec:

- **What counts as backed:** every row of that table.
- **Tone.**
- **Numbers are never adapted.**
- **Year-only math.** Return `math.kind = 'years-since'` with the year and the month as numbers, and let code compute it.
- **Silence is not "No".**
- **Multi-select needs every option backed.**
- **Consent needs a fact.**
- **A boundary returns `cannot-answer` with `boundary`.**
- **Short values are used as written or fitted.**
- **Cite facts by exact sentence.**
- **Never cut an answer short.** Respect `maxLength` by writing shorter.
- **On feedback, fix only what was rejected.** `cannot-answer` is allowed.

`VERIFY_SYSTEM` says it is a judge, not a writer. For a blind prompt it answers on its own from scratch. For a claims prompt it marks every claim about the author or the company.

- [ ] **Step 1: Write the failing tests.**
  - `renderBank(exampleBank)` contains `[fact 0] I am a British citizen.`, `[answer contractor-rate variant 1] when: the form asks for a rate per month`, and `[story missed-launch-date]`.
  - `generatorPrompt` begins with `renderContext(ctx)` and ends with the question.
  - The feedback lines appear when they're given.
  - `blindPrompt` never contains the candidate's value.
  - `toCandidate` turns a flat `cannot-answer` into `{ outcome: 'cannot-answer', reason }`, and throws on `outcome: 'answer'` with a null value.
  - `z.toJSONSchema(generatorOutput)` doesn't throw.
- [ ] **Step 2: Run `pnpm nx test answerer -- prompts`.** It should FAIL.
- [ ] **Step 3: Implement the four files.**
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): prompts and model-output schemas`.

### Task 7: The pipeline, `answerQuestion`

**Files:**

- Create: `libs/answerer/src/answer.ts`, `libs/answerer/src/verify.ts`
- Test: `libs/answerer/src/answer.spec.ts`

**Interfaces:**

- Consumes: everything above.
- Produces:
  - `verifyCandidate(q, ctx, c, value): Promise<{ verdict: 'confirmed' } | { verdict: 'rejected'; feedback: string[] }>`
  - `answerQuestion(q: FormQuestion, ctx: AnswerContext): Promise<AnswerResult>`

**The flow of `answerQuestion`:**

1. If `q.type` isn't in `FIELD_TYPES`, block as `unsupported-field`.
2. Run `mapField`:
   - `filled` returns backed, with derivation `field`, verification `not-needed` and no calls.
   - `blocked` returns blocked as `bank-silent`.
   - `no-option` returns blocked as `check-failed`.
   - `none` with a `file` type blocks as `unsupported-field`.
3. Generate with `ctx.models.answerModel`.
   - A `cannot-answer` result returns blocked with its reason.
4. Run `checkCandidate`. A failure blocks as `check-failed` with no retry.
5. Run `verifyCandidate` with `ctx.models.verifyModel`.
   - `confirmed` returns backed.
   - `rejected` regenerates with the verifier's feedback, up to `maxRegenerations` times, then goes back to step 4.
   - Rejected again blocks as `verifier-rejected`.
6. A `ModelCallError` at any step blocks as `model-error`. A `ModelUnavailableError` is rethrown.
7. Every call's `stat` goes into `calls`.

**Which checks `verifyCandidate` runs, in order. Any one failing rejects:**

- `blind`, when `q.type` is a choice type or `number`. Compare a single choice with `matchOption`, a multi-select as sets, and a number numerically. A `cannot-answer` from the verifier rejects.
- `fit`, when the derivation is `as-written` or `fitted`.
- `claims`, when the derivation is `composed`. It rejects on any `unsupported` or `company-not-in-post` mark, or on `storyDetailAdded`.

The feedback lines name the rejected claims or "the verifier picked a different option". They never include the verifier's pick.

- [ ] **Step 1: Write the failing tests** with `fakeCaller`:
  - an unknown type such as `date` gives `unsupported-field`, with 0 calls;
  - a field label gives `field`, with 0 calls;
  - a cover-letter `file` gives `unsupported-field`;
  - a generator `cannot-answer` with `bank-silent` gives that reason, with 1 call;
  - a check failure gives `check-failed`, with 1 call and no verify call;
  - a blind match on a radio gives backed and `confirmed`, with 2 calls and rounds 1;
  - a blind mismatch, then a regeneration, then a match gives backed, with 4 calls and rounds 2. The second generator prompt contains the feedback, and no request after the first contains the verifier's pick;
  - a mismatch twice gives `verifier-rejected`, with 4 calls when `maxRegenerations` is 1;
  - `composed` with one `unsupported` claim, rejected twice, gives `verifier-rejected`;
  - an `as-written` answer with `fit: false` is rejected;
  - a `ModelCallError` gives `model-error`;
  - a `ModelUnavailableError` rejects the promise;
  - `detail` never contains any bank value. Check this by scanning every block result's `detail` for every string in `renderBank(bank)` longer than 3 characters.
- [ ] **Step 2: Run `pnpm nx test answerer -- answer`.** It should FAIL.
- [ ] **Step 3: Implement `verify.ts` and `answer.ts`.** Export `answerQuestion` from `index.ts`.
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): answerQuestion with generate, check, verify and one regeneration`.

### Task 8: Redaction

**Files:**

- Create: `libs/answerer/src/redact.ts`
- Test: `libs/answerer/src/redact.spec.ts`

**Interfaces:**

- Produces:
  - `RedactedResult`, which has:
    - `questionId`, `required`, `status`, `reason?`, `derivation?`;
    - `sources`: `{ kind; ref?: string | number }[]`, where a fact is its bank index, an answer `id` or `id#variant`, a story `id`, a field `key`, and a job post or run date has no `ref`;
    - `inferenceCount`, `rounds?` and `calls`.
  - `redactResult(r: AnswerResult, bank: FactBank): RedactedResult`

- [ ] **Step 1: Write the failing test.**
  - A backed composed result, with a fact source, a job-post quote and an inference, comes back with the fact as `{ kind: 'fact', ref: 0 }`, the job post as `{ kind: 'job-post' }` and `inferenceCount: 1`.
  - `JSON.stringify` of the redacted result contains neither the value, nor the fact sentence, nor the quote, nor the inference claim.
- [ ] **Step 2: Run `pnpm nx test answerer -- redact`.** It should FAIL.
- [ ] **Step 3: Implement it** and export it from `index.ts`.
- [ ] **Step 4: Run it again.** It should PASS.
- [ ] **Step 5: Commit** with the message `feat(answerer): redacted result for run-reports`.

### Task 9: Golden format, judge, scoring and the example set

**Files:**

- Create:
  - `libs/answerer/src/golden/format.ts`
  - `libs/answerer/src/golden/judge.ts`
  - `libs/answerer/src/golden/score.ts`
  - `libs/answerer/src/golden/run.ts`
  - `libs/answerer/golden/example.yaml`
- Modify: `libs/fact-bank/fact-bank.example.yaml` (add facts), and `libs/fact-bank/src/example.spec.ts` if any count changes.
- Test: `libs/answerer/src/golden/format.spec.ts`, `score.spec.ts`, `run.spec.ts`, and `example-set.spec.ts` (loads `golden/example.yaml` and checks every reference against the example bank).

**Interfaces:**

- Produces:
  - **Format.** `goldenFileSchema` and `GoldenFile = { bank?: string; runDate: string; jobs: Record<string, Job>; cases: GoldenCase[] }`.
    - `GoldenCase = { id; question: FormQuestion /* id defaults to case id */; job?: string /* default 'default' */; expect: Expect }`.
    - `Expect = { status: 'backed'|'blocked'; reason?: BlockReason; value?: string | string[]; valueFrom?: { answer: string } | { field: FieldKey }; sources?: ({ fact: number } | { answer: string } | { story: string } | { field: FieldKey } | { jobPost: true })[]; derivation?: Derivation; mustNotClaim?: string[] }`.
    - Unknown keys are errors.
  - **Loading.** `loadGolden(path: string): GoldenFile` parses with the `yaml` package. It throws `GoldenError` naming the case ids when any `value` is `TODO-author`, when ids are duplicated, or when a case's `job` isn't defined.
  - **Judge.**
    - `judgeAnswer(caller, model, { q, value, ctx, mustNotClaim }): Promise<{ unsupported: string[]; mustNotClaimHits: string[]; stat: CallStat }>`
    - `JUDGE_SYSTEM` says it is grading for invented claims, separately from the answerer and the verifier.
    - It runs only for backed results whose `q.type` is in `TEXT_TYPES`.
  - **Scoring.** `scoreCase(c: GoldenCase, r: AnswerResult, bank: FactBank, judge?: JudgeFinding): CaseScore`, where `CaseScore = { id; pass: boolean; hardFail: boolean; needlessBlock: boolean; problems: string[] }`.
    - `hardFail` means `r` is backed while the expected status is blocked; or a value, `valueFrom` or source doesn't match; or the judge found something.
    - `needlessBlock` means backed was expected and blocked came back.
    - `problems` are value-free strings such as `expected blocked, got backed`, `value mismatch`, `missing source answer:contractor-rate`, `judge: 2 unsupported`.
    - `valueFrom: { answer }` resolves to the answer's text with placeholders filled, and is compared after trimming.
  - **Running.** `runGolden(opts: { file: GoldenFile; bank: FactBank; caller: ModelCaller; models: ModelConfig & { judgeModel: string }; repeat: number; caseId?: string; onCase?: (s: CaseScore, r: AnswerResult) => void }): Promise<EvalReport>`.
    - `EvalReport = { cases: { id; runs: CaseScore[]; pass: boolean; results: AnswerResult[] }[]; totals: { cases; passed; hardFails; needlessBlockRate: number; costUsd: number }; barsHeld: boolean }`.
    - A case passes only if every run passes.
    - `barsHeld = hardFails === 0 && needlessBlockRate <= 0.10`. The rate is needless-block runs divided by the runs expected to be backed.

- [ ] **Step 1: Add facts to the example bank.**
  - `I have used Kubernetes in production since March 2021.`
  - `I have written TypeScript professionally since 2019.`
  - `My notice period is one week.` This replaces "one month", to match the spec's example.
  - `I am comfortable leading code reviews for a team of five engineers.` This one is for a fair-inference case.

  Then run `pnpm nx test fact-bank`. Update counts only if a test pins them.

- [ ] **Step 2: Write `example.yaml`** with `runDate: 2026-11-12`, a `default` job (a made-up "Backend Engineer" at "Acme Payments", with a description of at least 3 short paragraphs that names Kubernetes and code review), and one case per row of the spec's list in "The committed set":
  - **Fields:** every field key; the "city you'd like to work in" label.
  - **Known answers:** as written; fitted to a dropdown; fitted to a number box; the yearly question that must not cite the monthly answer; a variant chosen by `when`; each placeholder.
  - **Text:** an adapted answer; a fair inference; a non-inference (`mustNotClaim`); an added number; a reworded story; two stories combined; a scenario no story fits; "why this company" from the job post plus facts; a company claim not in the post.
  - **Math and choices:** years since March 2021 is 5; years since 2019 is 7; a notice-period bucket; a boundary; Terraform silence; a multi-select with one silent option; a consent box.
  - **Other blocks:** a cover letter; a `date` field type; a short `maxLength`.

  Give every expectation its `sources`. Give text cases `mustNotClaim`.

- [ ] **Step 3: Write the failing tests.**
  - `format.spec`: a `TODO-author` value throws with the case id; an unknown key throws; a missing job throws.
  - `score.spec`: each `hardFail` cause; `needlessBlock`; `valueFrom` with a placeholder; `problems` never contain a value.
  - `run.spec`: uses `fakeCaller` with `repeat: 2`, where one run fails and the case fails; checks the `barsHeld` math.
  - `example-set.spec`: every `fact` index, `answer`, `story` and `field` reference exists in the example bank, and the file loads.
- [ ] **Step 4: Run `pnpm nx test answerer -- golden`.** It should FAIL.
- [ ] **Step 5: Implement the four modules.** Export `loadGolden`, `runGolden` and `type EvalReport` from `index.ts`.
- [ ] **Step 6: Run `pnpm nx test answerer`.** Everything should PASS.
- [ ] **Step 7: Commit** with the message `feat(answerer): golden format, judge, scoring and the example set`.

### Task 10: `runner answers eval`, guard, and docs

**Files:**

- Create: `apps/runner/src/commands/answers.ts`
- Modify:
  - `apps/runner/src/config.ts`
  - `apps/runner/src/main.ts` (dispatch and usage)
  - `apps/runner/package.json` (the `answers-eval` target)
  - `.claude/hooks/guard.mjs` (`RUNNER_SAFE_SUBCOMMANDS`)
  - `.claude/hooks/guard.test.mjs`
  - `CLAUDE.md`
  - `docs/roadmap/README.md`
- Test: `apps/runner/src/commands/answers.spec.ts`, `apps/runner/src/config.spec.ts`

**Interfaces:**

- Consumes: `loadFactBank`, `DEFAULT_FACT_BANK_PATH`, `loadGolden`, `runGolden`, `createClaudeCliCaller`, `redactResult`.
- Produces:
  - `loadAnswerConfig(env?, envFile?): ModelConfig & { judgeModel: string }`. Defaults are `opus`, `opus`, `opus` and `1`. `ANSWER_MAX_REGENERATIONS` must be an integer from 0 to 3, otherwise it throws `ConfigError`.
  - `answersEvalCommand(opts: { set?: 'example'|'private'; answerModel?; verifyModel?; judgeModel?; repeat?: number; caseId?: string; caller?: ModelCaller; log?: (l: string) => void; now?: () => Date }): Promise<number>`

**How the command behaves:**

- **Paths.**
  - `example` uses `libs/answerer/golden/example.yaml` with `libs/fact-bank/fact-bank.example.yaml`.
  - `private` uses `private/answer-golden.yaml` with `DEFAULT_FACT_BANK_PATH`.
- **Output per case.**
  - Example set: `PASS|FAIL id  expected→actual  derivation  sources  rounds  $cost`, followed by the value and the judge's findings.
  - Private set: the same line with ids, kinds and counts only.
- **Totals and exit code.** It prints totals and whether the bars held. It exits 0 if they held, 1 if not.
- **Reports.**
  - JSON report: `run-reports/answers-eval/<ISO time>-<set>.json`. The private set's report uses `redactResult` and has no labels.
  - Private set only: the full results also go to `private/answers-eval/<ISO time>.json`.
- **Errors.** A `ModelUnavailableError` prints its message and returns 1. A `GoldenError` prints the case ids and returns 1.
- **Flags.** `main.ts` parses `--set`, `--answer-model`, `--verify-model`, `--judge-model`, `--repeat` (with the existing `intFlag`) and `--case`, and adds `answers eval` to `USAGE`.
- **Nx target.** `answers-eval` runs `tsx --conditions=@xapply/source src/main.ts answers eval`, in the same shape as `facts-check`.

- [ ] **Step 1: Write the failing tests.**
  - `config.spec`: the defaults; an env override; a bad `ANSWER_MAX_REGENERATIONS` throws.
  - `answers.spec`: a `fakeCaller` and a temporary repo layout via injected paths (add `paths?` to opts for tests). An example run prints a value and writes a report. For a private run, neither stdout nor the `run-reports` file contains any string from the private test bank's values, and the full file goes to the private path. Bars failing returns 1.
  - `guard.test.mjs`: `pnpm nx run runner:answers-eval` and `tsx apps/runner/src/main.ts answers eval --set private` pass the guard.
- [ ] **Step 2: Run `pnpm nx test runner -- answers config` and `pnpm test:hooks`.** Both should FAIL.
- [ ] **Step 3: Implement the command, config, dispatch and target.** Add `'answers'` and `'answers-eval'` to `RUNNER_SAFE_SUBCOMMANDS`.
- [ ] **Step 4: Run them again.** Both should PASS.
- [ ] **Step 5: Update the docs.**
  - **`CLAUDE.md`:**
    - The stack names `libs/answerer`, and "LLMs through OpenRouter" becomes "LLMs through `claude -p` on the author's subscription".
    - The commands list gains `runner:answers-eval`, with its flags and "uses the subscription, never in CI".
    - `RUNNER_SAFE_SUBCOMMANDS` in "Running against LinkedIn" gets the two new names.
    - Add: "Claude may run the example set freely, and the private set only when the author asks."
  - **`docs/roadmap/README.md`:**
    - The "Mirror 10xjobs" line drops OpenRouter and says LLM calls go through `claude -p` _(user)_.
    - Slice 05's "Copy from" becomes "10xjobs's generate-then-verify pattern (`2026-11-07-generate-then-verify-design.md`); no OpenRouter client". Add a "Spec" line linking the slice 05 spec.
    - Slice 05b's extractor is a `claude -p` role.
    - Phase 3's hosted-workers bullet notes that hosted runs need a second `ModelCaller`.
- [ ] **Step 6: Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build && pnpm test:hooks && pnpm format:check`.** Everything should PASS.
- [ ] **Step 7: Commit** with the message `feat(runner): answers eval command, guard and docs`.

### Task 11: Live eval on the example set

**Files:**

- Modify (only as the results require): `libs/answerer/src/prompts/*.ts`, `libs/answerer/golden/example.yaml` (only to fix a case that was itself wrong, never to make a failing answer pass)

- [ ] **Step 1: Run `pnpm nx run runner:answers-eval --outputStyle=stream`.** Read the report in `run-reports/answers-eval/`.
- [ ] **Step 2: Fix the prompts** for every hard failure and every needless block. Re-run the failing cases with `-- --case <id>`. Each prompt fix is its own commit, `fix(answerer): <rule> in the generator prompt`.
- [ ] **Step 3: Run `pnpm nx run runner:answers-eval --outputStyle=stream -- --repeat 3`.** It should print "bars held", exit 0, and have 0 hard failures.
- [ ] **Step 4: Record the cost and time per case** from the report in the PR description.
- [ ] **Step 5: Prepare the private set for the author.**
  - Ask the author to paste their answer ids and question texts.
  - Write `answer-golden.yaml` into the session scratchpad. Use `valueFrom`, ids and `TODO-author` only.
  - Give the author the full path, and tell them to fill in the TODOs, move it to `private/answer-golden.yaml`, and run `pnpm nx run runner:answers-eval -- --set private`. Alternatively they can ask Claude to run it.
- [ ] **Step 6: Hand the branch to the author.** They usually merge locally. If they want a PR instead, push with `git push -u origin slice-05-answering` and run `gh pr create` to `main`, including the results from Step 3.
