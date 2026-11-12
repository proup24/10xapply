# Walk the Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runner apply <job-url> --dry-run` walks a real LinkedIn Easy Apply form to the review page. It answers every question through the slice 05 answerer, asks the author in the terminal when a question blocks, saves those answers to the fact bank, and writes a full report for the author and a redacted one for Claude. It never presses Submit.

**Architecture:** The runner reads the page as HTML through one read-only CDP call on the relay (`DOM.getOuterHTML` with `includeShadowDOM`). Pure readers parse that HTML with `linkedom`. So the snapshots the author saves are byte-for-byte what the readers see at run time, and every reader is tested on committed, scrubbed fixtures. The runner acts only through the pace module, on Patchright locators built from the selectors the readers return. A walker (`runApply`) strings the steps together behind injected dependencies, so it is tested with fakes.

**Tech Stack:** Nx 24, pnpm, Node 24, TypeScript (nodenext, strict), Vitest, `patchright-core` 1.64.3 (pinned, unchanged), `linkedom` (already a runner dev dependency; it becomes a runtime dependency), `yaml` ^2.9.0 (already in `libs/fact-bank`), `@xapply/answerer`, `@xapply/fact-bank`.

**Spec:** `docs/superpowers/specs/2026-11-12-walk-the-form-design.md`

## Global Constraints

- Branch `slice-06-walk-the-form` (exists; the spec is its first commit). Never work on `main`.
- **Never name the private folder in a Bash command or a commit message.** The guard blocks it. Source files and docs may contain the string. Tests use temp dirs.
- Claude never reads the author's bank, raw snapshots or full reports. Claude may read `run-reports/` and `snapshots/`.
- **No Submit code path.** No code in this slice clicks a control whose text or `aria-label` matches `/submit/i`. The walker stops when the review page is read.
- Without `--dry-run`, `runner apply` exits 2 with exactly `apply: submitting comes in slice 07; use --dry-run` before connecting to anything.
- Only `apps/runner/src/pace/` acts on a page. The ESLint bans on input methods and on page scripts (`evaluate` and the rest) stay as they are.
- **Author mode** = `process.stdin.isTTY && process.stdout.isTTY && !process.env.CLAUDECODE`. Only author mode prints labels, answers or bank text, or reads the keyboard.
- Redacted outputs (`run-reports/`, non-author terminal output, `snapshots/` counts) never hold a label, an option, an answer value, LinkedIn error text or bank text.
- `FormQuestion.id` is `s<step>-q<n>` (both 1-based, `n` in page order, new fields from a re-read continue the numbering).
- At most 3 read-answer-fill rounds per step. A fourth round needed is the safety stop `too-many-rounds`.
- Known-answer ids: kebab-case of the label, digits removed, first 6 words, `-2`, `-3`, … when taken, `answer` when nothing is left.
- Multi-pick answers are saved joined with `; `.
- Typographic mapping before typing: `‘ ’ ‚ ′` → `'`, `“ ” „ ″` → `"`, `– — ‒ −` → `-`, `…` → `...`, U+00A0 → space. After mapping, anything outside `\x20-\x7e` and `\n` makes the question blocked (`not-typeable`).
- `patchright-core` stays at exactly `1.64.3`. No new runtime dependency besides moving `linkedom` to `dependencies`.

## Review Focus

1. **The job was dry-run before, so LinkedIn reopens the form part-filled** (a saved draft). Expect the walker to treat those values as prefilled: match means glance, differ means replace and mark `changedFromLinkedIn`. Never a safety stop just for being part-filled. Test in Task 11 (`resumes a part-filled draft`).
2. **The same question twice in one run** (a label repeated on two steps) after the author answered and saved the first. Expect the second to be answered from the reloaded bank without asking. Test in Task 11 (`uses a saved answer later in the same run`).
3. **A fill that LinkedIn didn't take**, so Next shows "Please enter a valid answer". Expect the `step-did-not-change` stop, the error text only in the full report, and only the stop kind in the redacted copy. Test in Task 11 and Task 12.
4. **A label carrying the author's own data** ("Is +44 7700 900123 your number?"). Expect no digit run of the phone or the email anywhere in `run-reports/` or in non-author output. Tests in Task 12 (`redacted copy holds no label`) and Task 8 (`id drops digits`).
5. **Ctrl+C or a bridge stop in the middle of a step.** Expect the run window closed, both reports written with outcome `stopped`, and the bank left whole (a save either finished or was rolled back). Test in Task 11 (`stop mid-step still reports`) and Task 8 (`check failure restores the backup`).

---

### Task 1: Roadmap, CLAUDE.md, ignore rules and the guard's safe list

**Files:**

- Modify: `docs/roadmap/README.md` (slice 06/05b/07 lines), `CLAUDE.md` (commands, guardrails, safe-list line), `.gitignore` (add `snapshots/`), `.claude/hooks/guard.mjs:343-362` (add `'snapshot'`, `'snapshot-scrub'`), `.claude/hooks/guard.test.mjs`

