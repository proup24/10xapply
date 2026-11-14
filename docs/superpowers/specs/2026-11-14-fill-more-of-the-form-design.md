# Slice 07b: Fill more of the form

Date: 2026-11-14
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 07b. Builds on [slice 06](2026-11-12-walk-the-form-design.md) and [slice 07](2026-11-14-submit-never-twice-design.md).

## Intent

Slice 07's real submit worked, but slices 06 and 07 left gaps in the form itself: date fields, multi-select never tried live, an email dropdown that blocked, and a step-1 text box the runner couldn't read. Before Phase 2 turns every stop into a stalled job, the runner should be able to read and fill every ordinary field type LinkedIn's Easy Apply shows.

The author also had to answer many questions at the terminal that they think the bank already covers, mostly about experience and, most recently, expected salary. The author split the work _(user)_. This slice handles **field types and walkthroughs on real forms**, and **records every bank miss** so the next slice (07c) can improve the bank's answers from evidence instead of memory. Improving the answers is not part of this slice.

The slice also changes a guardrail that has held since slice 01. From now on Claude may read the author's personal data under `private/` and edit the fact bank directly _(user: "Going forward you should be able to read my personal data"; "You should be able to edit directly")_.

## Goals

1. **Every ordinary field type fills.** Date fields, multi-select (checkbox group) checked on a live form, the email dropdown, and the step-1 text box from job 4490324628, plus any ordinary type the walkthroughs turn up.
2. **Walkthroughs on real forms.** Dry runs across a fixed set of jobs (see "The walkthrough set") reach the review page with no unfamiliar-field stop.
3. **A misses record.** Every question that goes to the terminal or blocks is saved under `private/` with what 07c needs: the question, the field type, the author's answer and why the bank missed. Each miss is also an eval case.
4. **Claude can read `private/` and edit the bank.** The guard, `CLAUDE.md` and the roadmap change to match.

## Non-goals

- **Better answers from the bank** _(user: moved to 07c)_. That covers experience questions, salary, and the five bank-silent Yes/No questions from slice 06. This slice only records these misses; it doesn't change the answerer, its prompts, or the bank's wording to fix them. The one answerer change is the `date` type and its date-offset math (see "Field types").
- Real submits as part of this slice. The author may submit as usual, but no part of "Done when" needs one.
- More applications, or wider use of the account. The limits on how often Claude runs against LinkedIn stay the same (see "Safety and the guard").
- Phase 2 pieces (database, web app, unattended runs).

## Anti-goals

- **Submitting a wrong or invented answer.** Unchanged from slices 05–07: an answer the bank can't back is asked at the terminal or stops the run. New field types follow the same rule. A date is filled only when the bank backs it.
- **Applying twice.** Nothing in this slice touches the never-twice rules. `applications.json` stays read-only for Claude _(my call: it is the guard against a second application, so a wrong edit there could break it)_.
- **Personal data in git.** Being able to read `private/` doesn't make it committable. Fixtures stay scrubbed, and redacted reports stay redacted.
- **Credentials in Claude's view.** `.env*` stays off-limits. It holds credentials (the bridge token, and later keys), which this slice doesn't need.
- **Using the account more because Claude can now look.** Reading data doesn't change how often LinkedIn is used.

## The walkthrough set

_(user)_

- The three hard-question jobs: 4488500594, 4490505838, 4490356080.
- The two jobs that hit slice 06 gaps: 4490324628 (unreadable step-1 text box) and 4490304984 (email dropdown blocked).
- Saved jobs the author will provide.

A posting that has expired is replaced by another one the author picks.

## How the work goes

_(my call)_

1. **Snapshots first.** The author takes a `runner:snapshot` of each job's form, every step through the review page. Claude runs `snapshot-scrub` and builds support for each missing field type from the scrubbed copies, with unit tests on them as committed fixtures, before anything touches a live form.
2. **Check the scrubber against the raw snapshots.** Now that Claude can read the raw snapshots, it compares each one with its scrubbed copy and fixes anything personal that slips through, including the known miss on `+447700900123`-style phone numbers. No fixture is committed until this check passes for that snapshot.
3. **Dry runs, started by Claude** _(user: "you can start them")_. Claude starts `runner:apply -- <url> --dry-run` on the set when the author asks in that session, a few a day as now, so the set takes several days. The author watches the run window. Claude reads the full run report under `private/runs/` and fixes what went wrong.
   - A run Claude starts is not in author mode, so it never asks at the terminal. The first required question the bank can't back ends it with `needs-author`, and that miss is recorded with answer `stopped`.
   - **Claude then asks the author in chat** for the answer to each such miss, writes it into that miss's entry in `answer-misses.yaml`, and asks whether to save it to the bank as a known answer. That's the same choice the terminal offers. On a yes, Claude adds it and runs `facts-check`. Claude then re-runs the job, which now gets further. That re-run counts toward the few a day _(my call: this keeps misses useful to 07c and lets the hard forms reach the review page without changing author mode)_.
