# Slice 06: Walk the form without submitting

Date: 2026-11-12
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 06.

## Intent

The author gives the runner one LinkedIn job URL with `--dry-run`. A run window in the author's everyday Chrome opens the job, opens the Easy Apply form, answers every question through the slice 05 answerer, fills the answers in at human pace and stops on the review page. It never presses Submit.

The point of the dry run is the answers _(user: "All I care about is the bot answers to the form fields")_. The browser is how the run gets to them. The author reads the report to decide whether the bot can be trusted to submit, which slice 07 turns on.

When a question blocks, the run asks the author in the terminal and carries on, so the author sees the whole form, not just the first step _(user)_. Their answer is saved into the fact bank, so the next run doesn't ask again _(user)_.

## Goals

- `runner apply <job-url> --dry-run` walks a real Easy Apply form from the job page to the review page, and does nothing past it.
- Every question on every step is read into a `FormQuestion`, answered by `answerQuestion` and filled in through the pace module.
- A blocked question is asked at the terminal. The author's answer fills the field and is saved to the bank as a known answer.
- A report lists every question, the answer, whether the bot or the author gave it, and the bank entries it rests on. The full report goes under `private/` and a redacted copy goes to `run-reports/`.
- Each safety stop ends the run without submitting.
- `runner snapshot` captures the pages the locators are built from, and a scrub step turns them into committed test fixtures.

## Non-goals

- **Submitting**, and the record of applied jobs. That's slice 07. This slice has no code path that clicks Submit.
- **Disqualification.** Slice 05b comes after this slice _(user)_ and then adds its check to the run. A job the author can't apply to is walked like any other.
- **Jobs that aren't Easy Apply.** They are reported and skipped (roadmap, locked).
- **Matching close wordings to a saved answer.** A question worded differently on another form may ask once per wording. That's left for later.
- **A database or a web app.** The bank stays a YAML file until slice 10 _(my call)_.

## Anti-goals

- **Pressing Submit.** Not even by accident: the walker stops when it sees the review page, and a test fails if any step's "next" button is the Submit button.
- **A wrong or invented answer typed into a real form.** Only backed answers and the author's own answers are filled. A blocked question is never guessed.
- **Personal data in Claude's view.** Nothing personal goes to `run-reports/`, to `snapshots/`, or to the terminal when the terminal is not the author's (see "Who sees what").
- **A run that pushes past a problem.** No retries, no reloads, no second click on a "next" that didn't advance.
- **A damaged fact bank.** A save that fails the bank's check is undone.

## Running it

`pnpm nx run runner:apply -- <job-url> --dry-run`

- The author runs it, or Claude does when the author asks in that session, a few a day, `--dry-run` only (roadmap, locked). `guard.mjs` already blocks runner launches without `--dry-run`. `apply` is not a safe subcommand, so that rule covers it.
- Without `--dry-run`, this slice refuses to start: "submitting comes in slice 07".
- The URL must be a `linkedin.com/jobs/view/<id>/` URL, or a search URL with `currentJobId=<id>`. The runner opens `/jobs/view/<id>/` either way _(my call)_.
- Each run opens its own window and closes it at the end (slice 03).

## The run, step by step

1. **Load the job page** and classify it with slice 03's session signals. Signed out, a security check or a captcha is a safety stop.
2. **Check the job.** Easy Apply button present? If not, report "not Easy Apply" and end. LinkedIn shows "Applied" already? Report it and end.
3. **Read the job post**: title, company, location and the description. The description feeds the answerer (`Job.description`) and sets the reading time (`pace.read(chars)`). No description found is an unexpected page, a safety stop, because answers that quote the post would have nothing to quote _(my call)_.
4. **Open the form** with `pace.click` on Easy Apply.
5. **For each step:**
   1. Read every field into a `FormQuestion` (label, type, options, required, help text, max length, step title). A field whose type isn't one of the nine below is a safety stop.
   2. Answer each through `answerQuestion`, with the whole bank, the job and the run date.
   3. A blocked answer goes to the terminal (below).
   4. Fill each answer through the pace module, in page order.
   5. Read the step again. Filling an answer often reveals a follow-up field ("If yes, please specify"). Any new field goes through 1–4. This repeats until no new field appears, at most three rounds, and a fourth round is a safety stop. A field that disappears is dropped from the report _(my call)_.
   6. Find the step's button. "Review" or "Next" is clicked. Submit is never clicked, and seeing it means this is the review page.
   7. After the click, the step must change. If it doesn't (a validation error, say), that's a safety stop. The report notes the error text from the page, which is LinkedIn's wording, not the author's.