**Interfaces:** Produces the Nx target names later tasks add: `runner:apply`, `runner:snapshot`, `runner:snapshot-scrub`.

- [ ] **Step 1: Failing guard tests** in `guard.test.mjs`:
  - `pnpm nx run runner:snapshot -- https://www.linkedin.com/jobs/view/1/` is allowed.
  - `pnpm nx run runner:snapshot-scrub` is allowed.
  - `pnpm nx run runner:apply -- https://www.linkedin.com/jobs/view/1/ --dry-run` is allowed.
  - `pnpm nx run runner:apply -- https://www.linkedin.com/jobs/view/1/` is blocked with the existing "Runner blocked" reason.
- [ ] **Step 2:** Run `pnpm test:hooks`. Expect the two `snapshot` cases to fail. If either `apply` case fails, fix the guard so `apply` follows the existing `--dry-run` rule; don't add it to the safe list.
- [ ] **Step 3:** Add the two names to `RUNNER_SAFE_SUBCOMMANDS`. Add `snapshots/` to `.gitignore`. Then update the docs:
  - **Roadmap:** slice 06 depends on `03, 03b, 05`. The 05b row depends on `06`, and its scope gains "adds its check to the run: on the job page before the form opens, and on each question". Slice 07 depends on `06, 05b`. Slice 07's "whether a terminal answer is saved back" becomes "answered in slice 06: yes, as a known answer". Slice 06 gets a `Spec:` link. The line "03→03b and 04→05→05b…" becomes "03→03b and 04→05 are independent; 05b follows 06".
  - **CLAUDE.md:** the three commands, the guard's safe list, and the rule that `snapshot` runs only when the author asks in that session. Also `snapshots/` (git-ignored, Claude-readable, scrubbed only), the private folder's `runs/` and `snapshots/`, and the author-mode rule in one line.
- [ ] **Step 4:** Run `pnpm test:hooks`. Expect all to pass.
- [ ] **Step 5:** Commit `chore(harness): slice 06 roadmap, docs and guard safe list`.

### Task 2: Read the page's HTML through the relay

**Files:**

- Modify: `apps/runner/src/relay/browser-model.ts`, `apps/runner/src/relay/relay.ts`, `apps/runner/src/bridge/bridge.ts`
- Test: `apps/runner/src/relay/relay.spec.ts`

**Interfaces:**

- Produces: `Bridge.pageHtml(): Promise<string>`: the run tab's full document, with open shadow roots serialised as `<template shadowrootmode="open">`. It runs no page script.

- [ ] **Step 1: Failing tests** in a new `describe('pageHtml')`, in the style of `describe('uploadOnChooser')`:
  - `sends DOM.getDocument then DOM.getOuterHTML with includeShadowDOM on the run tab`: assert the order, that `getOuterHTML` gets `{ nodeId: <root>, includeShadowDOM: true }`, and that it resolves to the `outerHTML` string.
  - `rejects with "no run tab" when no tab is attached`.
  - `DOM.getOuterHTML is not refused by isRefused`. This is a policy check.
- [ ] **Step 2:** Run `pnpm nx test runner -- relay.spec`. Expect FAIL.
- [ ] **Step 3:** Implement `BrowserModel.pageHtml(): Promise<string>` (`DOM.getDocument` `{ depth: 0 }`, then `DOM.getOuterHTML`). Expose it on the relay handle and on `Bridge`.
- [ ] **Step 4:** Run the test. Expect PASS. Run `pnpm nx run runner:bridge-check`. Expect it to pass as before, since it never touches LinkedIn.
- [ ] **Step 5:** Commit `feat(runner): read the run tab's HTML through the relay`.

### Task 3: Parse page HTML, and author mode

**Files:**

- Create: `apps/runner/src/linkedin/dom.ts`, `apps/runner/src/terminal/author-mode.ts`
- Test: `apps/runner/src/linkedin/dom.spec.ts`, `apps/runner/src/terminal/author-mode.spec.ts`
- Modify: `apps/runner/package.json` (move `linkedom` to `dependencies`)

**Interfaces:**

- Produces:
  - `parsePage(html: string): Document`. It uses linkedom, and every `<template shadowrootmode=…>` is replaced by its children in place, so `querySelector` reaches into shadow content.
  - `isAuthorMode(env: NodeJS.ProcessEnv, stdinTTY: boolean, stdoutTTY: boolean): boolean`.
  - `interface TerminalIO { print(line: string): void; ask(prompt: string): Promise<string> }`.
  - `nodeTerminal(): TerminalIO` (readline on stdin/stdout).

- [ ] **Step 1: Failing tests:**
  - `parsePage reaches an input inside a shadow root`: `<div><template shadowrootmode="open"><input id="a"></template></div>` → `querySelector('#a')` is not null.
  - `parsePage handles nested shadow roots`.
  - `isAuthorMode`: true only for `({}, true, true)`. False for `CLAUDECODE: '1'` with both TTYs, and for either TTY being false.