4. **New field types found live** go back to step 1: a snapshot of that form, a fixture, then support for the type.

## Field types

What the runner handles today: `text`, `textarea`, `number`, `select`, `radio`, `checkbox-group`, `checkbox`, `file` (resume) and `typeahead`. What's added or fixed:

- **Date.** A new `date` field type, whether LinkedIn draws it with a calendar picker or as a text box with a date format. Reading picks up the format the field expects. Filling types the date into the box when LinkedIn allows that, else picks it in the calendar through the pace module. Afterwards the runner reads the value back and checks it matches. The answerer gets the type so it can answer with a date. A date counts as backed only when it comes from the bank, directly or by a `math` derivation. The existing `MathSpec` has no date arithmetic, so this slice adds one kind, a date offset (run date + a duration the bank states, such as the notice period for "earliest start date"), checked in code like the other math kinds, with example-set eval cases _(my call: a date type the answerer can't back is almost always a miss, and this is the one answerer change the slice makes)_. A date the bank can't back blocks like any other question.
- **Multi-select (checkbox group).** Already supported in code, but never run on a live form. It must fill and read back correctly on at least one live form in the set. If none of the set has one, the author adds a job that does.
- **Email dropdown** (job 4490304984). A `select` whose options are email addresses is mapped to the bank's email field in code, without the model, like the other simple fields. The option matching the bank's email is picked. If LinkedIn masks the addresses or none matches, it blocks with a clear reason and goes into the misses record. It is never guessed. The snapshot shows what LinkedIn actually lists there.
- **The step-1 text box** (job 4490324628). Slice 06 found an `input type=text` with no role that the form reader rejected, either for lack of a label or for lack of a unique selector. The snapshot decides which. The fix follows from that, and it may turn out to be a date box.
- **Anything else the walkthroughs turn up.** An ordinary control, meaning a standard input or a common LinkedIn widget with a readable label, gets added here. An odd one stays an `unknown-field` safety stop and goes on a list in the PR for a later slice. The safety stop itself never changes: a field the runner can't read still ends the run without submitting.

## The misses record

A **miss** is any question the bank didn't answer with a backed answer in a run. That covers every question that goes to `askBlocked` at the terminal, and every one that stops a run outside author mode with `needs-author`. Optional fields left blank because the bank had nothing count too, since the author may want them answered later.

**Where:** `private/answer-misses.yaml`, one entry appended per miss, written atomically as `applications.json` is _(my call)_.

**Each entry holds** _(user: "the question, the field type, my answer, and why the bank missed")_:

- the job id and the run's start time;
- the question as the runner read it: label, field type, options, required, help text;
- the author's answer as typed, or `blank` or `stopped` when they gave none;
- why the bank missed: the answerer's `BlockReason` (`bank-silent`, `no-story-fits`, `boundary`, `check-failed`, `verifier-rejected`, `unsupported-field`, `model-error`) and its `detail`, plus the bank sources it cited, if any;
- `savedAs`: the known-answer id when the author saved the answer to the bank at the terminal, else null.

**Each miss is an eval case.** The file is in the answerer's golden format, with one case per miss _(my call)_:

- **Choice and number types** (`select`, `radio`, `checkbox`, `checkbox-group`, `number`, `date`): `expect: { status: backed, value: <the author's answer> }`, scored by exact match as now.
- **Free-text types** (`text`, `textarea`, `typeahead`): `expect: { status: backed }` only. The author's answer is kept beside the case as `reference`, not scored, because a newly composed answer will almost never match what was typed word for word. 07c decides whether text cases need the judge or another check.

A miss with no answer (`blank` or `stopped`) has no expectation and is skipped by the eval. `answers-eval` gains `--set misses` to run it against the current bank. 07c starts by running that set, sees what fails, and fixes until it passes.

The job's details (title, company, description) go into the file once per job, under the golden format's `jobs`, so a case is answered with the same context it had in the run.

**A note for 07c:** a miss whose answer was saved at the terminal becomes a known answer, so its case will pass as long as the saved answer is in the bank. That's expected. `savedAs` lets 07c tell "the bank had nothing" apart from "the bank had it and the answerer missed it". The second kind is what the author reported.

Terminal saves keep working as in slice 07. The misses record is written whether or not the author saves.

## Claude and the author's data

_(user, apart from the points marked as my call)_

- **Read:** everything under `private/`. That covers the fact bank, `disqualify.yaml`, `applications.json`, full run reports (`runs/`), raw snapshots, the private golden set, `answers-eval` results and the misses record.
- **Write:** `fact-bank.yaml`, `disqualify.yaml`, `answer-golden.yaml` and `answer-misses.yaml`, and anything else under `private/` the runner itself writes, except `applications.json`. After each bank or rules edit, Claude runs `facts-check` and tells the author what changed _(my call)_.
- **Read-only:** `applications.json` _(my call, see Anti-goals)_. Clearing an entry stays with the author.
- **Still blocked:** `.env*` (except `.env.example`), committing anything under `private/`, and logging cookies.
- **Private eval:** Claude may run `answers-eval -- --set private` and `--set misses`, so the guard's block on the `private` token in commands goes.

## Safety and the guard

- **`guard.mjs` changes.** File tools may read and write under `private/`, but Edit and Write are blocked on `applications.json`. Bash commands may name `private/` paths, but a command that names `applications.json` is allowed only with a read-only tool (`cat`, `jq`, `head` and the like); the exact allow list is left to the builder. `.env*` rules stay as they are. Tests in `guard.test.mjs` cover each change, including the `applications.json` write block through Edit, Write and Bash redirection.
- **Guard false positive.** A `node -e '…' $f` command was blocked as a runner launch when the command named `apps/runner` elsewhere, and so was any command with a path through `pace-recordings/runner/` (the known false positive in `CLAUDE.md`). The runner-launch rule should match only a launch (`nx run runner:…`, `nx runner`, a runner binary), not a path that contains the word. Both false positives get regression tests, and the `CLAUDE.md` note goes once they're fixed.
- **Unchanged:** the runner-launch rule itself. Claude starts only `--dry-run` runs, only when the author asks in that session, and only a few a day. Real submits stay the author's until slice 14. `runner:session` and `runner:snapshot` still need the author's ask.
- **Author mode** is unchanged: outside it, the runner's terminal output stays redacted. Redacted reports in `run-reports/` stay. Claude can now read the full ones, but the redacted copy is still the one meant for anything shared.

## Docs that change

- **`CLAUDE.md`, Guardrails and Running against LinkedIn:** replace "Claude never reads" for the bank, rules, record, raw snapshots and `runs/` with the new read and write rules; drop "the author runs the private set" and the `private`-token block; add `answer-misses.yaml` and `--set misses`; remove the false-positive note once it's fixed.
- **Roadmap, locked decisions:** "Who may run things against the real LinkedIn account" gains a line saying that from slice 07b Claude may read `private/` and edit the bank (not `applications.json`), while the limits on runs stay as they are until slice 14. Phase 0–1's "Claude debugs from redacted reports" note is updated to match.
- **Roadmap, slice 07b:** "Spec answers" points to this spec. The first bullet of its scope (bank misses) moves to a new **07c Better answers from the bank** entry, which depends on 07b, with the scope _(user)_: experience questions, salary, bank-silent Yes/No, starting from the misses set. The Phase 1 slice table and dependency line gain 07c, and slice 14 depends on 07c instead of 07 _(my call: the unattended runner would otherwise stall on the misses 07c fixes)_.

## Done when

- **Every job in the walkthrough set** reaches the review page in a dry run with no `unknown-field` stop, and the author confirms every filled field looks right. Getting there may take several runs per job, each stopping on a recorded miss the author then answers in chat (see "How the work goes").
- At least one live dry run fills a date field and one fills a multi-select, both read back correctly. If the set has neither, the author adds a job that does.
- Job 4490304984's email dropdown fills from the bank (or blocks with a clear reason if LinkedIn masks the addresses, and the author agrees that's right). Job 4490324628 gets past step 1.
- `answer-misses.yaml` holds an entry for every miss in those runs, and `answers-eval -- --set misses` runs on it.
- Guard tests pass for every rule change and both false positives. `CLAUDE.md` and the roadmap are updated.
- Every committed fixture passed the raw-against-scrubbed check.
- Lint, tests, build and typecheck pass in CI.

