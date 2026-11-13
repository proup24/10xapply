# Slice 05b: Disqualification

Date: 2026-11-13
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 05b.

## Intent

Recruiters on LinkedIn can mark a screening question as a must-have, and LinkedIn then rejects every applicant whose answer doesn't match, automatically _(user)_. For the author, the question that does this most often is work authorization and sponsorship: "Are you authorized to work in the US?", "Will you now or in the future require sponsorship?". The author is authorized to work only in Morocco _(user)_. Anywhere else the truthful answer is "no" or "yes, I'd need sponsorship", and the application is rejected on arrival.

Applying anyway wastes an application, uses up the daily cap and adds LinkedIn activity for nothing. This slice spots those jobs before anything is filled in or submitted, ends the run, and marks the job **disqualified** with a traceable reason.

Disqualification is not the bank's job (roadmap, locked). The bank still answers an authorization question truthfully. This check decides whether to apply at all.

## Goals

- Every `runner apply` run checks the job page and every form question for authorization and sponsorship requirements.
- A job that fails the check ends with outcome `disqualified`, without filling the step it was found on, and the form is discarded as on any other stop.
- The reason is traceable: the rule, the country, the quoted sentence or question, and where it was found (job page, or step and question). It is printed and saved in the run report _(user: "show me the reason, no need to override")_.
- Location and language requirements are recorded in the report, and never disqualify _(user: "log location and language, don't skip")_.
- A golden set and an eval command measure how well the extractor recognises authorization and sponsorship questions in all their wordings.

## Non-goals

- **Disqualifying on location or language.** Logged only. Whether they become rules is decided later, once the logs show how often they come up _(user)_.
- **An override.** The author can trace a disqualification but not overrule it _(user)_.
- **The record of applied and disqualified jobs.** Slice 07 builds the local record and stores this slice's verdict in it with a `disqualified` status (roadmap). Until then the verdict lives in the run report.
- **Checking a match before it reaches the approval list.** That's Phase 2 (roadmap). This slice keeps the check callable without a browser so that it can be reused there.
- **Any other requirement** (degree, years of experience, clearance). Out of scope _(user: "everything else doesn't matter")_.

## Anti-goals

- **Applying to a job that will be auto-rejected** because of authorization or sponsorship when the posting or form made that clear.
- **Applying because of an invented "they sponsor".** A sponsorship offer counts only when its sentence is quoted from the posting and code finds that quote in it.
- **Filling a step that disqualifies the job.** Nothing on that step is typed or clicked.
- **Proceeding without the check.** If the extractor can't give a valid answer, the run stops. It never carries on unchecked.
- **The extractor seeing the bank or the rules** (roadmap, locked). It sees only the job and the form's own text. Code applies the rules.

## The rule

The rules file says where the author is authorized to work: a list of country codes (for the author, `MA` only). Being authorized to work in a country means needing no sponsorship there. Countries are ISO 3166-1 alpha-2 codes.

The extractor turns text into **claims**. Code decides from the claims and the rules alone:

| Claim                                                                  | Found on         | Country in the rules | Country not in the rules                                                     |
| ---------------------------------------------------------------------- | ---------------- | -------------------- | ---------------------------------------------------------------------------- |
| `offers-sponsorship` ("we sponsor visas", "visa support provided")     | job page         | (nothing to do)      | Exempts that country from the two rows below for this run.                   |
| `requires-authorization` ("must be authorized to work in the US")      | job page or form | pass                 | **disqualified**, unless exempt                                              |
| `no-sponsorship` ("we can't sponsor", "no visa sponsorship")           | job page or form | pass                 | **disqualified**. An offer doesn't override it; the two contradict, so skip. |
| `asks-authorization` ("Are you authorized to work in the UK?")         | form question    | pass                 | **disqualified**, unless exempt                                              |
| `asks-sponsorship` ("Will you now or in the future need sponsorship?") | form question    | pass                 | **disqualified**, unless exempt                                              |
| `location-requirement`, `language-requirement`                         | job page or form | logged only          | logged only                                                                  |