- [ ] **Step 2:** Run `pnpm nx test runner -- dom.spec author-mode.spec`. Expect FAIL.
- [ ] **Step 3:** Implement. Unwrap the templates on the string before parsing, or by walking `template` elements after it. Either is fine, as long as nested roots work.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5: Check that keyboard input reaches an Nx target.** Add a throwaway target `runner:tty-probe` that prints `isTTY` for stdin and stdout and echoes one line read from stdin. Ask the author to run `pnpm nx run runner:tty-probe` in their own terminal (not through `!`) and report what it printed.
  - **If input arrives**, delete the probe.
  - **If it doesn't**, add root `package.json` scripts `"apply": "pnpm --dir apps/runner exec tsx --conditions=@xapply/source src/main.ts apply"` and the same for `"snapshot"`, and name those in CLAUDE.md as the author's way in.

  Record the outcome in the commit message.

- [ ] **Step 6:** Commit `feat(runner): page HTML parser and author mode`.

### Task 4: The scrubber

**Files:**

- Create: `apps/runner/src/snapshot/scrub.ts`
- Test: `apps/runner/src/snapshot/scrub.spec.ts`

**Interfaces:**

- Consumes: `parsePage`.
- Produces:
  - `scrubSnapshot(html: string, secrets: string[]): { html: string; counts: ScrubCounts }`.
  - `interface ScrubCounts { removedElements: number; blankedTexts: number; secretsReplaced: number; droppedAttributes: number }`.
  - `bankSecrets(bank: FactBank): string[]`: every field value (and the phone number with spaces removed), every fact, every answer and variant text, every story title and text, and the resume's basename. Blank strings and strings shorter than 3 characters are dropped. The list is sorted longest first.

**The rules (from the spec):**

- **Remove these elements:** `script`, `style`, `link`, `meta`, `noscript`, `iframe`, `svg`, `img`, `input[type=hidden]`, and any `[type="application/ld+json"]` or `code` holding embedded JSON.
- **Remove these attributes:** every `href`, `src`, `srcset`, `action`, `style`, `on*`, `data-*` except `data-test*`, and the `value` of `input` and `textarea`. Also every `aria-label` on elements other than `input`, `select`, `textarea`, `button`, `[role=radio]`, `[role=checkbox]`, `[role=option]` and `[role=combobox]`.
- **Keep visible text** only inside `label`, `legend`, `h1`–`h6`, `button`, `option`, `[role=option]`, `[role=radio]`, `[role=checkbox]`, and elements whose id is named by some `aria-describedby`. Every other text node becomes `x` repeated to its length, whitespace kept.
- **Then** replace every occurrence of each secret, in all text and in every remaining attribute value, with `[secret]`. Matching ignores case.

- [ ] **Step 1: Failing tests:**
  - `blanks review-page answers`: `<div><h3>Notice period</h3><span>Two weeks</span></div>` → the heading is kept and the span becomes `xxx xxxxx`.
  - `keeps form wording`: label, option and button text survive.
  - `keeps help text named by aria-describedby`.
  - `replaces a bank value inside an option`: an `<option>me@example.com</option>` with that secret → `[secret]`.
  - `replaces a secret inside a kept aria-label`.
  - `drops input values, URLs and scripts`.
  - `counts what it did and returns no secret`: no output string, counts included, contains any secret.
  - `bankSecrets` on the example bank: it includes the email, the phone without spaces and every fact text, and drops `'+1'`-length strings.
- [ ] **Step 2:** Run `pnpm nx test runner -- scrub.spec`. Expect FAIL.
- [ ] **Step 3:** Implement on the parsed document, then serialise with `document.toString()`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): snapshot scrubber`.

### Task 5: `runner snapshot` and `runner snapshot scrub`

**Files:**

- Create: `apps/runner/src/commands/snapshot.ts`, `apps/runner/src/snapshot/paths.ts`
- Modify: `apps/runner/src/main.ts` (dispatch and usage), `apps/runner/package.json` (targets `snapshot` and `snapshot-scrub`, in the style of `session`)
- Test: `apps/runner/src/commands/snapshot.spec.ts`

**Interfaces:**

- Consumes: `Bridge.pageHtml`, `scrubSnapshot`, `bankSecrets`, `isAuthorMode`, `TerminalIO`, `loadFactBank`.
- Produces:
  - `RAW_SNAPSHOTS_DIR` (`<repo>/private/snapshots`) and `SCRUBBED_SNAPSHOTS_DIR` (`<repo>/snapshots`), resolved from the file like `REPORTS_DIR`.
  - `parseJobUrl(url: string): string | null`: the job id from `/jobs/view/<id>` or from a `currentJobId=<id>` query on any `linkedin.com/jobs/` URL, otherwise `null`.
  - `jobViewUrl(id: string): string` → `https://www.linkedin.com/jobs/view/<id>/`.
  - `snapshotCommand(argv: string[], deps?): Promise<number>`.
  - `snapshotScrubCommand(deps?): Promise<number>`.

