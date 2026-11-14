# Slice 07b: Fill more of the form, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runner reads and fills every ordinary Easy Apply field type, every bank miss is recorded as an eval case for slice 07c, and Claude may read `private/` and edit the bank.

**Architecture:**

- The guard's private-folder rule narrows to a single write block on `applications.json`.
- Misses are derived from a finished run's `questions` and appended to `private/answer-misses.yaml`, a file with its own schema. It is converted to a `GoldenFile` in memory for `answers-eval --set misses`.
- `date` becomes a field type. It has a `date-offset` math kind in the answerer, and a reader and a filler in the runner, both built from scrubbed snapshot fixtures.

**Tech Stack:** TypeScript (nodenext, strict), Vitest, Zod, YAML, Patchright through the bridge, `node:test` for the guard.

**Spec:** [docs/superpowers/specs/2026-11-14-fill-more-of-the-form-design.md](../specs/2026-11-14-fill-more-of-the-form-design.md)

## Linear ticket

None. The author has not asked for tickets on this spec.

## Global Constraints

- An answer the bank can't back is asked or stops the run, never guessed. That includes dates.
- Only the pace module acts on a page. No `evaluate`-family calls. Uploads go through the relay.
- Nothing under `private/` is ever committed. Fixtures are scrubbed and pass the leak check (Task 7) before they're committed.
- `applications.json` is never written by Claude. `.env*` (except `.env.example`) stays blocked.
- Claude starts `runner:apply` only with `--dry-run`, only when the author asks in that session, and a few a day. A re-run after a chat answer counts toward that.
- Outside author mode, terminal output stays redacted. The misses set and the private set print only ids and counts.
- Model calls go through `claude -p`, never in CI.
- The working tree has the author's own uncommitted `"idleCompaction": false` line in `.claude/settings.json`. Never commit it. Stage only your own hunks, for example by writing a patch of just them and running `git apply --cached`.

## Review Focus

1. **Bash commands that name `applications.json` through a pipe, `tee`, `sed -i`, `cp`/`mv` onto it, or a nested `bash -c`.** These must be blocked, while `cat`/`jq`/`head` reads pass. Task 1 tests each.
2. **A miss in a run that ended by `error` or a bridge stop.** Misses are still written for every question already recorded, and a failure to write misses never changes the run's exit code or skips the reports. Task 5 tests both.
3. **Several runs of the same job.** A re-run must not duplicate a miss that already has an author answer from chat. Entries are keyed by `jobId` + normalized label + type, and a later run updates `lastSeenAt` instead of appending. Task 4 tests this.
4. **A date in a format the reader didn't expect, or a field that re-renders after typing.** The value is read back and compared as a date, not as text. A mismatch is `unverified` and goes through the existing fill-problem path, never a silent pass. Task 8 tests this.
5. **The leak check on a phone number written with other separators** (`+447700900123`, `07700 900123`, `(0)7700-900-123`). It is caught by comparing digits only. Task 7 tests this.

---

## PR 1: Guard and docs

### Task 1: Guard lets Claude read and write `private/`, except `applications.json`, and fix the runner false positives

**Files:**

- Modify: `.claude/hooks/guard.mjs` (the `isPrivate`/`pathHit`/`globHit`/`bashHit` helpers, `evaluate`, `runnerPath`, `fileLaunch`)
- Modify: `.claude/hooks/guard.test.mjs` (the tests `private data`, `bash: secrets and private`, `bash: separators attached to tokens`, plus new tests)
- Modify: `.claude/settings.json` (the `deny` list only)

**Interfaces:**

- Produces: `export const PROTECTED_RECORD = 'applications.json'` and `export const READ_ONLY_TOOLS = ['cat', 'head', 'tail', 'less', 'jq', 'grep', 'rg', 'ugrep', 'wc', 'diff', 'ls', 'stat', 'file', 'sha256sum']`.

- [ ] **Step 1: Rewrite the failing tests**

In `private data`:

- Read, Grep and Glob on `private/...` return `false`.
- `Edit`, `Write` and `NotebookEdit` on `/repo/private/applications.json` and `/repo/private/applications.json.tmp` return `true`.
- `Write` on `/repo/private/fact-bank.yaml` returns `false`.

In `bash: secrets and private`:

- These commands are allowed: `grep -r token ./private/`, `cat private/applications.json`, `jq .jobs private/applications.json`, `pnpm nx run runner:answers-eval -- --set private`.
- These are blocked: `echo x > private/applications.json`, `cat a | tee private/applications.json`, `sed -i s/a/b/ private/applications.json`, `cp x private/applications.json`, `mv x private/applications.json`, `rm private/applications.json`, `bash -c "echo > private/applications.json"`, `python -c "open('private/applications.json','w')"`.
- `.env` cases are unchanged.

In `bash: separators attached to tokens`, `cat private/x;ls` and `sh -c 'ls private/'` move to the allowed list.

New test `bash: runner false positives`:

- These are not blocked: `ls apps/runner/src`, `for f in run-reports/*.json; do node -e 'console.log(1)' $f; done` (with `apps/runner` elsewhere in the same command), `cat pace-recordings/runner/x.json`, `node scripts/x.mjs pace-recordings/runner/a.json`.
- These are still blocked: `node apps/runner/dist/main.js apply https://x`, `node dist/apps/runner/main.js apply https://x`, `node -e "require('./apps/runner/dist/main.js')" apply x`.

- [ ] **Step 2: Run them and see them fail**

Run `pnpm test:hooks`. Expected: FAIL on the rewritten assertions.

- [ ] **Step 3: Implement**

Private data:

- Drop `isPrivate` from `pathHit`, `globHit` and `bashHit`, so only secrets match.
- For `Edit`, `Write` and `NotebookEdit`, block a path whose basename starts with `applications.json` and that has a `private` segment.
- In Bash, add `recordWriteProblem(command)`. It goes through each segment, nested shells included. A segment with a token that contains `applications.json` is allowed only when its command word (from `commandIndex`) is in `READ_ONLY_TOOLS`, it has no `-i`/`--in-place` flag, and the token is not a redirect target. Anything else returns `'applications.json is the author's to change'`. Treat an unclosed quote that mentions `applications.json` as blocked.

Runner false positives:

- `runnerPath(t, name)` matches only when the segments contain `apps` immediately followed by `name`.
- In `fileLaunch`, when the args contain `-e`, `--eval`, `-p` or `--print`, there is a launch only if the inline script itself contains `apps/<name>`. The launch token is then the first argument after the script.

Settings: in `.claude/settings.json`, replace `"Read(./private/**)"` with `"Edit(./private/applications.json)"` and `"Write(./private/applications.json)"`.

- [ ] **Step 4: Run them and see them pass**

Run `pnpm test:hooks`. Expected: all pass.

- [ ] **Step 5: Commit** (only your hunk of `settings.json`, see Global Constraints)

```bash
git commit -m "feat(guard): let Claude read private/ and edit the bank; keep applications.json read-only"
```

### Task 2: CLAUDE.md, roadmap and spec wording

**Files:**