_(user: apply if they sponsor, skip otherwise. "Otherwise" includes a posting that says nothing about sponsorship while the form asks.)_ A job where nothing is asked and nothing is required (for example, remote, open worldwide) goes ahead as normal.

**Which country.** A claim holds a list of countries with any-of meaning: "authorized to work in the US or Canada" is `[US, CA]`, and it passes if any one of them is in the rules _(my call)_. Regions are expanded by a fixed table in code (EU, EEA, Schengen, EU+UK, and so on), never by the model, so "authorized to work in the EU" disqualifies the author _(my call)_.

The runner has no job location today: `readJobPage` returns `location: null`, because no page structure names it. So this slice doesn't read the location field. When a question says "the country of this job" or similar, the country comes from the job description and title instead, and the claim is marked `country-from: job-description`. It quotes the sentence that names the place, and code checks that quote like any other _(my call)_. When neither the text nor the description gives a country (for example, "Are you authorized to work in the country you live in?" on a remote job), the claim's country is `unclear`. An `unclear` claim is logged and does not disqualify; the answerer handles the question as usual, and a blocked question still stops or asks as in slice 06 _(my call: an unclear question is usually about where the applicant lives, which for the author is Morocco)_.

A question that asks which countries the applicant is authorized in, without requiring one ("Select the countries you can work in"), is not a requirement and produces no disqualifying claim.

## Where the check runs

The run is the same as slice 06's (see its spec, "The run, step by step"), with two checkpoints. Nothing runs ahead of the bot.

1. **Job page.** After the description is read, the extractor gets the job's title, company and description. The call starts when `pace.read` starts, so it runs during the reading wait. Easy Apply is clicked only after the call returns and code has decided. A disqualified job never has its form opened.
2. **Each round of each step.** After `walkStep` reads a round's fresh fields, the extractor gets all of them at once (label, type, options, help text, step title) with the job's title and description. That's one call per round, so one per step unless follow-up fields appear. No field of that round is filled until the call returns and passes. The check runs **before** the round's other stops (`unknown-field`, `too-many-rounds`), and fields of an unknown type are sent too, by their label and any text they have. A disqualification wins over a safety stop, because slice 07 retries a safety-stopped job but never a disqualified one _(my call)_. The first answer call may start at the same time, so the check adds little time; a builder may also just await the check first if that's simpler. A follow-up field revealed by a fill gets its own check in the next round.

A disqualification ends the run through slice 06's `RunEnd` path, so the close-out (Dismiss, then Discard on the "Save this application?" prompt) is unchanged. A disqualifying question is never asked at the terminal, and the answerer is not asked to answer it.

Dry runs and, from slice 07, real runs behave the same way.

## The extractor

- **Its own role** (`extract`) with its own model in configuration, separate from the answerer _(roadmap, locked)_, called through the same `ModelCaller` (`claude -p`). Model and prompt are left to the builder; the eval decides.
- **Input:** only the job (title, company, description) or the round's form questions plus the job's title and description. Never the bank, never the rules, never anything the author has typed.
- **Output:** a list of claims, each with its kind, countries (a list of codes or region names, `unclear`, or none for language claims), `country-from` (`text` or `job-description`, with its own quote when it's the description), the quoted text it rests on and where it came from (`job-page`, or the question's id such as `s2-q3`). A language claim names the language. A location claim names the place as written.
- **Code checks every claim** before using it: the quote must appear in the text it came from (whitespace and case normalised), the country code must be valid, and a form claim must point to a question in the round. A response with an invalid claim is asked again once. If it's still invalid, or the call fails after its retries, the run stops with a new safety stop, `check-failed`. That isn't a disqualification, so the job can be tried again _(my call)_.
- An empty claim list is a valid answer: nothing about authorization, sponsorship, location or language.