**Behaviour:**

- `snapshot` refuses outside author mode (exit 2, `snapshot: run this from your own terminal`) and on a bad URL (exit 2).
- It opens a run window at `jobViewUrl(id)` and does nothing on the page. In a loop it asks `Enter = save this page, q = finish`. Each Enter writes `RAW_SNAPSHOTS_DIR/<startedAt>/<nn>-<pathPrefix>.html` and prints only the file name.
- It stops on `bridge.stopReason()` and always closes the bridge.
- `snapshot scrub` scrubs every raw file that has no scrubbed twin yet into `SCRUBBED_SNAPSHOTS_DIR/<same relative path>`, and prints counts per file. It runs in any mode, since it prints no values.

- [ ] **Step 1: Failing tests** (fake bridge, fake IO, temp dirs passed through `deps`):
  - `parseJobUrl` table: a view URL, a search URL with `currentJobId`, a non-LinkedIn URL → null, a `/jobs/view/abc` → null.
  - `refuses outside author mode`.
  - `saves one file per Enter and finishes on q`.
  - `scrub writes twins only for new raw files and prints counts, never text`.
- [ ] **Step 2:** Run `pnpm nx test runner -- snapshot.spec`. Expect FAIL.
- [ ] **Step 3:** Implement. Wire `main.ts` so `runner snapshot <url>` and `runner snapshot scrub` dispatch.
- [ ] **Step 4:** Run the tests, then `pnpm nx run-many -t lint typecheck -p runner`. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): snapshot and snapshot scrub commands`.

### Task 6: Snapshots from the author, committed as fixtures (author checkpoint)

**Files:**

- Create: `apps/runner/src/apply/fixtures/README.md` and the scrubbed `*.html` fixtures.

- [ ] **Step 1:** Ask the author to run `pnpm nx run runner:snapshot -- <job-url>` (or the root script from Task 3) on two or three Easy Apply jobs they don't mind opening. They drive the form by hand, never submit, and save:
  - the job page;
  - each form step, including a contact step, the resume step and a questions step with a dropdown, radios and a text box (a typeahead if they meet one);
  - the review page;
  - an "Applied" job page.

  They close the form with Dismiss and Discard.

- [ ] **Step 2:** Run `pnpm nx run runner:snapshot-scrub`. Read each file in `snapshots/` and look for anything personal: a name, an email, a phone number, a city, a salary, a free-text answer. **If anything is found, fix the scrubber (with a test in Task 4's spec), rerun, and never copy that file.**
- [ ] **Step 3:** Copy the clean files to `apps/runner/src/apply/fixtures/` with descriptive names (`job-page.html`, `step-contact.html`, `step-resume.html`, `step-questions.html`, `review.html`, `job-applied.html`). Write the README table: `| file | kind | source | scrubbed |`, where `kind` is one of `job`, `job-applied`, `step`, `review`.
- [ ] **Step 4:** Commit `test(runner): scrubbed LinkedIn Easy Apply fixtures`. Also note in the task log what the author said about drafts after Discard. It decides the close-out in Task 11.

### Task 7: Readers: job page and form step

**Files:**

- Create: `apps/runner/src/linkedin/job-page.ts`, `apps/runner/src/linkedin/form-step.ts`, `apps/runner/src/linkedin/selectors.ts`
- Test: `apps/runner/src/linkedin/job-page.spec.ts`, `apps/runner/src/linkedin/form-step.spec.ts`

**Interfaces:**

- Consumes: `parsePage`, the fixtures from Task 6, `FormQuestion` and `FIELD_TYPES` from `@xapply/answerer`.
- Produces:

```ts
export interface JobRead {
  title: string | null;
  company: string | null;
  location: string | null;
  description: string | null;
  /** Selector for the Easy Apply button, or null when the job isn't Easy Apply. */
  easyApply: string | null;
  applied: boolean;
}
export function readJobPage(doc: Document): JobRead;

export interface ReadField {
  /** Stable within a step across re-reads; used to tell new fields from old. */
  key: string;
  /** CSS selector for a Patchright locator (pierces open shadow roots). */
  selector: string;
  /** FormQuestion minus id; the walker numbers it. */
  question: Omit<FormQuestion, 'id'> & { type: FieldType };
  /** radio, checkbox-group: one selector per option, in `question.options` order. */
  optionSelectors?: string[];
  /** file: resumes LinkedIn already lists. */
  resumeChoices?: { fileName: string; selector: string; selected: boolean }[];
  /** typeahead: where suggestions appear once typed. */
  suggestions?: string;
}
export interface UnknownField {
  tag: string;
  role: string | null;
  inputType: string | null;
}
export type StepRead =
  | {
      kind: 'step';
      title: string | null;
      progress: number | null;
      fields: ReadField[];
      unknown: UnknownField[];
      next: { selector: string; label: 'next' | 'review' } | null;
      errors: string[];
    }
  | { kind: 'review' }
  | { kind: 'none' }; // no Easy Apply dialog on the page
