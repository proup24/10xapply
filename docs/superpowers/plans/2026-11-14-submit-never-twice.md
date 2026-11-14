# Submit, and Never Twice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `runner apply <job-url>` without `--dry-run` submits the Easy Apply form on its own once it's filled, confirms that LinkedIn shows the job as Applied, and keeps a local record that makes sure no job is ever applied to twice.

**Architecture:** A new `apps/runner/src/apply/record.ts` holds the record file (`private/applications.json`): a zod schema, pure status-change functions and an atomic file store. `runApply` gets the store and a `submit` flag through `ApplyDeps`. It consults the record before opening a window, settles a leftover `submitting` from the job page's Applied marker, and on the review page writes `submitting`, clicks Submit, closes LinkedIn's "application sent" dialog, and reloads the job page to confirm Applied. `applyCommand` drops the `--dry-run` requirement, refuses a real run outside author mode, and prints one closing line.

**Tech Stack:** Nx 24, pnpm, TypeScript (nodenext, strict), Vitest, zod ^4 (already used by the libs; new to the runner), linkedom fixtures, Patchright through the pace module.

**Spec:** `docs/superpowers/specs/2026-11-14-submit-never-twice-design.md`

## Global Constraints

- Branch `slice-07-submit`, created from `origin/main` (8d01969). Never work on `main`. Leave the unrelated local change to `.claude/settings.json` uncommitted.
- **Never name the private folder in a Bash command or a commit message.** The guard blocks it. Claude never reads `applications.json`, the bank, the rules or full reports. Claude may read `run-reports/` and `snapshots/`.
- Claude never starts `runner:apply` without `--dry-run` (the guard blocks it). The author runs every real submit. Claude starts a `--dry-run` against a real job only when the author asks in that session.
- Only the pace module acts on a page. The Submit click is `pace.click`, like any other.
- Statuses: `submitting` | `applied` | `disqualified` | `failed`. `source` (applied only): `submit` | `linkedin-marker`. `reason`: `submit-unconfirmed` for `failed`; `<claim kind>:<countries comma-joined, or "unclear">` for `disqualified`. Never page text or bank text in the record.
- The record is written before the Submit click, flushed to disk (fsync, then rename). If that write fails, Submit is never clicked.
- Submit is clicked at most once per run.
- No typed confirmation before Submit _(user)_.
- A run without `--dry-run` outside author mode exits 2 before a window opens.
- Redacted outputs never hold a label, a value or a quote. Job ids, statuses, `via` and timings may appear in them.

## Review Focus

1. **Ctrl+C or a lost bridge after the Submit click, before Applied is seen.** Expect outcome `stopped`, the record left at `submitting`, and no Dismiss or Discard pressed on whatever dialog is up. Test in Task 4 (`a stop after the Submit click leaves submitting and presses nothing more`).
2. **A stop after `submitting` is written but before the click lands** (the guarded pace throws). Expect the record left at `submitting` and no Submit click. The next run then settles it to `failed` from the missing marker. Test in Task 4 (`a stop between the record write and the click leaves submitting, no click`).
3. **LinkedIn shows Applied on the reload, but its "application sent" dialog never showed** (closed by LinkedIn, or a different layout). Expect `submitted`, not `submit-unconfirmed`. Test in Task 4 (`no dialog but the marker on reload is submitted`).
4. **The Submit click leaves the review page in place** (a validation error, a slow network). Expect no second click, outcome `submit-unconfirmed` and record `failed`. Test in Task 4 (`a review page that stays after Submit is never clicked twice`).
5. **The final `applied` write fails after a confirmed submit.** Expect outcome `submitted`, `record.after` `submitting`, and a closing line saying the next run settles it. Never a crash that hides that the submit went through. Test in Task 4 (`an applied write that fails still reports submitted`).

---

### Task 1: Branch, spec and the record module

**Files:**