The decision is plain code over the claims and the rules, tested exactly. The model only reads and quotes.

## The rules file

- `disqualify.yaml` in the private folder, next to the fact bank, with a checked schema and a typed loader. A committed example with fake values shows the format. Its first and only rule for now: `authorizedCountries: [MA]`.
- A missing or invalid rules file stops the run before the job page loads. The run never goes ahead without the rules.
- `runner facts-check` also checks the rules file, printing counts only _(my call; the builder may give it its own subcommand)_.
- In Phase 2 this moves to the database with the bank (slice 10).

## What gets recorded

- **Outcome:** a new `ApplyOutcome`, `disqualified`, with a `disqualification` on the run: the rule (`requires-authorization`, `asks-sponsorship`, ...), the country, `country-from`, the quote, and where (job page or `sN-qM`). When several claims disqualify, all are kept; the first is the headline.
- **Terminal:** the headline is printed. In author mode it includes the quote. Otherwise it's redacted like the rest of slice 06's output: rule, country, where.
- **Full report** (`private/runs/`): a "Requirements" section listing every claim from the run, disqualifying or not (location and language included), each with its quote and source, plus the verdict.
- **Redacted report** (`run-reports/`): claim kinds, country codes, `country-from`, sources (`job-page`, `sN-qM`) and the verdict. No quotes or labels, the same as slice 06's redaction.
- The extractor's calls go in the report's call stats with the answerer's (role, model, latency, cost).

## The eval

- A golden set of authorization, sponsorship, location and language wordings, plus near-misses that must produce no disqualifying claim (the "select the countries you can work in" kind, "Are you authorized to work in Morocco?", unrelated Yes/No questions). Each case gives the text and the expected claims. Job descriptions are included as well as form questions.
- These are recruiters' and LinkedIn's words, not the author's, so the example set is committed. Form-question cases start from the labels in the scrubbed snapshots and fixtures, varied by hand. Job-description cases are written by Claude for now, because the scrubber blanks descriptions _(user)_. Real posting sentences are added once the first automated batch of LinkedIn jobs arrives in Phase 2 _(user)_.
- A `runner disqualify-eval` command, like `answers-eval`: it runs the set, compares claims (kind and country exact, quote found), and reports misses and false alarms. It uses the subscription and never runs in CI. Its subcommand names are added to `guard.mjs`'s `RUNNER_SAFE_SUBCOMMANDS`, as it never touches LinkedIn.
- **Pass bar for this slice:** every authorization and sponsorship case recognised with the right country, and no near-miss producing a disqualifying claim, on three repeats.

## Where the code goes

- A new library, `libs/disqualify` (name is the builder's call): claim types, the extractor prompt and call, the claim checks, the rules schema and loader, the decision function and the eval. It imports `ModelCaller` from `@xapply/answerer` and never imports `@xapply/fact-bank`, so a lint rule or test can prove the extractor can't see the bank.
- `apps/runner/src/apply/`: the two checkpoints, the `disqualified` outcome, `check-failed`, and the report sections.

## Done when

- Unit tests cover the decision table above row by row, the claim checks (quote not found, bad country, unknown source), and the walker: a disqualifying job page never clicks Easy Apply, and a disqualifying round fills nothing.
- The eval passes its bar.
- The author runs `runner apply --dry-run` on at least two real jobs that should disqualify (one from the job page, one from a form question) and one that shouldn't, and confirms the reasons in the report. The author picks the jobs; Claude may run them only when the author asks in that session (CLAUDE.md).

## Left to the builder

- The extractor's prompt, its model, and the exact claim schema field names.
- Whether the round's check runs alongside the first answer call or is simply awaited first.
- The rules file's exact schema beyond `authorizedCountries`, as long as it leaves room for location and language rules later.
- How the eval prints its results and the size of the golden set (enough to cover the wordings named above).