export function readStep(doc: Document): StepRead;
/** Equal keys mean the step did not change. */
export function stepKey(r: StepRead): string;
```

**Rules the tests pin:**

- **Review:** a dialog whose primary button's text or `aria-label` matches `/submit/i` reads as `{ kind: 'review' }`, whatever else is on the page. `next` is never a Submit button.
- **Type mapping:**
  - `input[type=text|email|tel|url]` without a listbox → `text`;
  - a `role=combobox` text input with a listbox → `typeahead`;
  - `input[type=number]` or `inputmode=numeric` → `number`;
  - `textarea` → `textarea`;
  - `select` → `select`;
  - a `fieldset` of radios → `radio`;
  - a `fieldset` of several checkboxes → `checkbox-group`;
  - one checkbox → `checkbox`;
  - `input[type=file]` or the resume section → `file`.

  Anything else that takes input goes to `unknown`.

- **`required`** comes from `required`, `aria-required="true"` or a trailing `*` on the label. The label is read with that `*` removed.
- **`helpText`** comes from `aria-describedby`.
- **`stepKey`** is title + progress + sorted field keys.

- [ ] **Step 1: Failing tests,** one per fixture row, driven by the README table as `classify.spec.ts` does:
  - `job` fixtures: `easyApply` not null, `description` length > 200, `applied` false;
  - `job-applied`: `applied` true;
  - `step` fixtures: at least one field each, no `unknown`, and `next` not null;
  - `review`: `{ kind: 'review' }`.

  Plus synthetic cases for every row of the type mapping, `required` from `*`, an unknown `input[type=range]` → `unknown`, and `stepKey` changes when a field is added.

- [ ] **Step 2:** Run `pnpm nx test runner -- job-page.spec form-step.spec`. Expect FAIL.
- [ ] **Step 3:** Implement. All selectors live in `selectors.ts` with a comment naming the fixture they were read from. Prefer `id`-based selectors when the element has an id, else a `data-test*` or role-plus-label path.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): LinkedIn job page and form step readers`.

### Task 8: Saving a known answer into the bank

**Files:**

- Create: `libs/fact-bank/src/add-answer.ts`
- Modify: `libs/fact-bank/src/index.ts`
- Test: `libs/fact-bank/src/add-answer.spec.ts`

**Interfaces:**

- Produces:
  - `answerIdFrom(label: string, taken: ReadonlySet<string>): string`.
  - `addKnownAnswer(path: string, entry: { question: string; answer: string }, opts: { company: string | null; jobTitle: string | null; today: string; stamp: string }): { ok: true; id: string } | { ok: false; problems: string[] }`.

  `stamp` names the backup `<path>.<stamp>.bak`. `problems` are `formatProblem` strings, never values.

**Behaviour:**

1. Copy to the backup.
2. Replace `company` and `jobTitle` (case-insensitive, whole occurrences, skipped when null or shorter than 3 characters) with `{company}` and `{jobTitle}` in both strings.
3. Append `{ id, question, answer, confirmed: today }` to `answers` through `parseDocument` / `doc.toString()`, so comments survive.
4. Run `checkFactBank(path)`. If it fails, copy the backup back and return the problems.

- [ ] **Step 1: Failing tests** (temp copy of the example bank):
  - `answerIdFrom`: `'Is +44 7700 900123 your number?'` → `is-your-number` (`id drops digits`); a 9-word label is cut to its first 6 words; a taken id gets `-2`; `'123'` → `answer`.
  - `appends a known answer and keeps comments`: a file with a `# keep me` comment still has it, and `loadFactBank` finds the new id with `confirmed`.
  - `replaces company and job title with placeholders`.
  - `check failure restores the backup`: force a failure (an answer text with `{unknown}`) and assert the file is byte-equal to before and `problems` is non-empty.
- [ ] **Step 2:** Run `pnpm nx test fact-bank -- add-answer.spec`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(fact-bank): add a known answer in place, with backup and check`.

### Task 9: Pace: `clear` and newlines in a textarea

**Files:**

- Modify: `apps/runner/src/pace/pace.ts`
- Test: `apps/runner/src/pace/pace.spec.ts`

**Interfaces:**

- Produces:
  - `Pace.clear(field: Locator): Promise<void>`: clicks the field, then Ctrl+A and Backspace at `keyGap`/`keyHold` draws. It sends nothing if the field didn't take focus.
  - `Pace.type(field, text)` now accepts `\n` only when `field.locator('xpath=self::textarea').count()` is 1, and sends it as Enter. On any other field, a `\n` throws before anything moves, as an unknown character does today.

- [ ] **Step 1: Failing tests,** in the existing fake-page style:
  - `clear selects all then deletes`;
  - `clear sends nothing without focus`;
  - `type sends Enter for a newline in a textarea`;
  - `type throws on a newline in an input before moving`.
- [ ] **Step 2:** Run `pnpm nx test runner -- pace.spec`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `pnpm nx lint runner`. Expect PASS, and no new lint exceptions.
- [ ] **Step 5:** Commit `feat(runner): pace clear and textarea newlines`.

### Task 10: Filling one field, and the terminal prompts

**Files:**

- Create: `apps/runner/src/apply/typeable.ts`, `apps/runner/src/apply/fill.ts`, `apps/runner/src/terminal/ask.ts`
- Test: `apps/runner/src/apply/typeable.spec.ts`, `apps/runner/src/apply/fill.spec.ts`, `apps/runner/src/terminal/ask.spec.ts`

**Interfaces:**

- Consumes: `Pace`, `ReadField`, `TerminalIO`, `AnswerValue`, `BlockReason`.
- Produces:

```ts
export function toTypeable(text: string): string | null;