## Where the code goes

- `libs/answerer/src/types.ts`: `date` in `FIELD_TYPES`, plus its checks (format, backed by a source or `math`).
- `apps/runner/src/linkedin/form-step.ts`: reading dates, the email dropdown's options, the step-1 box fix, and new types from the walkthroughs.
- `apps/runner/src/apply/fill.ts`: filling and reading back the new types, always through the pace module.
- `apps/runner/src/apply/step.ts`: writing a miss wherever a question goes to `askBlocked`, blocks with `needs-author`, or is left blank.
- `apps/runner/src/apply/misses.ts` (new): the record's schema, its atomic append, and converting a miss to a golden case.
- `apps/runner/src/commands/answers.ts`: `--set misses`.
- `apps/runner/src/snapshot/`: scrubber fixes from the raw-against-scrubbed check.
- `.claude/hooks/guard.mjs` and `guard.test.mjs`: the rule changes and the false-positive fix.
- `CLAUDE.md` and `docs/roadmap/README.md`.

## Left to the builder

- The exact `answer-misses.yaml` layout within the golden format, and how the eval skips cases with no answer.
- How a date's format is read from the field, and when to type the date rather than use the calendar.
- How `--set misses` reports (ids and counts, like `--set private`), and where it writes full results.
- The exact allow list of read-only Bash tools for `applications.json`.
- Splitting the work into more than one PR, if it's large (for example, the guard and docs first, then field types and misses).