6. **On the review page**, stop. In author mode (see "Who sees what") the run waits for Enter so the author can look at the filled form. It then closes the run window without submitting. Whether to press LinkedIn's "Dismiss" and "Discard" first, or just close, is the builder's call from what the snapshots show. The rule is that nothing is saved to LinkedIn as a draft unless LinkedIn does that by itself.
7. **Write the reports** (below).

The form lives in an open shadow root (from the 03b recordings). Locators have to cross it.

## Field types

The nine the answerer supports _(slice 05)_: `text`, `textarea`, `number`, `select`, `radio`, `checkbox-group`, `checkbox`, `file` (resume only) and `typeahead`. Anything else is a safety stop, and the report names what was found (tag, role, input type), never its value _(my call)_.

How each is filled:

- **text, number:** `pace.type`.
- **textarea:** `pace.type`. Pace never sends Enter today. A textarea answer with line breaks needs it, so pace gets a newline that is allowed only when the field is a `<textarea>` _(my call)_.
- **select, radio:** `pace.pick` by option index.
- **checkbox, checkbox-group:** `pace.click` on each box to tick, and on each box to untick when LinkedIn ticked one the answer doesn't include.
- **typeahead:** `pace.type`, then wait for suggestions and `pace.click` the one that matches the answer. No matching suggestion is a blocked question.
- **file (resume):** see "Prefilled fields and the resume".

**Characters pace can't type.** Pace types printable ASCII only. Typographic quotes, dashes and ellipses are turned into ASCII before typing _(my call)_. Any other non-ASCII character makes that question blocked, with the reason given. The run never types a changed letter.