export interface FillPage {
  locator(selector: string): Locator;
  value(selector: string): Promise<string>; // Patchright inputValue
  checked(selector: string): Promise<boolean>;
  selectedText(selector: string): Promise<string | null>; // <select>'s chosen option text
  /** Waits for the typeahead list to show an option matching `text`, or null after 5 s. */
  suggestion(listSelector: string, text: string): Promise<string | null>;
}
export interface Resume {
  fileName: string;
  windowsPath: string;
}
export type FillResult =
  | { ok: true; changedFromLinkedIn: boolean }
  | {
      ok: false;
      reason: 'not-typeable' | 'no-option' | 'no-suggestion' | 'no-resume';
    };
export function fillField(
  f: ReadField,
  value: AnswerValue,
  ctx: { pace: Pace; page: FillPage; resume: Resume },
): Promise<FillResult>;

export type AuthorReply =
  { kind: 'answer'; value: AnswerValue } | { kind: 'blank' } | { kind: 'stop' };
export function askBlocked(
  io: TerminalIO,
  q: FormQuestion,
  stepTitle: string | null,
  why: string,
): Promise<AuthorReply>;
export function askSave(io: TerminalIO): Promise<boolean>;
```

**Fill rules (from the spec):**

- **Prefilled:** a current value equal to the answer → `pace.glance`, `changedFromLinkedIn: false`. A different non-empty value → `pace.clear`, then fill, `true`.
- **select, radio:** pick by the index of the answer in `question.options`. Not found → `no-option`.
- **checkbox-group:** click to tick what the answer has and to untick what it hasn't.
- **checkbox:** click when the state differs from the answer (`Yes` or `true` means ticked).
- **typeahead:** type, then click the suggestion. No suggestion → `no-suggestion`.
- **file:** if a `resumeChoices` entry has the resume's file name, click it unless it is already selected. Otherwise `pace.upload` on the field with `resume.windowsPath`.

**Prompt rules:**

- `askBlocked` prints the step title, label, type, help text, `why` and the numbered options.
- Choice fields take comma-separated numbers. Text fields take the typed line.
- `b` means blank, accepted only when the question is optional. `s` means stop.
- Invalid input asks again.
- `askSave` asks `Save to the fact bank? [Y/n]`; an empty reply means yes.

- [ ] **Step 1: Failing tests:**
  - `toTypeable`: each mapping in Global Constraints; `é` → null; `\n` kept.
  - `fillField` with fake pace and page: one test per type, plus `prefilled match glances`, `prefilled differs clears and marks changed`, `select option missing → no-option`, `typeahead without suggestion → no-suggestion`, `picks a listed resume with the same name`, `uploads when no listed resume matches`.
  - `askBlocked`: number parsing for radio and checkbox-group, `b` refused on a required question, `s` stops.
  - `askSave`: empty reply means yes.
- [ ] **Step 2:** Run `pnpm nx test runner -- typeable.spec fill.spec ask.spec`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): fill one field and ask the author`.

### Task 11: The walker

**Files:**

- Create: `apps/runner/src/apply/run.ts`, `apps/runner/src/apply/types.ts`
- Test: `apps/runner/src/apply/run.spec.ts`

**Interfaces:**

- Consumes: everything above, plus `answerQuestion` and `AnswerContext` from `@xapply/answerer`, and `classifySession`, `SIGN_IN_FORM` and `CHALLENGE` from `session/classify.ts`.
- Produces:

```ts
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
  result: AnswerResult | null; // null when the answerer wasn't reached
  by: 'bot' | 'author' | 'blank' | 'needs-author';
  filled: AnswerValue | null;
  changedFromLinkedIn: boolean;
  savedAs?: string; // known-answer id
  fillProblem?: Extract<FillResult, { ok: false }>['reason'];
}
export interface ApplyRun {
  jobId: string;
  startedAt: string;
  outcome: ApplyOutcome;
  stop?: {
    kind: SafetyStop | 'bridge';
    step: number | null;
    detail: string;
    pageErrors?: string[];
  };
  job: Job | null;
  questions: QuestionRecord[];
  unknownFields: UnknownField[];
  timings: { totalMs: number; perStepMs: number[] };
}
export interface ApplyPage extends FillPage {
  goto(url: string): Promise<void>;
  path(): string;
  html(): Promise<string>;
  close(): Promise<void>;
}
export interface ApplyDeps {
  openPage(): Promise<ApplyPage>;
  pace(page: ApplyPage): Pace;
  stopReason(): string | null;
  answer(q: FormQuestion, bank: FactBank, job: Job): Promise<AnswerResult>;
  loadBank(): FactBank;
  saveAnswer(
    entry: { question: string; answer: string },
    job: Job,
  ): { ok: true; id: string } | { ok: false; problems: string[] };
  io: TerminalIO | null; // null outside author mode
  resume: Resume;
  now(): number;
  wait(ms: number): Promise<void>;
}
export function runApply(jobId: string, deps: ApplyDeps): Promise<ApplyRun>;
```

