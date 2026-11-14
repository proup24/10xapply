# Slice 07: Submit, and never twice

Date: 2026-11-14
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 07. Builds on [slice 06](2026-11-12-walk-the-form-design.md), [slice 05b](2026-11-13-disqualification-design.md) and [slice 05c](2026-11-13-disqualification-by-location-design.md).

## Intent

Slice 06 walks an Easy Apply form to the review page and stops. This slice lets the runner press Submit, so the first real applications go out from the author's account, filled from the author's facts.

The author's picture of a run _(user)_: "I watch it fill, it submits, then shows Applied. Step in only if a question needed answering doesn't exist in the bank." The author types `apply <job-url>` in their own terminal and watches the run window. They step in only when the bank can't answer a question.

The other half is "never twice". Applying twice to the same job is one of the project's anti-goals. A local record of jobs, keyed on the LinkedIn job id, and LinkedIn's own "Applied" marker together make sure a job gets at most one application.

## Goals

- `runner apply <job-url>` (no `--dry-run`) walks the form as slice 06 does and, on the review page, clicks Submit on its own.
- After Submit, the run confirms that LinkedIn shows the job as applied and records it.
- A local record under `private/` holds each job's status: `submitting`, `applied`, `disqualified` or `failed`.
- A job the record or LinkedIn shows as applied is never applied to again. A `disqualified` job is never retried.
- A crash between the Submit click and the "applied" record can never lead to a second application on its own.

## Non-goals

- **The slice 06 gaps** _(user: "keep them out, just submit and the record")_: the email dropdown, the unreadable step-1 text box, date fields, multi-select on a live form, bank-silent Yes/No questions, and the three hard-question jobs. They go to a follow-up slice.
- Daily caps, queues, running unattended, or anything hosted. Those are Phase 2 (slice 14 on).
- Moving the record to Postgres. That's slice 14. The format only has to move there without being reshaped.
- Changing how questions are answered, how blocked questions are asked at the terminal, or how answers are saved to the bank. Slice 06 already does all of that.

## Anti-goals

- **Applying twice to the same job.** Every path in this spec is judged against this first.
- **Applying to a job the author didn't ask for.** The runner submits only the one job named on the command line, in a run the author started.
- **Submitting a wrong or invented answer.** Unchanged from slices 05 and 06: a question the bank can't back is asked at the terminal or stops the run. It is never guessed so the run can reach Submit.
- **Submitting when nobody is there to answer.** A run without `--dry-run` refuses to start outside author mode (exit 2, fixed message, before a window opens). `CLAUDE.md` has the author run every real submit, and with no typed confirmation, author mode is the check that someone is there. Slice 14 relaxes this when the runner goes unattended _(follows `CLAUDE.md`)_.
- **Personal data in Claude's view.** The record lives in `private/`. Run reports and terminal output outside author mode stay redacted, as in slice 06.

## The run

What's new compared with slice 06 is **in bold**.

1. Parse the URL to the job id, then load the bank and the rules (slice 06).
2. **Read the record.** If the job is `applied` or `disqualified`, refuse before opening a window. Print the status and the date, and exit with outcome `already-applied` or `disqualified`. If it is `submitting`, go to "A leftover `submitting`" below. `failed`, or no entry at all, carries on.
3. Open the job page (slice 06). If LinkedIn shows the job as applied: **record `applied` (source: `linkedin-marker`)** and end with outcome `already-applied`, without opening the form. That's a normal outcome, not an error _(user: "instead of crash if job is applied, it should update it in our database")_. It covers a job the author applied to by hand, a submit whose record update was lost, and a job the record has never seen.
4. Disqualification check on the job page (05b/05c). **A `disqualified` verdict is written to the record, here or on any form step** (05b already marks a job disqualified at either checkpoint).
5. Walk the form to the review page, with terminal questions as in slice 06.
6. **On the review page, with no `--dry-run`:**
   1. Write the record as `submitting`, flushed to disk, **before** the click. If the write fails, stop without submitting.
   2. Click the Submit button through the pace module, like any other click.
   3. Wait for LinkedIn's confirmation (the "application sent" dialog or its equivalent), close it the way a person would, and reload or re-read the job page until it shows as applied.
   4. Applied seen: update the record to `applied` (source: `submit`), outcome `submitted`.
   5. Applied not seen within the wait: see "Submit with no Applied" below.
