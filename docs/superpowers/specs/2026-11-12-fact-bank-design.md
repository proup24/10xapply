# Slice 04: Fact bank file

Date: 2026-11-12
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 04.

## Intent

Every answer the runner puts on an Easy Apply form has to come from something the author actually said about themselves. This slice gives those facts a home. It is one hand-written file under `private/`, with a checked format and a typed loader, which slice 05's answerer reads and slice 10 later moves into Postgres.

When the author fills a form by hand, facts about themselves and their experience come from memory. What makes them stop and think is the open-ended scenario question ("how would you handle…", "tell us about a time…") _(user)_. So the bank holds more than facts. It also holds the author's own stories, which the answerer may reword to fit a question but never add to _(user)_.

The bank only answers questions and fills fields. It does not decide whether a job is worth applying to. Disqualification is a separate, deterministic step in its own slice (see "Disqualification is not here") _(user)_.

## Goals

- One YAML file the author writes by hand, `private/fact-bank.yaml`, with four kinds of entry: **fields**, **facts**, **known answers** and **stories**.
- A schema that rejects a broken file with a clear message before any run starts.
- A typed loader that later slices import, and that returns the whole bank.
- A committed example file with made-up data that shows the format and passes the check.
- A command that checks the real file and prints only counts, sizes and errors, never a value.
- Shapes that move into Postgres in slice 10 without being redesigned.

## Non-goals

- Answering questions, matching answers to a dropdown's options, or formatting values for a field. That is slice 05.
- Deciding disqualification. That is the new disqualification slice (below).
- Editing facts in a UI, or storing them in a database. That is slice 10.
- Copying the resume to the Windows side for upload. That is slice 06, the same way `bridge-install` copies the practice PDF today.
- Saving answers the author gives at the terminal back into the bank. Slice 07 decides that.

## Anti-goals

- Any real fact committed, logged, printed, or copied outside `private/`. The check command prints entry ids and paths, never values.
- A format the author finds hard to write. Facts are plain first-person sentences, not a form to fill in.
- A format that invites the answerer to invent. Every piece of an answer must trace back to an entry.

## The file

`private/fact-bank.yaml`, written and kept by the author. YAML, not JSON, because stories and long answers are multi-line text _(my call)_. Top level:

```yaml
version: 1
fields: { ... }
facts: [...]
answers: [...]
stories: [...]
```

All four sections must be present; `facts`, `answers` and `stories` may be empty lists.

### Fields

The exact values a form needs character for character. Slice 05 fills these straight in, without an LLM, so they can never come out reworded _(my call, user agreed)_. A fixed set of keys, because code maps a form label to a key:

```yaml
fields:
  firstName: Sam
  lastName: Example
  email: sam@example.com
  phone:
    countryCode: '+44'
    number: '7700900123' # without the country code
    country: United Kingdom # for a "phone country" dropdown
  city: Leeds
  country: United Kingdom
  links:
    linkedin: https://www.linkedin.com/in/sam-example
    github: https://github.com/sam-example # optional
    portfolio: https://sam.example # optional
  resume: resume.pdf # path relative to private/
```