**Flow (the spec's "The run, step by step"):**

1. **Load and classify.** `goto(jobViewUrl)`, then classify with `path()` and counts of `SIGN_IN_FORM` and `CHALLENGE` taken from `parsePage(html())`. A security check or captcha → `security-check`; signed out → `signed-out`. Classifying is repeated after every click.
2. **Check the job.** `readJobPage`: `applied` → `already-applied`; no `easyApply` → `not-easy-apply`; no `description` → `unexpected-page`. Build `Job` with `source: 'LinkedIn'`. Then `pace.read(description.length)`, with `pace.maybe('scroll-description')` honoured.
3. **Open the form.** `pace.click` Easy Apply, then poll `html()` every 500 ms for up to 10 s until `readStep` is not `none`. Still `none` → `unexpected-page`.
4. **Each step, up to 3 rounds:**
   1. Read the step. Any `unknown` → `unknown-field`.
   2. Number the new fields `s<step>-q<n>`.
   3. Answer each new field. A backed answer whose text fails `toTypeable` is treated as blocked `not-typeable`.
   4. Blocked, with `io`: `askBlocked`. `stop` → outcome `stopped`. An answer → `filled` from the author; if `askSave`, call `saveAnswer` then `loadBank`. `blank` → `by: 'blank'`.
   5. Blocked, without `io`: an optional question is `blank`; a required one → outcome `needs-author`, ending the run before that field is filled.
   6. A `fillField` failure is handled like a blocked answer, with the reason as `why`.
   7. Re-read the step. New keys → another round. A fourth round needed → `too-many-rounds`.
5. **Advance.** `pace.click(next)`, then poll up to 10 s for a `stepKey` change.
   - `review` → outcome `reached-review`.
   - The same key → `step-did-not-change`, with `pageErrors` = the step's `errors`.
6. **On review.** With `io`, `io.ask('Review page reached. Press Enter to close the window.')`. Then close the page, trying Dismiss and Discard first only if Task 6 showed LinkedIn keeps a draft otherwise.
7. **Stops.** `stopReason()` is checked before every action. A non-null value → outcome `stopped`, stop kind `bridge`. The page is closed in `finally`.

- [ ] **Step 1: Failing tests.** The fake page serves a scripted sequence of fixture HTML (job → step-contact → step-questions → review). The fake pace records calls, and the fake answerer returns a scripted `AnswerResult` per label. Tests:
  - `reaches review and never clicks a submit selector`;
  - `numbers questions s1-q1…`;
  - `not Easy Apply`; `already applied`; `missing description is unexpected-page`;
  - `signed out after load`; `challenge after a click`;
  - `unknown field stops`;
  - `step-did-not-change carries page errors`;
  - `follow-up field after fill is answered in round 2`; `fourth round stops`;
  - `blocked required without io → needs-author, field left unfilled`; `blocked optional without io → blank`;
  - `author answer is filled and saved, savedAs set`; `uses a saved answer later in the same run` (`loadBank` called again; the fake answerer returns backed once the bank has the id);
  - `author stop → stopped`;
  - `not-typeable backed answer goes to the author`;
  - `resumes a part-filled draft` (prefilled values that match are glanced at, not stopped on);
  - `stop mid-step still reports` (`stopReason` becomes non-null between two fills: outcome `stopped`, page closed).
- [ ] **Step 2:** Run `pnpm nx test runner -- run.spec`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): walk an Easy Apply form to the review page`.

### Task 12: Reports

**Files:**

- Create: `apps/runner/src/apply/report.ts`
- Test: `apps/runner/src/apply/report.spec.ts`

**Interfaces:**

- Consumes: `ApplyRun`, `redactResult`, `FactBank`, `REPORTS_DIR`, `pathPrefix`.
- Produces:
  - `formatRunMarkdown(run: ApplyRun, bank: FactBank): string`: one section per step with a table of label | type | answer | by | rests on (quoted bank text) | inferences | note (changed from LinkedIn, saved as id, fill problem). The outcome, stop, page errors and timings come last.
  - `redactApplyRun(run: ApplyRun, bank: FactBank): RedactedApplyRun`: `jobId`, `startedAt`, `outcome`, `stop: { kind, step }` (no detail, no page errors), and per question `{ id, step, type, by, changedFromLinkedIn, savedAs, fillProblem, result: redactResult(...) | null }`. Also `unknownFields` (tag, role and input type only) and timings.
  - `writeApplyReports(run, bank, dirs?: { privateRuns: string; reports: string }): { full: string; redacted: string }`: `<privateRuns>/<startedAt>-<jobId>.md` and `.json`, and `<reports>/apply-<startedAt>.json`. Colons in timestamps are replaced as `writeRunReport` does. The default `privateRuns` is `<repo>/private/runs`.
  - `formatRedactedSummary(r: RedactedApplyRun): string`: the non-author terminal output, made of counts per `by`, the outcome and the stop kind.

- [ ] **Step 1: Failing tests:**
  - `redacted copy holds no label`: build a run whose labels, options, values, page errors and bank texts are distinct marker strings (one being `+44 7700 900123`), then assert `JSON.stringify(redacted)` and `formatRedactedSummary` contain none of them and no 6+ digit run.
  - `markdown has every question and quotes its sources`.
  - `writes three files to the given dirs`.
- [ ] **Step 2:** Run `pnpm nx test runner -- report.spec`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat(runner): full and redacted apply reports`.