**Optional questions.** An optional question that blocks is asked at the terminal too, with "leave it blank" offered. A blank optional answer claims nothing _(my call, following slice 05's lean)_.

## Prefilled fields and the resume

LinkedIn fills some fields itself: the email (a dropdown of the account's emails), the phone country code, the phone number and the resume (a list of resumes uploaded before).

- The runner answers prefilled fields like any other. When LinkedIn's value already matches, it `pace.glance`s and moves on. When it differs, it replaces it, and the report marks the field "changed from LinkedIn's value" _(my call)_. Pace has no way to clear a field today, so it gets a `clear(field)` (select-all, then Backspace, at recorded key timings), since only pace may act on the page.
- An email dropdown that doesn't list the bank's email is blocked. The author picks one at the terminal.
- **Resume:** if LinkedIn's list has a resume with the same file name as the bank's PDF, it is selected. Otherwise the bank's PDF is uploaded through `pace.upload`, which sets the file through the relay on a Windows-side path (slice 03). The bank's resume path is in WSL, so the runner copies it next to the extension, as `bridge-install` does for the practice PDF, and uploads that copy _(my call)_.

## Blocked questions at the terminal

The run pauses and prints the step title, the label, the field type, the options (numbered), the help text and why it blocked. The author can:

- type an answer (text fields), or enter option numbers (choice fields);
- leave it blank (optional questions only);
- stop the run.

The answer is filled as typed, or as the options picked. It is the author's, so it isn't checked by the verifier. It still goes through the ASCII rule.

**Saved to the bank** _(user)_. The runner then asks "Save to the fact bank? [Y/n]", defaulting to yes. The no is for one-off answers that only make sense for this job _(my call)_. A save:

- adds a known answer: `id` from the label in kebab-case, digits removed and cut to the first six words (with `-2`, `-3` if the id is taken), `question` as the label, `answer` as given (the option's text for a choice field; several picks joined with `; `, which the answerer matches back to options like any preferred wording), `confirmed` as today. Ids reach `run-reports/` through `redactResult`, so the id rule keeps out digits (phone numbers, amounts) and long label text _(my call)_;
- replaces the job's company name and title in both the question and the answer with `{company}` and `{jobTitle}`, so a "Why Acme?" answer doesn't reappear naming Acme on another company's form _(my call)_;
- edits the YAML in place with the `yaml` library's document API, so the author's comments and layout stay;
- copies the file to a timestamped backup next to it first, runs the bank's check after, and restores the backup if the check fails, telling the author why (by problem, never by value);
- reloads the bank, so a later question in the same run can use it.

**When there's no author at the terminal.** Outside author mode (see "Who sees what"), a blocked required question ends the run there, without filling it. The report lists it as "needs the author" _(my call)_. A blocked optional one is left blank.

## Safety stops

The roadmap's list, as it applies here. Each ends the run without submitting and without retrying:

- captcha or security check, on any page of the run;
- signed out;
- a field type outside the nine;
- an unexpected page: no job post, no description, no Easy Apply form after the click, a step that didn't change after "next", or a page the walker doesn't recognise;
- the run tab crashing or the bridge going away (slice 03's stop).

The report names which stop and on which step.

## Reports

**Full report** _(for the author)_: `private/runs/<startedAt>-<jobId>.md`, plus a `.json` of the same data. For each step and each question: the label, the type, the answer filled, who answered it (bot or author), the derivation, the bank entries it rests on (quoted), the inferences, and any "changed from LinkedIn's value" note. Then the stop reason or "reached review", and timings. Markdown is there so the author can read it straight through _(my call)_.

**Terminal:** in author mode, the same table as the report, printed at the end. Otherwise only the redacted summary.

**Redacted copy** _(for Claude)_: `run-reports/apply-<startedAt>.json`. It holds the job id, each question's `redactResult` output (ids and counts only), the field type, step numbers, who answered, the stop reason, timings, and the page path prefix. It has no label text and no answer values. `FormQuestion.id` is positional (`s2-q3`: step 2, question 3), never built from the label _(my call)_.

Labels and options are the employer's words, not the author's. But one can carry personal data (an email dropdown, "Is +44… your number?"), so they stay out of the redacted copy too _(my call)_.

## Who sees what

- Claude never reads `private/` or the bank (CLAUDE.md).
- **Author mode** is the only mode that prints personal data or reads the keyboard. It is on when stdin and stdout are both TTYs **and** `CLAUDECODE` is not set in the environment. Claude Code sets that variable in every command it runs, the author's own `! pnpm …` included, and that output lands in Claude's view too, so redacting it there is right. A TTY check alone isn't enough, because Nx may run the task in a pseudo-terminal _(my call)_.
- The author runs `apply` and `snapshot` from their own terminal. The plan's first task checks that keyboard input reaches the command through `pnpm nx run runner:apply`, Nx's terminal UI included. If it doesn't, the commands also get a plain `pnpm` script that runs the runner directly, and CLAUDE.md names that one.
- Output from any other run is redacted, and a blocked required question ends it (above).
- `snapshots/` and `run-reports/` are git-ignored and Claude-readable, and hold only scrubbed or redacted data.

## Snapshots and locators

Locators are built and tested against saved pages, the same way slice 03's session fixtures are. Saving with Ctrl+S drops shadow-DOM content, and the form is inside a shadow root, so the runner saves the pages itself _(my call)_.

- **`runner snapshot <job-url>`** opens the job in a run window and does nothing on the page. The author drives it by hand (opens the form, goes through the steps, never submits) and presses Enter in the terminal on each page they want saved. The runner saves that page's DOM, shadow roots included, through a read-only CDP call (`DOM.getOuterHTML` with `includeShadowDOM`, or `DOM.getDocument` with `pierce`). If the relay or the extension refuses that call, the builder adds it to their allowed set. It reads the DOM, not cookies or storage. Raw snapshots go to `private/snapshots/`.
- **`runner snapshot scrub`** turns each raw snapshot into a scrubbed copy in `snapshots/` (git-ignored, Claude-readable). Like slice 03's fixtures, it removes scripts, styles, metas, embedded JSON, hidden inputs, URLs and every input value, and keeps structure and the attributes the locators need. Visible text is kept **only** where it is the form's or page's own wording: labels, legends, headings, buttons, option texts, help text and `aria-label`s. Every other text node becomes `x`s of the same length. That blanks the review page's answers, the job description and other people's names ("Meet the hiring team") by structure, not by a list _(my call)_. On top of that, any text that matches a bank value (every field, fact, known answer and story, and the resume's file name) is replaced with a placeholder, which catches an email in an option list. It prints counts of what it removed, never what. Claude reviews each scrubbed file before it is committed as a fixture under `apps/runner/src/apply/fixtures/`, with a README table like slice 03's.
- `snapshot` touches LinkedIn, so it follows `session`'s rule: Claude starts it only when the author asks in that session. It is added to `RUNNER_SAFE_SUBCOMMANDS` because it never submits. `snapshot scrub` never touches LinkedIn.
- **Wanted first:** a job page (to find the description), Easy Apply steps of each kind the author meets (contact, resume, questions with several field types), a review page, and an "Applied" job page.

A recognisably wrong snapshot, such as one with personal data the scrubber missed, is fixed in the scrubber and never committed.

## Where the code lives

- `apps/runner/src/apply/`: the walker (steps 1–7). Its page access goes through an interface like `SessionPage`, so it is tested against fixtures and fakes.
- `apps/runner/src/linkedin/`: locators and the page readers (job post, form step, field to `FormQuestion`, review page), each tested on fixtures.
- `apps/runner/src/commands/apply.ts` and `commands/snapshot.ts`.
- `libs/fact-bank`: a new `addKnownAnswer(path, entry)` that does the in-place, backed-up, checked save.
- The pace module gets the textarea newline and `clear`. Everything else it needs exists.

## Done when

_(user: "Full form submit without major blockers"; three jobs is my call)_

- Three dry runs in a row, on three different real Easy Apply jobs, reach the review page with no safety stop.
- The author reads each report and finds every answer correct.
- Terminal questions are fine when the question is new to the bank. Saved answers mean later runs ask fewer.
- Unit tests cover each safety stop and each field type on fixtures, the "never Submit" rule, the bank save (including a failed check being undone), and the redacted report holding no label or value.

## Roadmap and `CLAUDE.md` changes in this slice

- **Roadmap:**
  - Slice 06 depends on 03, 03b and 05. Slice 05b comes after 06 and also adds its check to the run: on the job page before the form opens, and on each question _(user)_. Slice 07 depends on 06 and 05b.
  - Slice 07's question "whether a terminal answer is saved back into the fact bank" is answered here: yes, as a known answer.
  - Slice 06's "Spec answers" points to this spec.
- **`CLAUDE.md`:** the `apply` and `snapshot` commands; `snapshot` and `scrub` added to the guard's safe list, with the rule that `snapshot` runs only when the author asks; `snapshots/` as a git-ignored, Claude-readable folder; `private/runs/` and `private/snapshots/`.

## Left to the builder

- The locators, from the snapshots.
- How a step is recognised as "changed" after "next" (the progress value, the step title, or the set of fields).
- Dismiss-and-discard versus just closing the window at the end.
- The exact CDP call for snapshots, and its place in the relay's allowed set.
- The report's Markdown layout.
- How long to wait for typeahead suggestions before treating the question as blocked.