7. With `--dry-run`, the review page behaves as in slice 06, except that the "Follow {company}" checkbox is unticked first (see below).

**No typed confirmation** _(user)_. The run submits on its own once the form is filled. This replaces the `CLAUDE.md` line that said slice 07 would ask for one, and slice 14 no longer has a prompt to remove.

**The "Follow {company}" checkbox is unticked** _(user: "sometimes the field is there sometimes it's not, but if it exists it's always checked by default; we want to unselect it")_. On reaching the review page, dry run or not, the runner reads the box's state live; ticked, it gets one press through the pace module, inside the form, and must read unticked after, or the run stops (`unexpected-page`) before `submitting` is written or Submit is pressed. Unticked or absent, nothing is pressed. A box that is seen but can't be singled out (several, or one outside the form) stops the run (`unexpected-page`) before anything is pressed or written, dry run or not. The box's label names the company, so it never goes into a report or the record. LinkedIn's other review-page extras, if any, are left at LinkedIn's default _(my call)_.

## Never twice

**LinkedIn is the source of truth for "applied"** _(user)_. Once LinkedIn shows a job as applied, it won't take a second application, and the runner treats the marker as final. The local record exists for the moments LinkedIn can't answer: the run window that dies mid-submit, and the jobs we refuse without opening a window.

**A leftover `submitting`.** The record says `submitting` when a run stopped (a crash, a lost bridge, Ctrl+C, a killed terminal) after writing it and before updating it. The next run on that job:

1. Opens the job page and looks for the applied marker.
2. Marker present: records `applied` (source: `linkedin-marker`) and ends with `already-applied`.
3. Marker absent: waits a short while, reloads once, and looks again, in case LinkedIn is slow to update _(my call)_. Still absent: records `failed` (reason `submit-unconfirmed`) and **ends without opening the form** _(user: "it should mark the run as failed")_.
4. The next `apply` on that `failed` job applies normally _(user: "apply again if the job is retried")_.

So after a crash mid-submit, a second attempt always takes two separate commands from the author. One finds and settles the leftover, the next applies. The roadmap's "never a second attempt without the author checking" holds: the run that discovered the leftover tells the author, and only the author's next command applies again.

**Submit with no Applied.** In the run that clicked Submit, the confirmation or the marker may not show up in time (LinkedIn shows an error, the page hangs). The run then reloads the job page once and looks again. If the marker is there, the job is `applied`. If not, the record is set to `failed` (reason `submit-unconfirmed`), the outcome is `submit-unconfirmed`, and the terminal tells the author to check the job on LinkedIn before retrying. It never clicks Submit a second time in the same run.

