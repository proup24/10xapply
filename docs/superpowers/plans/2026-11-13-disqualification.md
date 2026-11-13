# Disqualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `runner apply` run checks the job page and each form round for work-authorization and sponsorship requirements. A job the author can't meet ends with outcome `disqualified` and a quoted, traceable reason, before anything on that step is filled. Location and language requirements are logged only.

**Architecture:** A new library, `libs/disqualify`, holds four parts. The extractor is a `claude -p` role that turns job or form text into quoted **claims**. Code validates every claim against the text it quotes. A pure `decide` function applies the rules file to the claims. A golden eval measures the extractor. The runner's walker calls the extractor at two checkpoints: during the job page's reading wait, and at the start of every read-answer-fill round, before the unknown-field stop. A disqualification ends the run through the existing `RunEnd` path, so slice 06's close-out (Dismiss, then Discard) is unchanged.

**Tech Stack:** Nx 24, pnpm, TypeScript (nodenext, strict), Vitest, zod ^4.6.7, yaml ^2.9.0, `@xapply/answerer` (for `ModelCaller`, `CallStat`, `createClaudeCliCaller`, `Job`).

**Spec:** `docs/superpowers/specs/2026-11-13-disqualification-design.md`

## Global Constraints

- Branch `slice-05b-disqualification` (exists; the spec is its first commit). Never work on `main`.
- **Never name the private folder in a Bash command or a commit message.** The guard blocks it. Source files and docs may contain the string. Tests use temp dirs.
- Claude never reads the author's bank, rules file or full reports. Claude may read `run-reports/`.
- **`libs/disqualify` never imports `@xapply/fact-bank`.** It isn't in its `package.json`, and its ESLint config bans the import with `no-restricted-imports`. The extractor's prompts hold only the job's or the form's own text, never the rules.
- Countries are ISO 3166-1 alpha-2 codes, upper case. Region names (`EU`, `EEA`, `SCHENGEN`) and the alias `UK` (→ `GB`) are expanded by a fixed table in code, never by the model. Matching is case-insensitive.
- A rule-kind claim with `countries: []` means the country is `unclear`. It is logged and never disqualifies.
- An `offers-sponsorship` claim counts only from the job page. An offer with `countries: []` exempts every country for that job _(plan's call: the posting says they sponsor, and the sentence is quoted)_. A `no-sponsorship` claim is never exempted.
- An invalid claim list is asked again **once**. If it's still invalid, or the call fails with `ModelCallError`, the result is the safety stop `check-failed`. `ModelUnavailableError` is not caught, so it surfaces as the walker's existing `error` stop.
- Redacted outputs (`run-reports/`, non-author terminal output) hold claim kinds, country codes, `countryFrom`, sources and call stats. They never hold a quote, a label, a `detail` or description text.
- Only `apps/runner/src/pace/` acts on a page. The ESLint bans stay as they are. No new runtime dependency.
- The extractor's default model is `opus`, overridable by `EXTRACT_MODEL` in the runner's env file or environment.

## Review Focus

1. **The job-page check rejects while `pace.read` is still waiting.** Expect no unhandled rejection, outcome `safety-stop` with kind `check-failed`, and Easy Apply never clicked. Test in Task 7 (`job check failing during the read stops before Easy Apply`).
2. **A follow-up field revealed by a fill** ("If yes, which visa do you hold?") that disqualifies. Expect round 2's check to catch it, nothing in round 2 filled, outcome `disqualified` with source `s<step>-q<n>` of the follow-up. Test in Task 7 (`a follow-up field can disqualify`).
3. **A quote with typographic apostrophes, a non-breaking space or a line break** that differs from the page text only in those. Expect the validator to accept it, not a `check-failed`. Test in Task 4 (`quote matches across typography and line breaks`).
4. **The model writes `UK`, `uk`, `Eu` or `United States`.** Expect `UK`/`uk` → `GB` and `Eu` → the EU list. `United States` is not a code: the claim is invalid and asked again. Tests in Task 2 (`expandCountries aliases and case`) and Task 4 (`country names are invalid`).
5. **Ctrl+C or a bridge stop while a check is in flight.** Expect outcome `stopped`, not `check-failed`, and both reports written. Test in Task 7 (`stop during a check is stopped`).

---

### Task 1: Roadmap, CLAUDE.md and the guard's safe list

**Files:**

- Modify: `docs/roadmap/README.md` (slice 05b: add `- **Spec:** [slice 05b spec](../superpowers/specs/2026-11-13-disqualification-design.md).`)
- Modify: `CLAUDE.md` (Stack: five projects, adding `libs/disqualify`; Commands: `runner:disqualify-eval`; Guardrails: `disqualify.yaml` in the private folder, which Claude may check through `facts-check` but never reads; the `RUNNER_SAFE_SUBCOMMANDS` line)
- Modify: `.claude/hooks/guard.mjs:343-364` (add `'disqualify'`, `'disqualify-eval'`), `.claude/hooks/guard.test.mjs`

**Interfaces:** Produces the Nx target name `runner:disqualify-eval` used in Task 8.

- [ ] **Step 1: Failing guard tests.** `pnpm nx run runner:disqualify-eval` is allowed. `pnpm nx run runner:disqualify-eval -- --repeat 3 --model sonnet` is allowed.
- [ ] **Step 2:** Run `pnpm test:hooks`. Expect the two new cases to fail.
- [ ] **Step 3:** Add both names to `RUNNER_SAFE_SUBCOMMANDS` and update the roadmap and `CLAUDE.md` as listed. The `CLAUDE.md` command line reads: "`pnpm nx run runner:disqualify-eval [-- --model m --repeat n --case id]` runs the disqualification extractor's golden eval on the committed example set. It uses the subscription, never in CI, and never touches LinkedIn."
- [ ] **Step 4:** Run `pnpm test:hooks`. Expect all to pass.
- [ ] **Step 5:** Commit `chore(harness): slice 05b docs and guard safe list`.

### Task 2: `libs/disqualify` scaffold, claim types and countries

**Files:**

- Create: `libs/disqualify/{package.json,tsconfig.json,tsconfig.lib.json,tsconfig.spec.json,eslint.config.mjs,vitest.config.mts}`, mirroring `libs/answerer` (package `@xapply/disqualify`, Nx name `disqualify`, dependencies `@xapply/answerer`, `yaml`, `zod`; `tsconfig.lib.json` references `../answerer/tsconfig.lib.json`)
- Create: `libs/disqualify/src/index.ts`, `src/types.ts`, `src/countries.ts`, `src/countries.spec.ts`, `src/testing/fake-caller.ts`
- Modify: `tsconfig.json` (root references), `libs/answerer/src/types.ts:99` (`Role` gains `'extract'`), `apps/runner/package.json` (dependency `@xapply/disqualify: workspace:*`), `apps/runner/tsconfig.app.json` and `tsconfig.spec.json` references

**Interfaces:**

- Produces (`src/types.ts`):

```ts
export const RULE_KINDS = [
  'offers-sponsorship',
  'requires-authorization',
  'no-sponsorship',
  'asks-authorization',
  'asks-sponsorship',
] as const;
export const LOG_KINDS = [
  'location-requirement',
  'language-requirement',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type ClaimKind = RuleKind | (typeof LOG_KINDS)[number];
/** 'job-page', or a form question's id (`s2-q3`, `s2-u1` for an unknown field). */
export type ClaimSource = string;
export interface Claim {
  kind: ClaimKind;
  /** Codes or region names as the model gave them; [] = unclear (rule kinds) or none (language). */
  countries: string[];
  countryFrom: 'text' | 'job-description';
  /** Verbatim from the source's text. */
  quote: string;
  /** countryFrom 'job-description': the title or description text naming the place. */
  placeQuote: string | null;
  source: ClaimSource;
  /** Language claims: the language. Location claims: the place as written. Else null. */
  detail: string | null;
}
export interface CheckJob {
  title: string;
  company: string;
  description: string;
}
export interface CheckQuestion {
  id: string;
  label: string;
  type?: string;
  options?: string[];
  helpText?: string;
  stepTitle?: string;
}
```

- Produces (`src/countries.ts`): `ISO_CODES: ReadonlySet<string>` (all 249 alpha-2 codes); `REGIONS: Record<string, readonly string[]>` with `EU` (AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE), `EEA` (EU + IS LI NO), `SCHENGEN` (EU minus CY IE, plus IS LI NO CH), `UK` (GB); `isCountryToken(t: string): boolean`; `expandCountries(tokens: string[]): Set<string>` (upper-cases, expands regions, keeps codes; throws on an invalid token).
- Produces (`src/testing/fake-caller.ts`): `fakeCaller(script)` with the same shape as `libs/answerer/src/testing/fake-caller.ts` (copy it; that file isn't exported).

- [ ] **Step 1: Failing tests** in `countries.spec.ts`:
  - `expandCountries(['US'])` → `{US}`; `expandCountries(['us','Ca'])` → `{US, CA}`.
  - `expandCountries aliases and case`: `['UK']` and `['uk']` → `{GB}`; `['Eu']` has 27 codes and includes `DE`, not `GB`.
  - `expandCountries(['EEA'])` has 30 codes and includes `NO`; `['SCHENGEN']` includes `CH` and not `IE`.
  - `isCountryToken('United States')` is false; `isCountryToken('MA')` is true; `isCountryToken('XX')` is false.
- [ ] **Step 2:** Run `pnpm nx test disqualify`. Expect failures (module missing).
- [ ] **Step 3:** Create the scaffold and `countries.ts`. Add the ESLint rule `no-restricted-imports` banning `@xapply/fact-bank` in `libs/disqualify/eslint.config.mjs`. Add `'extract'` to `Role`.
- [ ] **Step 4:** Run `pnpm nx run-many -t test lint typecheck -p disqualify answerer runner`. Expect pass.
- [ ] **Step 5:** Commit `feat(disqualify): scaffold the library with claim types and countries`.

### Task 3: The rules file

**Files:**

- Create: `libs/disqualify/src/rules.ts`, `src/rules.spec.ts`, `src/paths.ts`, `libs/disqualify/disqualify.example.yaml`

**Interfaces:**

- Produces: `DEFAULT_RULES_PATH` (`<repo>/private/disqualify.yaml`, computed like `libs/fact-bank/src/paths.ts`); `interface Rules { authorizedCountries: string[] }` (upper-case ISO codes, at least one, no regions); `class RulesError extends Error { problems: string[] }`; `checkRules(path?: string): { ok: boolean; path: string; counts: { authorizedCountries: number }; problems: string[]; rules?: Rules }`; `loadRules(path?: string): Rules` (throws `RulesError`).
- The schema is a strict zod object, so an unknown key is a problem. Problem messages name keys and positions, never a value.

- [ ] **Step 1: Failing tests:** the example file loads with `authorizedCountries: ['MA']`. Lower-case `ma` loads as `MA`. A missing file gives `ok: false` with one problem and no throw from `checkRules`. `[]`, `['EU']`, `['XX']` and an unknown key each give a problem whose text does not contain the bad value. `loadRules` on a bad file throws `RulesError`.
- [ ] **Step 2:** Run `pnpm nx test disqualify`. Expect failures.
- [ ] **Step 3:** Implement. The example file has a comment saying it's made up, and `authorizedCountries: [MA]`.
- [ ] **Step 4:** Run the tests. Expect pass.
- [ ] **Step 5:** Commit `feat(disqualify): rules file schema, loader and example`.

### Task 4: Claim validation and the decision

**Files:**

- Create: `libs/disqualify/src/validate.ts`, `src/validate.spec.ts`, `src/decide.ts`, `src/decide.spec.ts`

**Interfaces:**

- Produces: `normalizeText(s: string): string` (lower case; `‘ ’ ′` → `'`, `“ ” ″` → `"`, `– — −` → `-`, U+00A0 and every whitespace run → one space; trimmed).
- Produces: `validateClaims(claims: Claim[], ctx: { sources: Map<ClaimSource, string>; place: string }): string[]`. `sources` maps each source to its text: for `job-page`, the title and description; for a question, its label, help text and options joined with `\n`. `place` is the job's title and description. It returns problems in our own words, naming the claim index and field, never quoting. Rules:
  - the source is a key of `sources`;
  - `normalizeText(quote)` is a substring of `normalizeText(sources.get(source))`;
  - every country token passes `isCountryToken`;
  - `countryFrom: 'job-description'` requires `placeQuote` found in `place`;
  - `offers-sponsorship` only from `job-page`;
  - `asks-authorization` and `asks-sponsorship` only from a question;
  - log kinds need a non-empty `detail`.
- Produces: `type Verdict = { kind: 'pass' } | { kind: 'disqualified'; reasons: Claim[] }` and `decide(claims: Claim[], rules: Rules, offers: Claim[]): Verdict`. The algorithm, per rule-kind claim other than `offers-sponsorship`:

```text
if countries is [] → skip (unclear)
codes = expandCountries(countries)
if codes ∩ rules.authorizedCountries ≠ ∅ → pass
if kind = no-sponsorship → disqualify
exempt = any offer with countries [] , or codes ∩ expand(offer.countries) ≠ ∅
if not exempt → disqualify
```

The reasons keep the claims' order; the first is the headline. Log kinds never affect the verdict.

- [ ] **Step 1: Failing tests** in `validate.spec.ts`: a valid claim gives `[]`; `quote matches across typography and line breaks` (page `We can’t\nsponsor visas`, quote `we can't sponsor visas`); quote not in source; unknown source; `country names are invalid` (`['United States']`); `job-description` without `placeQuote`; an offer from a question; `asks-sponsorship` from `job-page`; a language claim without `detail`. No problem string contains the quote.
- [ ] **Step 2: Failing tests** in `decide.spec.ts`, rules `{ authorizedCountries: ['MA'] }`, one test per spec table row and case:
  - `requires-authorization` `['US']` → disqualified; `['MA']` → pass; `['US']` with offer `['US']` → pass; with offer `[]` → pass.
  - `no-sponsorship` `['US']` with offer `['US']` → disqualified.
  - `asks-authorization` `['GB']` → disqualified; `asks-sponsorship` `['DE']` with offer `['EU']` → pass.
  - `['US','CA']` with offer `['CA']` → pass; `['US','MA']` → pass.
  - `['EU']` → disqualified.
  - `[]` → pass (unclear).
  - Location and language claims alone → pass.
  - Two disqualifying claims → both in `reasons`, in order.
- [ ] **Step 3:** Run `pnpm nx test disqualify`. Expect failures.
- [ ] **Step 4:** Implement both.
- [ ] **Step 5:** Run the tests. Expect pass.
- [ ] **Step 6:** Commit `feat(disqualify): validate claims and decide`.

### Task 5: The extractor

**Files:**

- Create: `libs/disqualify/src/extract.ts`, `src/extract.spec.ts`, `src/prompts.ts`, `src/prompts.spec.ts`

**Interfaces:**

- Consumes: `ModelCaller`, `ModelCallError`, `CallStat` from `@xapply/answerer`; `validateClaims` (Task 4).
- Produces:

```ts
export interface ExtractContext { caller: ModelCaller; model: string }
export interface ExtractResult { claims: Claim[]; calls: CallStat[] }
export class CheckFailedError extends Error {
  constructor(readonly why: 'invalid-claims' | 'model-error', readonly calls: CallStat[]);
}
export function extractFromJob(job: CheckJob, ctx: ExtractContext): Promise<ExtractResult>;
export function extractFromQuestions(
  questions: CheckQuestion[], job: CheckJob, ctx: ExtractContext,
): Promise<ExtractResult>;
```

- The model's output schema (`prompts.ts`): `{ claims: Array<{ kind, countries: string[], countryFrom, quote, placeQuote: string | null, source: string, detail: string | null }> }`, with `kind` and `countryFrom` as zod enums. Every request has `role: 'extract'`.
- The system prompt (builder writes it) explains the seven kinds with examples, says to quote verbatim, to use ISO alpha-2 codes or `EU`/`EEA`/`SCHENGEN`, to use `countries: []` when no country can be told, that "select the countries you can work in" is not a requirement, and that an empty list is a valid answer. The user prompt holds the job (and for questions, each question's id, label, type, options, help text and step title), and nothing else.
- On validation problems, the second request repeats the prompt plus the problem list. Calls from both attempts go into `calls` (and into `CheckFailedError.calls`).

- [ ] **Step 1: Failing tests** in `prompts.spec.ts`: the job prompt contains the description and title. The questions prompt contains each id and label. Neither contains the words `authorizedCountries` or `fact`.
- [ ] **Step 2: Failing tests** in `extract.spec.ts` with `fakeCaller`: a valid response returns its claims and one call stat with role `extract`. An invalid then valid response returns the second's claims and two stats, and the second request's prompt names the problem. Invalid twice → `CheckFailedError('invalid-claims')` with two stats. `ModelCallError` → `CheckFailedError('model-error')`. `ModelUnavailableError` propagates unchanged.
- [ ] **Step 3:** Run `pnpm nx test disqualify`. Expect failures.
- [ ] **Step 4:** Implement. Export the public surface from `src/index.ts`: types, countries, rules, `validateClaims`, `decide`, the extractor and `CheckFailedError`.
- [ ] **Step 5:** Run `pnpm nx run-many -t test lint typecheck -p disqualify`. Expect pass.
- [ ] **Step 6:** Commit `feat(disqualify): the extract role`.

### Task 6: The golden set and the eval runner

**Files:**

- Create: `libs/disqualify/golden/example.yaml`, `libs/disqualify/src/golden/{format.ts,format.spec.ts,run.ts,run.spec.ts,example-set.spec.ts}`

**Interfaces:**

- Produces (`format.ts`): `loadDisqualifyGolden(path: string): DisqualifyGolden` and `class GoldenError`.

```ts
interface DisqualifyGolden {
  rules: Rules;
  defaultJob: CheckJob;
  cases: DisqCase[];
}
interface DisqCase {
  id: string;
  group:
    | 'authorization'
    | 'sponsorship'
    | 'job-page'
    | 'near-miss'
    | 'location'
    | 'language';
  job?: CheckJob; // defaults to defaultJob
  checkJob: boolean; // run the job-page check (default: true when `job` is given)
  questions?: Array<Omit<CheckQuestion, 'id'>>; // ids assigned s1-q1, s1-q2, …
  expect: {
    verdict: 'pass' | 'disqualified';
    claims: Array<{ kind: RuleKind; countries: string[] }>;
  };
}
```

- Produces (`run.ts`): `runDisqualifyGolden(opts: { golden: DisqualifyGolden; ctx: ExtractContext; repeat: number; caseId?: string }): Promise<DisqEvalReport>`. Per case and repeat, it runs the job check (when `checkJob`), then the questions check, then `decide(all claims, rules, job-page offers)`. A run **passes** when the verdict matches and every expected claim has a returned claim of the same kind whose expanded countries equal the expected ones. A `CheckFailedError` fails the run. `DisqEvalReport` has, per case, `{ id, group, runs: Array<{ pass: boolean; verdict: string; claims: Claim[]; calls: CallStat[]; error?: string }> }`, plus `{ passed: boolean; cost: number }`. `passed` means every run of every case passed (the spec's bar, checked with `--repeat 3`).
- The golden set (Claude writes it; job-description sentences are made up for now, as the spec says) has at least:
  - **authorization:** 10 cases. US, GB written as UK, CA, DE as "right to work in Germany", the EU, "US or Canada", the job's country from the description (`countryFrom: job-description`), a single-choice status question (Citizen / Green card / Require sponsorship), "legally eligible", "work permit".
  - **sponsorship:** 8 cases. "now or in the future", "visa support", "H-1B", "employer sponsorship", in several countries.
  - **job-page:** 8 cases. "unable to sponsor", "must already have the right to work in", "we sponsor visas" plus a form sponsorship question (pass), the contradiction (both sentences: disqualified), a no-country offer plus a GB question (pass).
  - **near-miss:** 8 cases, all `pass`. Authorized in Morocco, "select the countries you can work in", "the country you live in" on a remote job (unclear), relocation willingness, a driving licence, a remote-worldwide description, a degree question, a plain years-of-experience Yes/No.
  - **location:** 3 cases and **language:** 3 cases, all `pass` with no rule-kind claims expected.
  - Form-question wordings start from the labels in `apps/runner/src/apply/fixtures/` and `snapshots/`.

- [ ] **Step 1: Failing tests** in `format.spec.ts`: the loader rejects a duplicate id, an unknown group, a bad country and a case with neither `job` nor `questions`. `example-set.spec.ts`: the committed set loads, has the minimum count per group above, and every near-miss, location and language case expects `pass`.
- [ ] **Step 2: Failing tests** in `run.spec.ts` with `fakeCaller`: a matching case passes. A wrong country fails. An extra rule claim that doesn't change the verdict still passes. An offer from the job check exempts a question claim. `CheckFailedError` fails the run. `passed` is false if one of three repeats fails.
- [ ] **Step 3:** Run `pnpm nx test disqualify`. Expect failures.
- [ ] **Step 4:** Implement the loader, the runner and the golden set.
- [ ] **Step 5:** Run the tests. Expect pass.
- [ ] **Step 6:** Commit `feat(disqualify): golden set and eval runner`.

### Task 7: The walker's two checkpoints

**Files:**

- Modify: `apps/runner/src/apply/types.ts` (outcome, safety stop, deps, run fields), `apps/runner/src/apply/run.ts` (`openJob`), `apps/runner/src/apply/step.ts` (`Walk`, `walkStep`, `answerField` takes a pre-assigned id), `apps/runner/src/apply/stop.ts` (map `CheckFailedError`), `apps/runner/src/linkedin/types.ts` and `src/linkedin/form-step.ts` (`UnknownField.label`)
- Create: `apps/runner/src/apply/check.ts` (the checkpoint helpers)
- Test: `apps/runner/src/apply/run.spec.ts`, `apps/runner/src/linkedin/form-step.spec.ts` (or the existing reader spec)

**Interfaces:**

- Consumes: `Claim`, `CheckJob`, `CheckQuestion`, `ExtractResult`, `CheckFailedError`, `Rules`, `decide` from `@xapply/disqualify`.
- Produces in `types.ts`:
  - `ApplyOutcome` gains `'disqualified'`; `SafetyStop` gains `'check-failed'`.
  - `ApplyDeps` gains `checkJob(job: CheckJob): Promise<ExtractResult>`, `checkQuestions(qs: CheckQuestion[], job: CheckJob): Promise<ExtractResult>` and `rules: Rules`.
  - `ApplyRun` gains `checks: CheckRecord[]` and `disqualification: Claim[] | null`, where `interface CheckRecord { at: 'job-page' | 'step'; step: number | null; claims: Claim[]; calls: CallStat[] }`. The check's calls are recorded even when it fails.
  - `UnknownField` gains `label: string | null`: the cleaned text of `label[for=<id>]`, else the enclosing fieldset's legend, else null.
- `Walk` gains `offers: Claim[]` (the job page's `offers-sponsorship` claims).
- **Job page:** in `openJob`, after `run.job` is set, start `checkJob` before `pace.read`, attaching a no-op `catch` so an early rejection isn't unhandled. Await it just before the Easy Apply click, record it, and set `offers`. If `decide` returns disqualified, set `run.disqualification` and `throw new RunEnd('disqualified')`.
- **Each round:** at the top of `walkStep`'s round loop, before the `unknown` check, assign ids to the fresh fields (`s<step>-q<n>`, continuing the step's numbering) and to the fresh unknowns that have a label (`s<step>-u<k>`). If there are any, await `checkQuestions`, record it, and `decide(claims, rules, w.offers)`. If disqualified, end the same way. The answerer is never called for that round.
- `checkStop(deps)` runs right after each awaited check, so a stop during a check ends as `stopped`. `asRunEnd` maps `CheckFailedError` to `safety('check-failed', 'the requirements check did not give a valid answer')`.

- [ ] **Step 1: Failing reader test:** an unknown field with a `label[for]` reads its label; one without reads `null`.
- [ ] **Step 2: Failing walker tests** in `run.spec.ts`, with fake `checkJob`/`checkQuestions`:
  - `disqualifying job page never opens the form`: outcome `disqualified`, Easy Apply never clicked, `checks[0].at === 'job-page'`.
  - `the job check runs during the read`: `checkJob` is called before `pace.read` resolves.
  - `job check failing during the read stops before Easy Apply`: `checkJob` rejects with `CheckFailedError` while `read` is pending → `safety-stop`/`check-failed`, no click, no unhandled rejection (Vitest's unhandled-rejection failure stays on).
  - `disqualifying round fills nothing`: step 1's check returns `asks-sponsorship ['US']` from `s1-q2` → `answer` never called for step 1, no pace input on step 1's fields, outcome `disqualified`, `disqualification[0].source === 's1-q2'`, the close-out discards.
  - `a follow-up field can disqualify`: round 1 passes and fills; round 2's fresh field disqualifies → round 2 unfilled, outcome `disqualified`.
  - `an offer on the job page exempts a form question`: job check gives `offers-sponsorship ['DE']`, step check gives `asks-sponsorship ['DE']` → the walk reaches review.
  - `disqualification wins over an unknown field`: a step with an unknown field labelled for sponsorship → outcome `disqualified`, not `unknown-field`, and `checkQuestions` received `s1-u1`.
  - `an unclear claim does not disqualify`: `asks-authorization []` → reaches review.
  - `stop during a check is stopped`: `stopReason()` becomes non-null while `checkQuestions` is pending → outcome `stopped`.
  - `no fresh fields, no check`: a review page with no fields makes no `checkQuestions` call.
- [ ] **Step 3:** Run `pnpm nx test runner`. Expect the new tests to fail.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `pnpm nx run-many -t test lint typecheck -p runner`. Expect pass, with the existing walker tests unchanged apart from their deps gaining a pass-through check (`claims: []`).
- [ ] **Step 6:** Commit `feat(runner): check the job page and each round for disqualifying requirements`.

### Task 8: Reports

**Files:**

- Modify: `apps/runner/src/apply/report.ts`, `apps/runner/src/apply/report.spec.ts`

**Interfaces:**

- `RedactedApplyRun` gains `checks: Array<{ at; step; claims: Array<{ kind; countries; countryFrom; source }>; calls: CallStat[] }>` and `disqualification: Array<{ kind; countries; countryFrom; source }> | null`. `unknownFields` stays `{tag, role, inputType}` (no label).
- `formatRedactedSummary` adds, when disqualified, `disqualified: <kind> <countries joined by ','|unclear> at <source>` for the headline, plus `(+N more)` when there are several.
- `formatRunMarkdown` adds a `## Requirements` section after the outcome. It has one table row per claim: where, kind, countries (or `unclear`), country from, quote, place quote, detail. Then a `Verdict:` line, either `pass` or `disqualified: <kind> <countries> at <source>`. With no claims, the section reads `No requirements found.`

- [ ] **Step 1: Failing tests:**
  - The redacted copy of a disqualified run has the kinds, codes and sources, and contains no quote, `detail` or description substring.
  - An unknown field's label is absent from the redacted JSON.
  - The summary line is exactly `disqualified: asks-sponsorship US at s2-q1`.
  - The markdown holds the quote and the `Verdict:` line.
  - A run with no claims reads `No requirements found.`
- [ ] **Step 2:** Run `pnpm nx test runner`. Expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect pass.
- [ ] **Step 5:** Commit `feat(runner): requirements in the run reports`.

### Task 9: Commands: `apply`, `facts check` and `disqualify eval`

**Files:**

- Modify: `apps/runner/src/config.ts` (`AnswerConfig.extractModel` from `EXTRACT_MODEL`, default `opus`), `apps/runner/src/commands/apply.ts`, `apps/runner/src/commands/facts.ts`, `apps/runner/src/main.ts` (usage and dispatch), `apps/runner/package.json` (Nx target `disqualify-eval`: `tsx --conditions=@xapply/source src/main.ts disqualify eval`)
- Create: `apps/runner/src/commands/disqualify.ts`
- Test: `apps/runner/src/commands/{apply,facts,disqualify}.spec.ts`, `config.spec.ts`

**Interfaces:**

- `ApplyCommandDeps` gains `rulesPath: string` and `loadRules: (path: string) => Rules`. The rules load right after the bank. On a `RulesError`, it prints `apply: the disqualify rules did not load; fix them first` and each problem, then returns 2 before connecting. `runApply` gets `rules`, plus `checkJob`/`checkQuestions` built from `extractFromJob`/`extractFromQuestions` with `{ caller, model: answerCfg.extractModel }`. `disqualified` exits 2.
- `factsCheckCommand` opts gain `rulesPath?: string`. After the bank, it prints `rules: <path>` and `authorized countries <n>` and any problems, never a code. It exits 1 if either file fails.
- `disqualifyEvalCommand(opts: { model?: string; repeat?: number; caseId?: string; caller?: ModelCaller; log?; now?; root? }): Promise<number>`. It loads `libs/disqualify/golden/example.yaml`. It prints one line per case (`id group pass|FAIL verdict`), then totals and cost. It writes the report JSON to `run-reports/disqualify-eval/<stamp>.json`. It exits 0 when `passed`, else 1. Flags: `--model`, `--repeat`, `--case`, parsed with `main.ts`'s existing `stringFlag`/`intFlag`.

- [ ] **Step 1: Failing tests:**
  - `apply` with a bad rules file prints the line and returns 2 without calling `connect`.
  - `apply` passes `rules` and both check functions to `runApply`.
  - `facts check` with a bad rules file exits 1 and prints no code.
  - `EXTRACT_MODEL=sonnet` sets `extractModel`, and the default is `opus`.
  - `disqualifyEvalCommand` with a fake caller and a two-case golden in a temp root writes the report and returns 0 when both pass, 1 when one fails.
  - `main(['disqualify','eval','--repeat','2'])` dispatches with `repeat: 2`.
- [ ] **Step 2:** Run `pnpm nx test runner`. Expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build`. Expect pass.
- [ ] **Step 5:** Commit `feat(runner): wire disqualification into apply, facts check and an eval command`.

### Task 10: Live eval, the author's dry runs, and the PR

**Files:** possibly `libs/disqualify/src/prompts.ts` and `golden/example.yaml` (prompt fixes only; a golden case is changed only if it was wrong, with the reason in the commit message).

- [ ] **Step 1:** Run `pnpm nx run runner:disqualify-eval -- --repeat 3`. Claude may run this freely: it's the example set and never touches LinkedIn. Expect `passed`. On a failure, fix the prompt and re-run. Record cost and per-call latency for the PR.
- [ ] **Step 2: Author checkpoint.** Ask the author to create `disqualify.yaml` in the private folder from `libs/disqualify/disqualify.example.yaml`. Then run `pnpm nx run runner:facts-check` and expect `authorized countries 1`.
- [ ] **Step 3: Author checkpoint.** The author picks three real jobs: one that should disqualify from the job page, one from a form question, and one that shouldn't. The author runs `pnpm nx run runner:apply -- '<url>' --dry-run` on each, or asks Claude to in that session. Expect the first to end `disqualified` at `job-page` without the form opening. Expect the second to end `disqualified` at `s<n>-q<m>` with that step unfilled. Expect the third to reach review. The author confirms the quoted reasons in the full reports. Claude reads only `run-reports/`.
- [ ] **Step 4:** Update the memory notes and `CLAUDE.md` if anything changed. Then run `pnpm format:check`, push with `git push -u origin slice-05b-disqualification`, and open the PR to `main` with `gh pr create`. The PR body gives the eval numbers and the three dry runs' outcomes (ids and kinds only).