- Create: `apps/runner/src/apply/record.ts`
- Test: `apps/runner/src/apply/record.spec.ts`
- Modify: `apps/runner/package.json` (add `"zod": "^4"` to `dependencies`, matching the libs' version), `pnpm-lock.yaml`

**Interfaces:**

- Produces:

  ```ts
  export type JobStatus = 'submitting' | 'applied' | 'disqualified' | 'failed';
  export interface StatusChange {
    status: JobStatus;
    source?: 'submit' | 'linkedin-marker'; // applied only
    reason?: string; // failed and disqualified only
  }
  export interface HistoryEvent extends StatusChange {
    at: string;
    runStartedAt: string;
  }
  export interface JobEntry extends StatusChange {
    updatedAt: string;
    history: HistoryEvent[];
  }
  export interface JobRecord {
    version: 1;
    jobs: Record<string, JobEntry>;
  }
  export class RecordError extends Error {} // file unreadable or fails the schema
  export const DEFAULT_RECORD_PATH: string; // <repo root>/private/applications.json
  export function parseRecord(text: string): JobRecord; // throws RecordError
  export function withChange(
    r: JobRecord,
    jobId: string,
    c: StatusChange,
    at: string,
    runStartedAt: string,
  ): JobRecord; // pure
  export type StartDecision =
    'go' | 'refuse-applied' | 'refuse-disqualified' | 'settle-leftover';
  export function startDecision(
    entry: JobEntry | null,
    dryRun: boolean,
  ): StartDecision;
  export function disqualifiedReason(c: {
    kind: string;
    countries: string[];
  }): string;
  export interface RecordStore {
    get(jobId: string): JobEntry | null; // re-reads the file every call
    set(jobId: string, c: StatusChange, runStartedAt: string): JobEntry; // re-read, change, atomic write
  }
  export function openRecord(path?: string, now?: () => Date): RecordStore; // throws RecordError on a bad file; a missing file is empty
  ```

- [ ] **Step 1: Branch and commit the spec**

```bash
git fetch origin && git switch -c slice-07-submit origin/main
git add docs/superpowers/specs/2026-11-14-submit-never-twice-design.md docs/superpowers/plans/2026-11-14-submit-never-twice.md
git commit -m "docs: slice 07 spec and plan"
```

- [ ] **Step 2: Write the failing tests** in `record.spec.ts`. Each `openRecord` test uses its own `mkdtempSync` directory.

```ts
it('a missing file is an empty record', () => { expect(openRecord(join(dir, 'a.json')).get('1')).toBeNull(); });
it('a file that is not JSON is a RecordError', () => { /* write '{' */ expect(() => openRecord(p)).toThrow(RecordError); });
it('a file that fails the schema is a RecordError', () => { /* {"version":2,"jobs":{}} and {"version":1,"jobs":{"abc":…}} */ });
it('a job id key must be digits', ...);
it('set writes status, updatedAt and appends history with runStartedAt', () => {
  const s = openRecord(p, () => new Date('2026-11-14T10:00:00.000Z'));
  s.set('42', { status: 'submitting' }, '2026-11-14T09:58:00.000Z');
  const e = s.set('42', { status: 'applied', source: 'submit' }, '2026-11-14T09:58:00.000Z');
  expect(e).toMatchObject({ status: 'applied', source: 'submit', updatedAt: '2026-11-14T10:00:00.000Z' });
  expect(e.history.map((h) => h.status)).toEqual(['submitting', 'applied']);
  expect(parseRecord(readFileSync(p, 'utf8')).jobs['42']?.status).toBe('applied');
});
it('a later status drops a stale source or reason', () => { /* failed{reason} then applied{source} → no reason key */ });
it('set re-reads the file, so another writer’s change is kept', () => { /* two stores on one path, both set different ids; both present */ });
it('set leaves no temp file behind', () => { expect(readdirSync(dir)).toEqual(['a.json']); });
it.each([
  [null, false, 'go'], [null, true, 'go'],
  ['failed', false, 'go'], ['failed', true, 'go'],
  ['applied', false, 'refuse-applied'], ['applied', true, 'refuse-applied'],
  ['disqualified', false, 'refuse-disqualified'], ['disqualified', true, 'refuse-disqualified'],
  ['submitting', false, 'settle-leftover'], ['submitting', true, 'go'],
])('startDecision(%s, dryRun %s) is %s', ...);
it('disqualifiedReason', () => {
  expect(disqualifiedReason({ kind: 'requires-location', countries: ['DE'] })).toBe('requires-location:DE');
  expect(disqualifiedReason({ kind: 'requires-authorization', countries: ['US', 'CA'] })).toBe('requires-authorization:US,CA');
  expect(disqualifiedReason({ kind: 'no-sponsorship', countries: [] })).toBe('no-sponsorship:unclear');
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm nx test runner -- record.spec`
Expected: FAIL, `record.js` not found.

- [ ] **Step 4: Implement `record.ts`**

Schema: zod `strictObject`, keys `/^\d+$/`, ISO timestamps as strings. The atomic write goes to `<path>.<pid>.tmp` with `openSync`/`writeSync`/`fsyncSync`/`closeSync`, then `renameSync`. `DEFAULT_RECORD_PATH` is resolved like `snapshot/paths.ts`'s `REPO_ROOT`. Create the parent folder with `mkdirSync({ recursive: true })` on the first write. `withChange` keeps `source` only for `applied` and `reason` only for `failed` and `disqualified`.

- [ ] **Step 5: Run the tests**

Run: `pnpm nx test runner -- record.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runner/src/apply/record.ts apps/runner/src/apply/record.spec.ts apps/runner/package.json pnpm-lock.yaml
git commit -m "feat(runner): the applied-jobs record"
```

---

### Task 2: The record at the start of a run

**Files:**

- Modify: `apps/runner/src/apply/types.ts`, `apps/runner/src/apply/run.ts`, `apps/runner/src/apply/check.ts` (`judge`)
- Test: `apps/runner/src/apply/run.spec.ts`

**Interfaces:**

- Consumes: `RecordStore`, `startDecision`, `disqualifiedReason`, `JobStatus` (Task 1).
- Produces:
  - `ApplyDeps` gains `record: RecordStore | null` (null: a dry run whose record didn't load; no reads, no writes) and `submit: boolean` (false for `--dry-run`).
  - `ApplyOutcome` gains `'submitted' | 'submit-unconfirmed'`. `SafetyStop` gains `'record-changed'`.
  - `ApplyRun` gains `via: 'record' | 'linkedin' | null` (set for `already-applied` and `disqualified`, null otherwise), `record: { before: JobStatus | null; beforeAt: string | null; after: JobStatus | null }`, and `timings.submit: { clickToSentMs: number | null; sentToMarkerMs: number | null } | null`.
  - `run.ts` exports `LEFTOVER_RECHECK_MS = 10_000`.

- [ ] **Step 1: Extend the harness.** `Setup` gains `record?: Record<string, JobEntry>` (the initial entries; `null` value meaning a `record: null` dep), `submit?: boolean` (default false), `setFails?: JobStatus` (that `set` throws), and `onSet?: (jobId, change) => void`. The harness gives `deps.record` an in-memory `RecordStore` and returns `sets: { jobId: string; change: StatusChange }[]`, `waits(): number[]` (every `deps.wait` argument) and `order(): string[]` (record sets as `set <status>`, pace clicks as `click <sel>` and navigations as `goto`, interleaved in call order). Screens gain `job2` for a second `goto` (the reload). A screen's `on` key `'goto'` moves to the named screen on the next `goto`.

- [ ] **Step 2: Write the failing tests** (in a new `describe('the record at the start')`)

```ts
it('applied in the record: refused before a window opens', async () => {
  const h = harness({ screens: fullFlow(), record: { '123': entry('applied') } });
  const run = await runApply('123', h.deps);
  expect(run).toMatchObject({ outcome: 'already-applied', via: 'record', record: { before: 'applied', after: 'applied' } });
  expect(h.calls).toEqual([]); // no goto, no page opened
});
it('disqualified in the record: refused before a window opens, also in a dry run', ...);
it('a marker on a job the record does not know is recorded applied from linkedin-marker', async () => {
  const h = harness({ screens: { job: { html: fixture('job-applied.html') } } });
  const run = await runApply('123', h.deps);
  expect(run).toMatchObject({ outcome: 'already-applied', via: 'linkedin', record: { before: null, after: 'applied' } });
  expect(h.sets).toEqual([{ jobId: '123', change: { status: 'applied', source: 'linkedin-marker' } }]);
  expect(h.acts()).toEqual([]);
});
it('a dry run records the marker too', ...);
it('a job-page disqualification is recorded with its reason', async () => {
  // jobClaims: requires-location DE (rules locate the user elsewhere, as in the existing check tests)
  expect(h.sets).toEqual([{ jobId: '123', change: { status: 'disqualified', reason: 'requires-location:DE' } }]);
});
it('a form-step disqualification is recorded too', ...);
it('a record set that throws on disqualified still ends disqualified', ...); // record.after stays the before
it('failed in the record walks the form as usual', ...);
it('a null record (dry run) reads and writes nothing', ...);
describe('a leftover submitting', () => {
  it('with the marker: applied from linkedin-marker, form never opened', ...);
  it('without the marker: one reload after LEFTOVER_RECHECK_MS, then failed submit-unconfirmed, form never opened', async () => {
    const h = harness({ submit: true, screens: { job: { html: JOB } }, record: { '123': entry('submitting') } });
    const run = await runApply('123', h.deps);
    expect(run.outcome).toBe('submit-unconfirmed');
    expect(h.calls.filter((c) => c.op === 'goto')).toHaveLength(2);
    expect(h.waits()).toContain(LEFTOVER_RECHECK_MS);
    expect(h.sets).toEqual([{ jobId: '123', change: { status: 'failed', reason: 'submit-unconfirmed' } }]);
    expect(h.acts()).not.toContain(`click ${EASY_APPLY}`);
  });
  it('the marker on the reload: applied', ...);
  it('a dry run walks it and writes nothing', ...);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm nx test runner -- run.spec`
Expected: the new tests FAIL. The existing ones still pass once the harness defaults `submit: false` and `record` to an empty store.

- [ ] **Step 4: Implement it**

In `runApply`: after `loadBank`, and before `openPage`, read `deps.record?.get(jobId)` into `run.record.before`/`beforeAt` and act on `startDecision`. A refusal throws `RunEnd` with `via: 'record'` set on the run. `openJob` takes the decision. With `settle-leftover`, after `settleJobPage`, a marker records applied. With no marker, it waits `LEFTOVER_RECHECK_MS`, does a `goto` and settles again, then records applied or failed, and ends without the Easy Apply click. Any marker found in `openJob` writes `{ applied, linkedin-marker }` before `RunEnd('already-applied')`. `judge` takes an `onDisqualified(reasons)` callback, so `run.ts` writes `{ disqualified, disqualifiedReason(reasons[0]) }` at either checkpoint. Every `set` goes through one helper, `record(w, change)`. It catches a throw, keeps `run.record.after` unchanged, and returns false. `run.record.after` is updated on success.

- [ ] **Step 5: Run the tests**

Run: `pnpm nx test runner -- run.spec`
Expected: PASS, the never-Submit `afterEach` included.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(runner): consult and update the record at the start of a run"
```

---

### Task 3: Readers for the Submit button and the "application sent" dialog

**Files:**

- Modify: `apps/runner/src/linkedin/types.ts`, `apps/runner/src/linkedin/form-step.ts`, `apps/runner/src/linkedin/selectors.ts`
- Create: `apps/runner/src/linkedin/sent.ts`
- Test: `apps/runner/src/linkedin/form-step.spec.ts`, `apps/runner/src/linkedin/sent.spec.ts`

**Interfaces:**

- Produces:
  - The review `StepRead` gains `submit: string | null`: a selector for the one Submit button inside the form dialog, or null when there are none or several.
  - `sent.ts`: `export function readSent(doc: Document): { close: string } | { close: null } | null`. Null means no "application sent" dialog. Otherwise the dialog is up, and `close` is a selector for its Dismiss button (`aria-label="Dismiss"` inside the dialog holding the "Your application was sent" heading), or null when it can't be pinned to one element.
  - `selectors.ts` exports `SENT_DIALOG` (that dialog's selector), so `within` can use it.

- [ ] **Step 1: Write the failing tests**

```ts
// form-step.spec.ts
it.each(['review.html', 'review-one-page.html', 'review-save-prompt.html'])('%s: submit is one button reading submit', (f) => {
  const r = readStep(docOf(fixture(f)));
  if (r.kind !== 'review') throw new Error('not review');
  expect(r.submit).not.toBeNull();
  const els = all(docOf(fixture(f)), r.submit!);
  expect(els).toHaveLength(1);
  expect(textOf(els[0]!) + (els[0]!.getAttribute('aria-label') ?? '')).toMatch(/submit/i);
});
it('two submit buttons give submit null', ...); // synthetic dialog

// sent.spec.ts
it('job-applied.html: the sent dialog with its Dismiss', () => {
  const s = readSent(docOf(fixture('job-applied.html')));
  expect(s?.close).not.toBeNull();
  expect(all(doc, s!.close!)).toHaveLength(1);
  expect(all(doc, s!.close!)[0]!.getAttribute('aria-label')).toBe('Dismiss');
});
it.each(['job-page.html', 'review.html', 'step-contact.html'])('%s: no sent dialog', ...);
it('never picks the Premium banner’s Dismiss', ...); // job-applied.html has "Dismiss Job search smarter with Premium"
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm nx test runner -- form-step.spec sent.spec`
Expected: FAIL.

- [ ] **Step 3: Implement it.** Prefer an id-free stable selector (`[data-test-modal-close-btn]` scoped to the dialog by `aria-labelledby`, as `job-applied.html` shows), and fall back to `byId`, as the other readers do.

- [ ] **Step 4: Run the tests**

Run: `pnpm nx test runner -- form-step.spec sent.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(runner): read the Submit button and the application-sent dialog"
```

---

### Task 4: The submit step

**Files:**

- Modify: `apps/runner/src/apply/run.ts`
- Test: `apps/runner/src/apply/run.spec.ts`

**Interfaces:**

- Consumes: the review `submit` selector, `readSent`, `SENT_DIALOG` (Task 3); `record` helper and the new `ApplyRun` fields (Task 2).
- Produces: `run.ts` exports `SENT_WAIT_MS = 15_000` and `MARKER_WAIT_MS = 10_000`.

- [ ] **Step 1: Narrow the never-Submit `afterEach`.** `submitHits` stays empty for every test that doesn't set `submit: true`. Tests with `submit: true` assert their own Submit clicks: exactly one, or none.

- [ ] **Step 2: Write the failing tests** (`describe('submitting')`, all with `submit: true`)

```ts
it('writes submitting, clicks Submit once, closes the sent dialog, confirms the marker, records applied', async () => {
  // review screen's submit selector → 'sent' screen (job-applied.html); 'goto' then → job-applied.html
  const run = await runApply('123', h.deps);
  expect(run.outcome).toBe('submitted');
  expect(h.sets.map((s) => s.change)).toEqual([{ status: 'submitting' }, { status: 'applied', source: 'submit' }]);
  expect(h.order()).toEqual(['set submitting', `click ${SUBMIT_SEL}`, `click ${SENT_CLOSE}`, 'goto', 'set applied']);
  expect(run.timings.submit).toEqual({ clickToSentMs: expect.any(Number), sentToMarkerMs: expect.any(Number) });
  expect(h.acts()).not.toContain(`click ${DISMISS}`); // no form close-out after a submit
  expect(h.closed()).toBe(true);
});
it('a one-page form fills its fields, then submits', ...);
it('a failed submitting write: no Submit click, safety-stop', ...); // setFails: 'submitting'
it('a record changed since the start: no Submit click, safety-stop record-changed', ...); // onSet / external write before review
it('a review with no single Submit button is unexpected-page, no click', ...);
it('no dialog but the marker on reload is submitted', ...);                              // Review Focus 3
it('no marker within MARKER_WAIT_MS: one more reload, then failed submit-unconfirmed', ...);
it('a review page that stays after Submit is never clicked twice', ...);                 // Review Focus 4
it('a stop after the Submit click leaves submitting and presses nothing more', ...);     // Review Focus 1
it('a stop between the record write and the click leaves submitting, no click', ...);    // Review Focus 2
it('an applied write that fails still reports submitted', ...);                         // Review Focus 5: record.after 'submitting'
it('a dry run on review never writes submitting and never clicks Submit', ...);
it('in author mode a submitted run asks no Enter before closing', ...);
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm nx test runner -- run.spec`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement `submitForm(w, review)` in `run.ts`**, called from `runApply` after `walkForm` when `deps.submit`, with the last review read:

1. No `review.submit` → `safety('unexpected-page', 'no single Submit button')`.
2. Re-read the record. If it differs from `run.record.before`/`beforeAt` → `safety('record-changed', …)`.
3. `record(w, { status: 'submitting' })`. If false → `safety('unexpected-page', 'could not write the record')`. Use a new detail string, not a new kind.
4. Set `w.submitClicked = true` _before_ `pace.click(page.locator(review.submit), { within: FORM_DIALOG })`. `closeOut` skips `dismissAndDiscard` and the Enter prompts whenever `submitClicked` is set.
5. Poll `readSent` every `POLL_MS` for up to `SENT_WAIT_MS`. If it shows and has a `close`, click it within `SENT_DIALOG`.
6. `goto(jobViewUrl)` and `settleJobPage(w, MARKER_WAIT_MS)`. With no marker, wait `LEFTOVER_RECHECK_MS`, `goto` and settle once more.
7. Marker → `record(w, { applied, submit })`, outcome `submitted`. Otherwise → `record(w, { failed, submit-unconfirmed })`, outcome `submit-unconfirmed`.

`walkForm` returns the final review read, so `submitForm` can use it.

- [ ] **Step 5: Run the tests**

Run: `pnpm nx test runner -- run.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(runner): submit, confirm Applied and record it"
```

---

### Task 5: The command, the reports and the closing line

**Files:**

- Modify: `apps/runner/src/commands/apply.ts`, `apps/runner/src/apply/report.ts`, `apps/runner/src/main.ts` (usage line)
- Test: `apps/runner/src/commands/apply.spec.ts`, `apps/runner/src/apply/report.spec.ts`

**Interfaces:**

- Consumes: `openRecord`, `RecordError`, `DEFAULT_RECORD_PATH` (Task 1); the new `ApplyRun` fields (Tasks 2 and 4).
- Produces:
  - `ApplyCommandDeps` gains `recordPath: string` and `openRecord: (path: string) => RecordStore`.
  - `report.ts` exports `closingLine(run: ApplyRun): string`. `RedactedApplyRun` gains `via`, `record` and `timings.submit`.
  - `apply.ts` exports `NOT_AUTHOR = 'apply: a real submit runs only from your own terminal; use --dry-run here'` and `BAD_RECORD = 'apply: the applications record did not load; fix or move it first'`. `NO_DRY_RUN` is removed.

- [ ] **Step 1: Write the failing tests**

```ts
// apply.spec.ts (replaces 'refuses without --dry-run before connecting')
it('without --dry-run outside author mode exits 2 before connecting', async () => { /* out == [NOT_AUTHOR], connect never called */ });
it('without --dry-run in author mode runs with submit true', ...);
it('--dry-run passes submit false', ...);
it('a bad record stops a real run before connecting', ...);           // openRecord throws RecordError → BAD_RECORD, exit 2
it('a bad record lets a dry run go ahead with record null', ...);
it('exits 0 on submitted and reached-review, 2 otherwise', ...);
it('prints the closing line in both modes', ...);

// report.spec.ts
it.each([
  [{ outcome: 'submitted', record: { after: 'applied' } }, 'submitted; LinkedIn shows Applied'],
  [{ outcome: 'submitted', record: { after: 'submitting' } }, 'submitted; LinkedIn shows Applied, but the record was not updated; the next run settles it'],
  [{ outcome: 'already-applied', via: 'record', record: { beforeAt: '2026-11-14T10:00:00.000Z' } }, 'already applied (record, 2026-11-14); not opened'],
  [{ outcome: 'already-applied', via: 'linkedin' }, 'LinkedIn shows Applied; recorded'],
  [{ outcome: 'disqualified', via: 'record', record: { beforeAt: '2026-11-13T…' } }, 'disqualified earlier (record, 2026-11-13); not retried'],
  [{ outcome: 'submit-unconfirmed', record: { before: 'submitting' } }, 'previous submit unconfirmed; marked failed; run again to apply'],
  [{ outcome: 'submit-unconfirmed', record: { before: null } }, 'Submit clicked but LinkedIn does not show Applied; marked failed. Check the job on LinkedIn before running again'],
])('closingLine %#', ...);
it('the redacted report carries via, record and submit timings and no label', ...);
it('verdict: submitted is pass', ...);
```

Every other outcome's closing line is the builder's, kept to fixed words.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm nx test runner -- apply.spec report.spec`
Expected: FAIL.

- [ ] **Step 3: Implement it.** In `applyCommand`, the order is: parse the URL, the author-mode refusal, then bank, rules, resume (as today), then `openRecord`. The other fields go into `runApply`'s deps. The closing line is printed after the summary in both modes. The exit code is 0 for `submitted` and `reached-review`. Update the `main.ts` usage line to `apply <job-url> [--dry-run]   fill an Easy Apply form and submit it; --dry-run stops at review`.

- [ ] **Step 4: Run all checks**

Run: `pnpm nx run-many -t lint test build typecheck -p runner`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(runner): apply submits from the author's terminal; closing line"
```

---

### Task 6: Docs, the author's snapshot, the PR and the two real submits

**Files:**

- Modify: `CLAUDE.md`, `docs/roadmap/README.md`, `apps/runner/src/apply/fixtures/README.md` (and a new fixture)

- [ ] **Step 1: Update `CLAUDE.md`**
  - The `runner:apply` line: without `--dry-run` it fills and submits, only from the author's own terminal (author mode), and it consults the record. With `--dry-run` it is as before.
  - Delete the line "From slice 07, a real submit also asks for a typed confirmation…". In its place: "Slice 14 relaxes the guard's runner rule and the author-mode-only submit when the runner goes unattended."
  - Guardrails: "The applied-jobs record is `applications.json` in the private folder. The runner writes it; Claude never reads it. Clear an entry by editing it by hand (the web app later)."

- [ ] **Step 2: Update the roadmap.** Slice 07 gets a `Spec:` line and "Spec answers: settled in the spec", with a one-sentence summary: record file and statuses; leftover `submitting` settled from the marker, else `failed`, retried by the next run; no typed confirmation. Slice 14's scope no longer mentions removing a prompt.

- [ ] **Step 3: Commit**

```bash
git commit -am "docs: CLAUDE.md and roadmap for slice 07"
```

- [ ] **Step 4: Checkpoint: the author's post-Submit snapshot.** Ask the author to apply by hand to one job they want, with `pnpm nx run runner:snapshot -- <job-url>` running, and to press Enter on the "application sent" dialog and again on the job page after it. Then run `pnpm nx run runner:snapshot-scrub`. Read the scrubbed copies in `snapshots/` for personal data and commit them as `sent-dialog-2.html` and `job-applied-2.html`, with README rows. Add both to the `readSent` and `readJobPage` applied tests. If either reader fails on them, fix it before going on. **Do not open the PR before this step is done.**

- [ ] **Step 5: Verify, push and open the PR**

Run: `pnpm lint && pnpm test && pnpm build && pnpm typecheck && pnpm format:check`
Expected: all pass. Then `git push -u origin slice-07-submit` and `gh pr create --base main` with a summary, the test plan, and the line from the attribution reminder.

- [ ] **Step 6: The author's two real submits** (the spec's Done-when). The author runs `pnpm nx run runner:apply -- 'https://www.linkedin.com/jobs/view/<id>/'` from their own terminal on two Easy Apply jobs of their choice, picked so the dry run already handles them. For each:
  - The run ends `submitted` and LinkedIn shows Applied.
  - Running the same command again prints `already applied (record, …); not opened`.

  Claude reads the redacted reports in `run-reports/` and records the results (job ids and outcomes) in the PR. It saves a memory note for the slice.