### Task 13: The `apply` command

**Files:**

- Create: `apps/runner/src/commands/apply.ts`
- Modify: `apps/runner/src/main.ts`, `apps/runner/package.json` (target `apply`: `tsx --conditions=@xapply/source src/main.ts apply`), `apps/runner/src/bridge/install.ts` (resume copy)
- Test: `apps/runner/src/commands/apply.spec.ts`, `apps/runner/src/bridge/install.spec.ts`

**Interfaces:**

- Consumes: everything above, plus `connectBridge`, `loadProfile`, `createPace`, `loadAnswerConfig`, `createClaudeCliCaller` and `loadFactBank`.
- Produces:
  - `installResume(bankResumePath: string, exec: Exec): Resume`. It copies the PDF to `<windows extension dir>/../resume/<basename>`, overwriting only when the size or modification time differs, and returns the basename and the `wslpath -w` path.
  - `applyCommand(argv: string[], deps?): Promise<number>`.

**Behaviour:**

- Without `--dry-run`: exit 2 with the exact Global Constraints line, before loading anything.
- A bad URL: exit 2.
- Otherwise:
  1. Load the bank. On `FactBankError`, print the problems and exit 2.
  2. Install the resume and connect the bridge. Unavailable → write a report with outcome `bridge-unavailable` and exit 2.
  3. Build `ApplyDeps`: `io` is `nodeTerminal()` only in author mode, `answer` wraps `answerQuestion` with `runDate` as today in `YYYY-MM-DD` and the configured models, and `saveAnswer` wraps `addKnownAnswer` with the job's company and title.
  4. `runApply`, then `writeApplyReports`.
  5. Print `formatRunMarkdown` in author mode, `formatRedactedSummary` otherwise. Then print the redacted report's path, and the full report's path in author mode only.
- Exit 0 on `reached-review`, 2 otherwise. Ctrl+C (SIGINT) makes `stopReason` return `'interrupted'`, so the walker ends cleanly.

- [ ] **Step 1: Failing tests:**
  - `refuses without --dry-run before connecting` (the connect fake is never called);
  - `bad url exits 2`;
  - `non-author mode prints only the redacted summary` (fake `runApply` result with marker strings; assert none is in stdout);
  - `installResume copies once and returns a Windows path` (fake exec, temp dirs).
- [ ] **Step 2:** Run `pnpm nx test runner -- apply.spec install.spec`. Expect FAIL.
- [ ] **Step 3:** Implement. Add `apply` to `USAGE`.
- [ ] **Step 4:** Run `pnpm nx run-many -t lint test typecheck build`. Expect all PASS. Run `pnpm format:check`. Expect clean.
- [ ] **Step 5:** Commit `feat(runner): runner apply --dry-run`.

### Task 14: Live dry runs (author checkpoint) and the PR

- [ ] **Step 1:** Ask the author to run `pnpm nx run runner:apply -- <job-url> --dry-run` (or the root script) from their own terminal on a real Easy Apply job, and to read the full report.
- [ ] **Step 2:** For each run, read the redacted report in `run-reports/`. A safety stop or an unrecognised step means: ask the author to save a snapshot of that page, scrub it, add it as a fixture with a failing reader test, fix, and commit (`fix(runner): …`).
- [ ] **Step 3:** The exit criterion is three runs in a row, on three different jobs, each reaching review with no safety stop, and the author confirming every answer is right. Record the three report file names (redacted ones) in the PR description.
- [ ] **Step 4:** Update the memory note on LinkedIn's page structure with what the fixtures showed (the description selector, the shadow root, step recognition).
- [ ] **Step 5:** `git push -u origin slice-06-walk-the-form` and `gh pr create --base main` with a summary, the exit-criterion evidence and the follow-ups (05b next).