- Modify: `CLAUDE.md` (Commands, Guardrails, Running against LinkedIn)
- Modify: `docs/roadmap/README.md` (locked decision "Who may run things…", slice table, the 07b entry, a new 07c entry, slice 14's dependency)
- Modify: `docs/superpowers/specs/2026-11-14-fill-more-of-the-form-design.md` ("Guard false positive" paragraph)

- [ ] **Step 1: Edit `CLAUDE.md`, following the spec's "Docs that change" exactly**

- Every "Claude never reads" for the bank, the rules, `runs/` and raw snapshots becomes "Claude may read and edit (runs `facts-check` after an edit)".
- `applications.json` reads "Claude may read it, never write it; the guard blocks writes".
- Remove the private-set-is-the-author's line and the `private`-token block.
- Add `answer-misses.yaml` and `--set misses` (the command line comes in Task 5, so add it there).
- Remove the `pace-recordings/runner/` false-positive line.

- [ ] **Step 2: Edit the roadmap**

- Add the stage line under the locked decision.
- 07b: "Spec:" links to the spec, and "Spec answers: settled in the spec."
- Add `| 07c | Better answers from the bank | 07b |` to the Phase 1 table, and a short 07c section with the scope: experience questions, salary, bank-silent Yes/No, starting from `answers-eval --set misses`.
- Slice 14 depends on `07c, 10, 13`.

- [ ] **Step 3: Fix the spec's false-positive paragraph**

It should say what was actually blocked: `node -e '…' $f` in a command that named `apps/runner` elsewhere, and paths through `pace-recordings/runner/`. Leave the rest of the spec as it is.

- [ ] **Step 4: Run `pnpm format:check`.** Expected: clean.

- [ ] **Step 5: Commit** `docs: slice 07b guardrails, roadmap 07c`

Open PR 1. `nx affected` has nothing to run, and `test:hooks` runs in CI if it is wired there.

## PR 2: The misses record

### Task 3: Per-case run date in golden files

**Files:**

- Modify: `libs/answerer/src/golden/format.ts` (`GoldenCase`, `caseSchema`)
- Modify: `libs/answerer/src/golden/run.ts` (where a case's `runDate` is passed to `answerQuestion`)
- Test: `libs/answerer/src/golden/format.spec.ts`, `libs/answerer/src/golden/run.spec.ts`

**Interfaces:**

- Produces: `GoldenCase.runDate?: string` (YYYY-MM-DD). It overrides `GoldenFile.runDate` for that case.

- [ ] **Step 1: Write the failing tests**

- `format.spec.ts`, test `a case may carry its own runDate`: it parses `'2026-12-01'`, and it rejects `'1 Dec'` with a message naming the case id.
- `run.spec.ts`, test `a case's runDate overrides the file's`: with the fake caller, the `AnswerContext.runDate` seen for that case is `'2026-12-01'`, and for the other cases it is the file's.

- [ ] **Step 2: Run them and see them fail:** `pnpm nx test answerer`.
- [ ] **Step 3: Implement.** Add `runDate` to `caseSchema` with the file's regex, and use `c.runDate ?? file.runDate`.
- [ ] **Step 4: Run them and see them pass:** `pnpm nx test answerer`.
- [ ] **Step 5: Commit** `feat(answerer): per-case run date in golden files`

### Task 4: `misses.ts`: schema, derivation, append and conversion

**Files:**

- Create: `apps/runner/src/apply/misses.ts`
- Test: `apps/runner/src/apply/misses.spec.ts`
- Modify: `apps/runner/src/apply/record.ts` (export `writeAtomic` so both files share it)

**Interfaces:**

- Consumes: `ApplyRun`, `QuestionRecord` (`apply/types.ts`); `GoldenFile`, `GoldenCase` (`@xapply/answerer`, exported if not already); `TEXT_TYPES`; `normalizeLabel`.
- Produces:

```ts
export const DEFAULT_MISSES_PATH = join(
  REPO_ROOT,
  'private',
  'answer-misses.yaml',
);
export type MissAnswer =
  | { kind: 'typed'; value: AnswerValue; via: 'terminal' | 'chat' }
  | { kind: 'blank' }
  | { kind: 'stopped' };
export interface Miss {
  id: string; // `${jobId}-${slug(normalizedLabel)}-${type}`
  jobId: string;
  firstSeenAt: string; // run startedAt
  lastSeenAt: string;
  runDate: string; // YYYY-MM-DD of firstSeenAt
  question: Omit<FormQuestion, 'id' | 'stepLabels'>;
  answer: MissAnswer;
  reason: BlockReason | 'not-reached';
  detail: string;
  sources: Source[]; // from the answerer's detail, if any; else []
  savedAs: string | null;
}
export interface MissesFile {
  version: 1;
  jobs: Record<string, Job>;
  misses: Miss[];
}
export function missesFromRun(run: ApplyRun): Miss[];
export function mergeMisses(
  file: MissesFile,
  run: ApplyRun,
  fresh: Miss[],
): MissesFile;
export function loadMisses(path: string): MissesFile; // missing file → empty
export function saveMisses(path: string, file: MissesFile): void; // YAML, writeAtomic
export function missesToGolden(file: MissesFile): GoldenFile;
```

- [ ] **Step 1: Write the failing tests** (build the `ApplyRun` and its question records the way `run.spec.ts` does)

- `a blocked question answered at the terminal is a typed miss`: `by: 'author'`, `result.status: 'blocked'`, `reason: 'bank-silent'` → one miss with `answer: { kind: 'typed', via: 'terminal', value }`, `reason: 'bank-silent'`, and `savedAs` copied over.
- `needs-author is a stopped miss` and `blank is a blank miss`.
- `a backed question is not a miss`. A backed question with a `fillProblem` is not a miss either, because that's a form problem.
- `result null with by needs-author is reason not-reached`.
- `merge keeps a chat answer`: an existing `stopped` miss whose answer was then edited to `typed/chat`, and a fresh run with the same question `stopped` → the answer stays `typed/chat`, `lastSeenAt` moves forward, and the count is unchanged.
- `merge replaces stopped with a new terminal answer`.
- `merge adds the job once under jobs`.
- `missesToGolden`:
  - for choice, number and date types, a typed miss → `expect: { status: 'backed', value }`;
  - for text, textarea and typeahead → `expect: { status: 'backed' }`;
  - `blank` and `stopped` are left out;
  - each case gets `runDate: miss.runDate` and `job: miss.jobId`;
  - the result passes `goldenFileSchema`.
- `loadMisses rejects a file that fails the schema` with a message that holds no value.

- [ ] **Step 2: Run them and see them fail:** `pnpm nx test runner -- misses`.

- [ ] **Step 3: Implement**

The Zod schema mirrors the types. YAML goes through the same `yaml` package the bank uses. `missesToGolden` sets the top-level `runDate` to the earliest miss's (one is required) and has no `bank` key, because the command supplies the bank.

- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `feat(runner): record bank misses for the next slice`

### Task 5: Write misses after every apply run, and `answers-eval --set misses`

**Files:**

- Modify: `apps/runner/src/commands/apply.ts` (`ApplyCommandDeps` gains `writeMisses`, called after `writeReports`)
- Modify: `apps/runner/src/commands/answers.ts` (`EvalSet` gains `'misses'`)
- Modify: `apps/runner/src/main.ts` (accept `--set misses`)
- Modify: `CLAUDE.md` (the `answers-eval` command line)
- Test: `apps/runner/src/commands/apply.spec.ts`, `apps/runner/src/commands/answers.spec.ts`

**Interfaces:**

- Consumes: Task 4's `missesFromRun`, `mergeMisses`, `loadMisses`, `saveMisses`, `missesToGolden`.
- Produces: `ApplyCommandDeps.writeMisses: (run: ApplyRun) => { added: number; updated: number }`.

- [ ] **Step 1: Write the failing tests**

`apply.spec.ts`:

- `writes misses after the reports`: a fake `writeMisses` is called once with the run, after `writeReports`, on `reached-review`, `needs-author`, `error` and `stopped` runs.
- `a misses write that throws prints one fixed line and keeps the exit code`. The line is `misses: not written (<error name>)`, and no value appears in it.
- In author mode, the closing output gains `misses: <added> new, <updated> seen again`, printed only when either count is above 0.

`answers.spec.ts`:

- `misses set loads the misses file and the private bank, and prints ids and counts only`. Use the same no-values assertion the private-set test uses.
- `misses set with no answered misses prints "no answered misses" and exits 0`.

- [ ] **Step 2: Run them and see them fail:** `pnpm nx test runner`.

- [ ] **Step 3: Implement**

The default `writeMisses` loads `DEFAULT_MISSES_PATH`, merges and saves. `--set misses` is a third path in `answersEvalCommand`: it loads the golden set through `missesToGolden(loadMisses(...))`, uses the private bank, and uses the private set's redaction (`isPrivate` becomes `set !== 'example'`). Full results go to `private/answers-eval/` as for the private set.

- [ ] **Step 4: Run them and see them pass**, then run `pnpm nx run-many -t lint typecheck -p runner answerer`.

- [ ] **Step 5: Commit** `feat(runner): write misses after a run; answers-eval --set misses`

Open PR 2.

## PR 3: Field types from snapshots

### Task 6: `date` type and `date-offset` math in the answerer

**Files:**

- Modify: `libs/answerer/src/types.ts` (`FIELD_TYPES` gains `'date'`; `MathSpec` gains `{ kind: 'date-offset'; amount: number; unit: 'day' | 'week' | 'month' }`)
- Modify: `libs/answerer/src/math.ts` (`addOffset`)
- Modify: `libs/answerer/src/checks.ts` (`checkMath`, the date value check)
- Modify: `libs/answerer/src/prompts/schemas.ts` (`math.kind` enum, `amount` and `unit` nullable, `toMath`)
- Modify: `libs/answerer/src/prompts/generator.ts` (the math section)
- Modify: `libs/answerer/golden/example.yaml` (3 cases)
- Test: `math.spec.ts`, `checks.spec.ts`, `prompts.spec.ts`

**Interfaces:**

- Produces:
  - `addOffset(runDate: string, amount: number, unit: 'day' | 'week' | 'month'): string`, which returns YYYY-MM-DD.
  - The canonical value of every `date` answer is `YYYY-MM-DD`. The runner formats it for the field.

- [ ] **Step 1: Write the failing tests**

`math.spec.ts`:

- `addOffset('2026-11-14', 1, 'week')` is `'2026-11-21'`.
- `addOffset('2026-01-31', 1, 'month')` is `'2026-02-28'`, clamped to the month's end.
- `addOffset('2026-11-14', 0, 'day')` is `'2026-11-14'`.

`checks.spec.ts`:

- A date candidate whose `math: {kind:'date-offset', amount: 1, unit: 'week'}` cites the example bank's "notice period one week" fact, with value `'2026-11-19'` and run date `'2026-11-12'`, passes.
- The same candidate with value `'2026-11-20'` fails `math does not match`.
- An amount not in the cited fact fails `number not in sources`.
- A unit word not in the cited fact (`month` against a fact that says "week") fails `math does not match`.
- A value for a `date` question that is not YYYY-MM-DD fails `not a date`.
- A date-offset on a non-date question fails `math does not match`.

`prompts.spec.ts`:

- `toMath` builds `date-offset` from `{kind:'date-offset', amount:1, unit:'week', year:null, month:null, expression:null}`.
- It rejects `date-offset` without an amount or without a unit.

- [ ] **Step 2: Run them and see them fail:** `pnpm nx test answerer`.

- [ ] **Step 3: Implement**

The unit check accepts `day|days`, `week|weeks` and `month|months`, plus number words for the amount, through the existing `numbersIn`. Add this to the generator prompt's math section:

> For a date question ("earliest start date") from a stated notice period, use date-offset with the amount and unit from the cited entry; code adds it to the run date and the value must be that date as YYYY-MM-DD.

A `date` question with no backing source is `cannot-answer`, as for any other type.

- [ ] **Step 4: Add example cases**

- `date-start-from-notice` (backed, `2026-11-19`, derivation `math`).
- `date-no-source` ("Date you completed your degree", blocked).
- `date-type-not-guessed` (an optional date question the bank says nothing about, blocked).

- [ ] **Step 5: Run `pnpm nx test answerer`, then `pnpm nx run runner:answers-eval -- --repeat 3`.** Expected: every case passes, including the 43 existing ones.

- [ ] **Step 6: Commit** `feat(answerer): date fields and date-offset math`

### Task 7: Snapshots, and the leak check that gates every fixture

The author does part of this.

**Files:**

- Modify: `apps/runner/src/snapshot/scrub.ts` (`leakCheck`)
- Modify: `apps/runner/src/snapshot/secrets.ts` (phone pattern)
- Modify: `apps/runner/src/commands/snapshot.ts` (`snapshot-scrub` runs `leakCheck` on every scrubbed file and exits 1 on any hit)
- Test: `apps/runner/src/snapshot/scrub.spec.ts`

**Interfaces:**

- Produces: `leakCheck(scrubbed: string, bank: FactBank): { kind: 'email' | 'phone' | 'name' | 'fact' | 'answer' | 'link'; count: number }[]` (empty means clean). Phone numbers are compared digits only, for the bank's number with and without its country code and a leading 0.

- [ ] **Step 1: Write the failing tests**

- `leakCheck finds the example bank's phone in +447700900123, 07700 900123, (0)7700-900-123`.
- `finds the email in mixed case`.
- `returns [] on every committed fixture` (loop over the `apps/runner/src/apply/fixtures/*.html` files against the example bank).
- `scrubSnapshot removes +447700900123`, which is the known gap.

- [ ] **Step 2: Run them and see them fail**, then implement, then see them pass: `pnpm nx test runner -- scrub`.

- [ ] **Step 3: Commit** `feat(runner): leak check on scrubbed snapshots`

- [ ] **Step 4: Handoff to the author**

Ask the author to run `pnpm nx run runner:snapshot -- <url>` on each walkthrough job, pressing Enter on every step through to the review page:

- 4488500594, 4490505838 and 4490356080 (the three hard jobs);
- 4490324628 (step-1 text box) and 4490304984 (email dropdown);
- the saved jobs they provide.

If any of them has a date field or a multi-select, say which. Then run `pnpm nx run runner:snapshot-scrub`. Expected: `leaks: 0` for every file. Also read each raw snapshot beside its scrubbed copy, and fix the scrubber for anything personal that `leakCheck` didn't name (add it to `leakCheck` too, with a test).

### Task 8: Read and fill `date` fields

**Files:**

- Modify: `apps/runner/src/linkedin/form-step.ts` (`readText`, or a new `readDate`; `ReadField.dateFormat`)
- Modify: `apps/runner/src/linkedin/types.ts` (`ReadField.dateFormat?: string`, `ReadField.calendar?: string`)
- Modify: `apps/runner/src/apply/fill.ts` (`fillGuarded` case `'date'`, `fillDate`)
- Create: fixtures under `apps/runner/src/apply/fixtures/`, named `step-date-*.html`, from Task 7's scrubbed snapshots
- Test: `apps/runner/src/linkedin/form-step.spec.ts`, `apps/runner/src/apply/fill.spec.ts`

**Interfaces:**

- Consumes: Task 6's `'date'` type and its YYYY-MM-DD values.
- Produces:
  - `ReadField.dateFormat`, a token string such as `'MM/DD/YYYY'`;
  - `formatDate(iso: string, format: string): string`;
  - `parseDate(text: string, format: string): string | null`.

- [ ] **Step 1: Write the failing tests**

From each date fixture:

- the reader returns the field as `type: 'date'` with its label, `required` and `dateFormat`;
- an `input type="date"` gets `dateFormat: 'YYYY-MM-DD'`;
- a text box gets its format from its placeholder, else its help text. When neither gives a format, it goes to unknown.

Also:

- `formatDate('2026-11-21', 'DD/MM/YYYY')` is `'21/11/2026'`, and `parseDate` reverses it.
- `fillDate` types the formatted date through `pace.type`, reads the value back, and compares it through `parseDate`. A read-back of another date is `unverified`.
- For a read-only input with a calendar, it presses through `pace.click` only. Write that test only if a fixture has one; otherwise a read-only date input goes to unknown, and the PR notes it.

- [ ] **Step 2: Run them and see them fail**, then implement, then see them pass: `pnpm nx test runner`.

- [ ] **Step 3: Commit** `feat(runner): read and fill date fields`

### Task 9: The email dropdown and the step-1 text box, from their snapshots

**Files:**

- Modify: `libs/answerer/src/fields.ts` (`FIELD_PATTERNS.email`, or the option match for emails) and/or `apps/runner/src/linkedin/form-step.ts` (`push` or `labelOf`), as the evidence shows
- Create: fixtures `step-email-select.html` and `step-1-text-box.html`
- Test: `libs/answerer/src/fields.spec.ts`, `apps/runner/src/linkedin/form-step.spec.ts`

- [ ] **Step 1: Find the cause**

Read the full reports in `private/runs/` for `2026-11-13T05-40-20.584Z` (email) and `2026-11-13T05-26-50.502Z` (text box), and the two raw snapshots. Write down which of these it is:

- the email label wasn't a whole `FIELD_PATTERNS` label, or the option didn't match;
- the text box had no label, or no unique selector.

- [ ] **Step 2: Write the failing tests**

- `mapField` fills the email select from the bank with the exact option text, case-insensitively.
- When every option is masked (contains `*`, or doesn't match), `mapField` returns `{ kind: 'blocked', reason: 'bank-silent', detail: 'no option matches field email' }` and never reaches the model.
- The step-1 fixture reads its box as a field with its label. If it's a date, it reads as `type: 'date'`.

- [ ] **Step 3: Implement the fix the evidence points to, then run the tests and see them pass.**
- [ ] **Step 4: Commit** `fix: email dropdown from the bank; read the step-1 text box`

### Task 10: Multi-select on a real form, and anything else the snapshots show

**Files:**

- Create: the fixtures that show a checkbox group or another new control
- Test: `form-step.spec.ts`, `fill.spec.ts`

- [ ] **Step 1: Test each scrubbed snapshot**

For each step of each scrubbed snapshot, write a test that its read has `unknown.length === 0`, or that its unknowns are listed in `apps/runner/src/apply/fixtures/README.md` as "odd, later slice" with the reason. A checkbox group reads with every option and `stableGroup`.

- [ ] **Step 2: Add a reader and filler for each ordinary new control**

A control counts as ordinary when it is a standard input or a common LinkedIn widget with a readable label. Each gets a reader and filler, with tests on its fixture, following the pattern of the nearest existing type. Odd ones stay unknown.

- [ ] **Step 3: Run `pnpm nx run-many -t lint test build typecheck`, and commit** `feat(runner): fields from the walkthrough snapshots`

Open PR 3.

## Walkthroughs, the slice's exit check

### Task 11: Dry runs on the set, with the chat loop

This task has no new code unless a run turns up a bug. A bug gets its own fixture, test and commit on a `slice-07b-walkthrough-fixes` branch, opened as PR 4.

- [ ] **Step 1: Start a dry run when the author asks**

Run `pnpm nx run runner:apply --outputStyle=stream -- 'https://www.linkedin.com/jobs/view/<id>/' --dry-run`. Do it only when the author asks in that session, a few a day.

- [ ] **Step 2: Read the run's full report in `private/runs/` and the new entries in `answer-misses.yaml`.**

- [ ] **Step 3: Answer each `stopped` miss through the author**

Ask the author in chat, one message listing each `stopped` miss's question and options. Then for each one:

- set `answer: { kind: typed, via: chat, value }` in `answer-misses.yaml`;
- if the author says to save it, add it to `fact-bank.yaml` as a known answer, in the shape `addKnownAnswer` writes;
- run `pnpm nx run runner:facts-check --outputStyle=stream` (expected: no problems);
- tell the author what changed.

- [ ] **Step 4: Re-run the job when the author asks.** Repeat until it reaches the review page.

- [ ] **Step 5: Check the slice is done**

- Every job in the set reached the review page.
- The author confirmed the filled fields.
- One live date field and one live multi-select were filled and read back.
- 4490304984 and 4490324628 are past their old stops.
- `pnpm nx run runner:answers-eval -- --set misses` runs.

Record the result in the PR 3 or PR 4 description.