- `firstName`, `lastName`, `email`, `phone`, `city`, `country`, `links.linkedin` and `resume` are required. Other `links` keys are optional; the schema allows a small fixed set (`github`, `portfolio`, `website`) _(my call)_.
- Combinations are derived by code, never stored twice: full name, location ("Leeds, United Kingdom"), phone with country code. Derivation is plain concatenation in the loader or in slice 05, so it can't drift from the parts.
- `resume` points at one fixed PDF inside `private/` (the roadmap's one fixed resume for Phases 1–2). The check confirms the file exists and starts with `%PDF`. It does not read the file further.
- Phone, email and URL get a light format check (email has an `@`; the phone code starts with `+` and has digits only; URLs are `https://`). These checks are meant to catch typos, not every possible error.

### Facts

Plain first-person sentences, the way the author already writes them _(user)_. A sentence may carry its own conditions; there is no separate notes field _(user)_.

```yaml
facts:
  - I am a British citizen.
  - I am authorized to work in the United Kingdom only.
  - I am willing to relocate.
  - My notice period is one month.
  - text: I am currently a Backend Engineer at Example Ltd, employed full-time.
    tags: [current-job]
    confirmed: 2026-10-01
```

- An entry is either a string or an object with `text` plus optional `tags` and `confirmed`.
- Facts carry no id. When slice 05 says which fact an answer rests on, it quotes the sentence. The sentence is the reference, and the loader rejects two identical sentences so the quote is unambiguous _(my call)_.

### Known answers

Questions the author has answered before, with the answer the author chose. The author's existing question-and-answer list goes here _(user, from their pasted list)_.

```yaml
answers:
  - id: sponsorship-future
    question: Will you now or in the future require visa sponsorship to work in a country other than the United Kingdom?
    answer: 'Yes'
  - id: salary-expectation-monthly-usd
    question: Expected monthly salary, in USD
    answer: 5000 USD per month
  - id: ai-perspective
    question: What is your perspective on using AI in your work, and how have you used it?
    answer: |
      I see AI as a force multiplier...
  - id: heard-from
    question: How did you hear about this role?
    answer: '{source}'
  - id: contractor-rate
    question: What is your expected rate (USD gross) for a B2B or contractor contract?
    variants:
      - when: the form asks for a rate per hour
        answer: 30 USD per hour
      - when: the form asks for a rate per month
        answer: 5000 USD per month
      - when: the form names no period
        answer: 30 USD per hour, 5000 USD per month
        confirmed: 2026-10-20
    tags: [rates]
```

- `id` (kebab-case, unique across answers and stories), `question`, and exactly one of `answer` or `variants` are required. `tags` and `confirmed` are optional, on the entry and on each variant.
- **Answers are used as written** _(my call)_. Slice 05 may fit an answer to the field (pick the matching option, strip "USD per month" for a number-only field), but it doesn't rephrase a text answer.
- **No number-only duplicates** _(my call)_. "5000 USD per month" is one answer. Turning it into `5000` for a number field is formatting, done by slice 05's code. Amounts the author actually chose stay as separate answers: yearly figures, and a figure in another currency that isn't a straight conversion. Nothing is ever computed into a number the author didn't write.
- **No form-type field.** The author's list had `kind: field | choice | yesno | text`. The form's field type is known when the form is read, so the bank doesn't store it _(my call)_. A yes/no answer is just `'Yes'` or `'No'`. A dropdown answer is the author's preferred wording, which slice 05 matches to the options.
- **Placeholders** fill in from the job at run time. There is a closed list, `{source}` (the job board, "LinkedIn" for now), `{company}` and `{jobTitle}`, and the check rejects any other `{…}` _(my call)_.
- The author's `disqualifying` flag doesn't come across. See below.
- The author's `employmentStatus: true` becomes `tags: [current-job]`. It marks answers that go stale when the author changes jobs _(my guess at its meaning; tags are free-form, so the author can rename it)_.

### Stories

The author's own accounts, for scenario questions _(user: title, story, tags)_.

```yaml
stories:
  - id: missed-launch-date
    title: The payments launch that slipped two weeks
    story: |
      What happened, what I did, how it ended, in my own words.
    tags: [missed-deadline, ownership, communication]
```

- `id`, `title`, `story` and at least one tag are required.
- The rule slice 05 must hold to: the answerer may shorten, reorder and reword a story to fit the question, and may combine two stories. It must not add events, people, numbers, results or details that aren't in the story text _(user)_. A question no story fits is a blocking question.
- Tags help the answerer pick a story. They are free-form; the example file shows a starter set (conflict, missed-deadline, ownership, mentoring, disagreement-with-manager, failure, hard-bug, prioritization) _(my call)_.

### Shared rules

- `tags`: a list of kebab-case strings. `confirmed`: a date (`YYYY-MM-DD`). Both are optional and appear only where shown above. Nothing reads `confirmed` yet. It's there so the author, and later the web app, can see what hasn't been checked in a while.
- Unknown keys are errors, not warnings, so a typo like `answr:` is caught _(my call)_.
- Ids are unique across `answers` and `stories`. Fact sentences are unique among facts.

## No RAG, the whole bank every time

One person's bank is a few hundred sentences and a handful of stories, small enough for one model call. Slice 05 sends the whole bank with every question, rather than searching it. A search that misses the right fact can turn into a wrong "can't answer" or, worse, a guess, and that is the anti-goal this bank exists to prevent _(my call, user agreed)_.

To keep that true, the check reports the bank's size (characters and a rough token estimate, at 4 characters per token). It warns above 60,000 characters (about 15,000 tokens) _(my call)_. The warning doesn't fail the check. It's the signal to revisit this decision. Plain sentences also suit RAG well, so the format doesn't need to change if that day comes.

## The loader

- A new Nx library, `libs/fact-bank` _(my call)_. A library rather than code inside `apps/runner`, because slice 05's answerer, and later the API and the web app, read the same types. It exports:
  - the Zod schema (Zod 4, as 10xjobs uses) and the types inferred from it;
  - `loadFactBank(path?)`, which reads, parses and validates the file and returns the typed bank, with facts normalized to `{ text, tags, confirmed }` objects and derived fields (full name, location, full phone) added;
  - `checkFactBank(path?)`, the same work, returning a result (counts, size, warnings, errors) instead of throwing, for the command.
- The default path is `private/fact-bank.yaml` at the repo root, resolved from the library's own location, not the working directory. Tests pass an explicit path.
- The YAML parser is the `yaml` package _(my call)_. Duplicate keys and YAML anchors or aliases are rejected, so what the author sees is what loads.
- **Errors never contain values.** An error names the entry (`answers[12] (id: contractor-rate)`, `facts[3]`) and the problem ("unknown key `answr`", "duplicate fact sentence, same as facts[1]"). For facts, which have no id, it names the index only. This holds for the loader's thrown errors too, because a runner log may print them. Zod's default messages can echo the received value, so the library maps issues to its own messages.

- **The workspace gains `libs/*`** _(my call)_. `pnpm-workspace.yaml` lists only `packages/*` and `apps/*` today, so `libs/*` is added, along with the TypeScript project reference the Nx generator expects.
- **Every value reads as a string** _(my call)_. The file is parsed with the `yaml` package's `failsafe` schema, so an unquoted `7700900123`, `07700…` (leading zero kept), `5000`, `Yes` or `2026-10-01` all load as text, and Zod checks them. The author never has to remember quotes.
- **The resume path resolves from the YAML file's own folder** _(my call)_ (`private/` for the real file), and a path that leads outside that folder is rejected.
- **The placeholder check covers answer and variant text only** _(my call)_. A story may contain a literal `{…}`.
- **YAML parse errors follow the no-values rule too** _(my call)_. The `yaml` package's messages quote a snippet of the bad line, so only the line and column are reported.

## The check command

- `runner facts check`, with an Nx target `runner:facts-check`.
- It takes an optional path (default `private/fact-bank.yaml`), so the example file can be checked with the same command _(my call)_.
- It prints the path checked, a count per section, the size estimate, warnings and errors, and exits non-zero on any error. It never prints a value.
- It never touches the browser or LinkedIn. `facts` and `facts-check` are added to `RUNNER_SAFE_SUBCOMMANDS` in `.claude/hooks/guard.mjs`, with a guard test, so Claude may run it. Claude can't read the file, but it can read the check's output, which holds no values.
- `CLAUDE.md`'s command list and safe-subcommand list are updated.

## The example file

- `libs/fact-bank/fact-bank.example.yaml`: a made-up person, with every entry kind, a variant, a placeholder, a tagged fact, a `confirmed` date and two stories. It is the format's documentation, so it carries short comments.
- A test loads it and expects no errors. Its `resume` points at a tiny fake PDF committed next to it in the library's test fixtures.
- Other tests cover each rejection: missing required field, unknown key, duplicate id, duplicate fact, both `answer` and `variants`, unknown placeholder, bad date, missing or non-PDF resume. Each test also confirms that the error text doesn't contain the bad value.

## Getting the author's real file started

The author already has a question-and-answer list and some fact sentences. Claude can't write into `private/`. So, if the author asks, Claude writes a draft converted from what they pasted in this session into the session's scratchpad (outside the repo), and the author reviews it and moves it to `private/fact-bank.yaml` _(my call)_. Otherwise the author writes the file by hand from the example. Either way, `runner facts check` is the test.

## Disqualification is not here

Agreed in this session, recorded so it isn't lost _(user)_:

- Some jobs require something the author doesn't have, usually a work authorization or a location. The run should not apply. It marks the job **disqualified** instead.
- This is not the bank's job. The bank answers a work-authorization question truthfully, the same as any other question.
- A model **extracts** structured claims from the job page and the form's labels, text and options (for example `{ requires: work-authorization, country: US }`). It is its own role and model in config, separate from the answerer, and it never sees the bank. Plain code then checks those claims against a separate **rules file**, so the decision is deterministic and tested exactly.
- It runs on the job page before the form is opened, and again on each form question.
- A disqualified job is not a blocking question; nothing the author answers would fix it. It is recorded and skipped.
- In Phase 2 the same check can run when a match arrives, before it reaches the approval list.

This becomes a new roadmap slice, **05b Disqualification**, after 05 and before 06. Its rules-file format, extraction schema and where the verdict is recorded are for that slice's own spec. This PR adds it to the roadmap.

## Roadmap changes in this PR

- Slice 04: mark the spec answers as settled and link this spec.
- Slice 05: scope gains stories (with the no-new-details rule) and known answers used as written; it reads the bank through `libs/fact-bank`.
- New slice 05b, Disqualification, as above; slice 06 depends on it.
- Slice 07: the local record gains a `disqualified` status, never retried.
- Slice 10: the four entry kinds are what moves into Postgres: fields as one profile row per user, and facts, known answers and stories as rows with `userId`. Fact rows gain an id there.

## Moving into Postgres later (slice 10)

The shapes are chosen so the move is a copy, not a redesign: `fields` become columns of one per-user row, and each of the other three becomes a table whose columns are the entry's keys plus `userId`. Variants are a child table or a JSON column, for slice 10 to decide. The Zod schema stays the validation for edits made in the web app.

## Left to the builder

- Exact wording of messages and of the command's output.
- Whether derived fields are computed in the loader or exposed as helper functions, as long as they're never stored.
- The library's internal layout, and the Nx generator options, following the workspace's existing setup.
- The starter tag list in the example file.