**A stop before Submit** (safety stop, `needs-author`, the author's `s`, a crash while filling) never wrote `submitting`. Nothing is written to the record for it, apart from `disqualified`. A later run can try again.

**Two runs at once.** The author runs one at a time, but nothing enforces that. Just before writing `submitting`, the run re-reads the record. If another run has written anything for this job since step 2, it stops without submitting (outcome `safety-stop`, kind `record-changed`) _(my call)_.

## The record

One JSON file, `private/applications.json`, written atomically (write a temp file, then rename) _(my call)_. Claude never reads it, like everything under `private/`.

```json
{
  "version": 1,
  "jobs": {
    "4490364051": {
      "status": "applied",
      "source": "submit",
      "updatedAt": "2026-11-14T10:12:03.000Z",
      "history": [
        {
          "status": "submitting",
          "at": "2026-11-14T10:11:40.000Z",
          "runStartedAt": "2026-11-14T10:08:12.000Z"
        },
        {
          "status": "applied",
          "at": "2026-11-14T10:12:03.000Z",
          "source": "submit",
          "runStartedAt": "2026-11-14T10:08:12.000Z"
        }
      ]
    }
  }
}
```

- Keys are LinkedIn job ids (digits only).
- `status`: `submitting` | `applied` | `disqualified` | `failed`.
- `source` (for `applied`): `submit` | `linkedin-marker`. `reason` (for `failed` and `disqualified`): a fixed code, `submit-unconfirmed` or the disqualification's rule kind and country. Never page text or bank text.
- **Clearing an entry.** No flag or command clears `disqualified` (or any status). If a verdict is wrong or the rules change, the author edits the file by hand for now. Once the web app exists, the author will clear entries there _(user)_.
- `history` keeps every change, with the run it came from, so a `failed` that later turns `applied` can be traced. Shaped as one row per job plus an events list, so it maps onto two tables in slice 14 without being reshaped.
- A missing file is an empty record. A file that doesn't parse or fails its schema stops every non-dry run before a window opens (exit 2, fixed message). A dry run carries on without it, so a broken record never hides a form from the author, but it can't be used to submit.

**The record and `--dry-run`.** A dry run reads the record and refuses `applied` and `disqualified` jobs the same way. It also writes `applied` (from the marker) and `disqualified`, which are facts about the job whoever finds them. It never writes `submitting` or `failed`, and never settles a leftover `submitting` _(my call)_.

## What gets reported

- New outcomes: `submitted` and `submit-unconfirmed`. `already-applied` and `disqualified` gain a `via` of `record` or `linkedin`.
- The run report (full under `private/runs/`, redacted under `run-reports/`) records the record's status before and after the run, and the submit timings (click to confirmation, confirmation to marker). Job ids and statuses are not personal, so they stay in the redacted report.
- The terminal prints one closing line naming what happened: "submitted, LinkedIn shows Applied", "already applied (record, 2026-11-14)", "previous submit unconfirmed; marked failed; run again to apply", and so on.

## Safety and the guard

- `guard.mjs` is unchanged. Claude still can't start a run without `--dry-run`, and the author runs every real submit (`CLAUDE.md`). The author-mode refusal (see Anti-goals) is a second check behind the guard, and it has its own test.
- The slice 06 rule "no code path clicks Submit" becomes: the only code that clicks Submit is the review-page step, reached only when `--dry-run` is absent and `submitting` has been written. A test proves that a dry run never clicks it, on every review fixture. Another proves that the click never comes before the record write, using a fake record that fails the write.
- `CLAUDE.md` changes: `runner:apply` without `--dry-run` submits (it no longer exits 2), the typed-confirmation line goes, and the record file joins the list of private files Claude never reads.
- Roadmap changes: slice 07's "Spec answers" point to this spec, and slice 14 no longer removes a prompt.

## Pages it needs to recognise

Fixtures exist for the job page, the review pages and the applied job page. `job-applied.html` turned out to hold the "Your application was sent" dialog itself, with its Dismiss button, so the confirmation reader is built from it.

The author takes a second sample by applying to one job by hand with `runner snapshot` running and pressing Enter on the dialog and on the job page after it. They pick a job they want anyway, and it counts as a hand application, not one of the two below. The author agreed to take it _(user)_. Claude scrubs the snapshots and commits them as fixtures, and both readers must pass on them before the PR opens and before the first real submit _(my call: the checkpoint moved from the code to the PR, because a fixture already exists)_.

## Done when

- **Two real submits** _(user: "a couple successful submits")_. On two different Easy Apply jobs, which the dry run already handles, run by the author from their own terminal, the run ends `submitted`, LinkedIn shows Applied and the record says `applied`. A second `apply` on each is refused from the record before a window opens.
- Unit tests on fixtures and fakes cover:
  - `submitting` + marker → `applied`;
  - `submitting` + no marker → `failed`, and the form never opens;
  - `failed` → applies again;
  - a marker on a job the record doesn't know → `applied`;
  - `applied` and `disqualified` refused before a window opens;
  - the record write failing → no click;
  - the record changing under the run → no click;
  - no marker after Submit → `submit-unconfirmed`, and Submit is never clicked twice;
  - a corrupt record stops a real run but not a dry run;
  - the dry run never clicks Submit.
- Lint, tests, build and typecheck pass in CI.

## Where the code goes

- `apps/runner/src/apply/record.ts` (new): read, validate, write atomically, and the status changes as small pure functions, so the rules above are tested without a browser.
- `apps/runner/src/apply/run.ts`: the record checks at the start, the leftover-`submitting` path, and the submit step after the review page.
- `apps/runner/src/linkedin/`: the confirmation reader, from the new fixtures.
- `apps/runner/src/commands/apply.ts`: drop the `--dry-run` requirement, and add the new outcome lines.

## Left to the builder

- The exact waits (for the confirmation, and for the marker after a reload), within the pace module's ranges.
- How to close the confirmation dialog (its button or its close control), from the fixtures.
- Exit codes for the new outcomes, following the existing ones.
- Whether `already-applied` from the record also prints the record's history in author mode.
