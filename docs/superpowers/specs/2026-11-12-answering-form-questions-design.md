# Slice 05: Answering form questions

Date: 2026-11-12
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 1, slice 05.

## Intent

This slice takes one Easy Apply form question, the author's fact bank and the job post. It returns an answer the run may submit, or says that it can't. Every question gets an attempt _(user)_. Anything the bank doesn't back becomes a **blocking question**. The author answers it, and that answer goes into the bank, so the next similar question is answered on its own _(user; saving it back is slices 07 and 15, not this one)_.

The answers should read well: polished, confident, in the voice of a strong engineer, tied to what the job post asks for. They must also be true: every claim about the author comes from the bank or follows plainly from it _(user: "polished writing and fair inferences")_. Nothing is made up, not even to make the author look good. That is the project's own anti-goal ("submitting a wrong or invented answer"), and an invented claim goes out under the author's name to a real employer.

When reading well and staying true pull apart, the answerer blocks. A blocked question costs the author a minute. A wrong answer on a submitted application can't be taken back. Accuracy comes before cost _(user)_.

## Goals

- A library function: one question in, one result out. The result is either **backed** (a value, the bank entries it rests on, how it was derived) or **blocked** (a reason).
- Simple fields (name, email, phone, city, links, resume) are filled by code from the bank's `fields`, with no model involved.
- Everything else goes through a generator call, then deterministic code checks, then an independent verifier call. Only an answer that passes all three is backed.
- Every model call is a `claude -p` run on the author's own Claude subscription _(user)_. There is no OpenRouter and no API key.
- A golden set and an eval command, in two parts: a committed set on the made-up example bank, and a private set on the author's real bank whose Claude-readable report never shows a value.
- No browser. Nothing in this slice touches LinkedIn.

## Non-goals

- Reading the form off the page, filling it in, or recognising field types on the page. That's slice 06. This slice takes a question already turned into data.
- Disqualification. That's slice 05b. The answerer answers a work-authorization question truthfully, like any other question.
- Asking the author at the terminal, and saving their answer into the bank. That's slices 07 and 15.
- Deciding what a run does with a blocked optional question. That's slice 06 (see "Optional questions").
- Running on a server. Calls run on the author's machine through their signed-in `claude`. That's enough through Phase 2. Phase 3 decides how hosted runs call a model.

## Anti-goals

- **An invented claim marked backed.** If an answer says something about the author that no bank entry says and that doesn't follow plainly from one, it is blocked.
- **Silence read as "No".** When the bank says nothing about the thing asked ("Do you have Terraform experience?" with no mention of Terraform), the question blocks. It never comes back "No" _(user)_.
- **A rejected answer kept because the generator insisted.** The verifier judges and never writes values. A disagreement leads to one regeneration and then to a block. The verifier's own answer is never used.
- **Personal data in logs, errors or Claude-readable reports.** Error messages name the question and the problem, never a value. This is the same rule as `libs/fact-bank`.
- **A model call that can act.** A `claude -p` call has no tools, no MCP servers, no hooks and no project settings. It can only read its prompt and return JSON.

## What counts as backed

These are the author's rules. The prompts, the checks and the golden set are all built from them.

| The answer is…                                                                                   | Backed when                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A **field** (name, email, phone, city, country, links, resume)                                   | Code maps the label to a field key and fills the value as written. No model.                                                                                                                                                                                                                                                                                       |
| A **short value** from a known answer (Yes or No, an amount, a rate, a date, a number, a choice) | Used as written, with placeholders filled, and only **fitted** to the field: pick the matching option, or strip the unit for a number-only box ("5000 USD per month" becomes 5000). For an answer with variants, the `when` picks the variant.                                                                                                                     |
| **Text** built from known answers, facts and stories                                             | The answerer may reword to fit how the question is asked, leave out what the question doesn't ask about, bring forward what it does, and combine entries _(user)_. Every claim about the author must trace to an entry, or be a fair inference from one (below). For stories, the slice 04 rule still holds: no added events, people, numbers or results _(user)_. |
| A **fair inference**                                                                             | It follows plainly from a cited entry. "I run Kubernetes in production" supports "comfortable with containers" _(user)_. A guess about what the author probably did isn't one. Each inference is marked `inferred` in the result and in the run report, so the author can see every one.                                                                           |
| **Simple math on facts**                                                                         | Allowed _(user)_. "I have used Kubernetes in production since March 2021" answers "Years of Kubernetes experience?" with 5, using the run date. Code checks the math (below).                                                                                                                                                                                      |
| A **dropdown or radio bucket**                                                                   | The fact falls inside exactly one option. "My notice period is one week" picks "Less than 2 weeks" from "Immediate / Less than 2 weeks / One month / …" _(user)_. A fact that sits on the edge of two options blocks _(my call)_.                                                                                                                                  |
| About **the company or the role**                                                                | It may use the job post, combined with the author's facts _(user)_. A claim about the company must be in the post. A claim about the author must be in the bank. The post never backs a claim about the author.                                                                                                                                                    |

**Tone** _(user: "polished writing")_. Text answers are written confidently, in plain professional English. They lead with the strongest entries that match what the post asks for. There are no hedges ("I think I might have"), no filler, and no superlatives the bank doesn't support ("world-class", "expert").

**Numbers are never adapted.** Every number, amount, percentage, duration and date in any answer, text included, must appear in a cited entry or come out of checked math. Code checks this. That is the line that keeps a rewording from turning into "cut review time by 30%".

**Year-only dates** _(user)_. When a fact gives a year without a month ("since 2021"), the math counts from the start of that year (1 January). On 2026-11-12, "since 2021" gives 5.

Questions block when:

- The bank is silent on the thing asked _(user)_.
- No story fits a scenario question.
- An answer lands on a boundary between two options.
- Any code check fails, or the verifier rejects the answer after one regeneration.
- The field type isn't one the answerer handles (see "Field types").
- A model call fails after its retries. A model error never turns into a guess.

**Multi-select follows from "silence isn't No"** _(my call)_. On a checkbox group ("Which of these have you used?"), leaving a box unticked claims "no". So every option needs backing either way. If the bank is silent on one option, the whole question blocks.

**Consent boxes** ("I agree to the privacy policy") block until the bank has a fact covering them. The author adds one sentence once, such as "I agree to standard privacy and data-processing terms when I apply for a job". From then on they're backed like any other fact _(my call)_.

## Input and output

```ts
answerQuestion(question: FormQuestion, context: AnswerContext): Promise<AnswerResult>
```

- **`FormQuestion`**: `id` (the caller's id, for reports), `label`, `type` (see "Field types"), `options` (as shown, in order, for choice types), `required`, `helpText` (optional), `maxLength` (optional, when the form shows one), `stepTitle` (optional, the form step's heading).
- **`AnswerContext`**: the loaded `FactBank` (from `libs/fact-bank`), the job (`title`, `company`, `location`, `description` as plain text, `source` which is "LinkedIn" for now), the run date, and the model config.
- **`AnswerResult`**:
  - `status: 'backed' | 'blocked'`, and `required` carried through from the question.
  - When backed:
    - `value`: a string for text and number, an option label exactly as offered for a single choice, a list of options for multi-select, or the resume path for a file.
    - `sources` (see below).
    - `derivation`: `field`, `as-written`, `fitted`, `math`, `bucket` or `composed`. `composed` is text written from entries.
    - `inferences`: for `composed`, each inferred claim with the source it follows from.
    - `verification`: what the verifier said, and the round count.
  - When blocked: `reason` (`bank-silent`, `no-story-fits`, `boundary`, `check-failed`, `verifier-rejected`, `unsupported-field` or `model-error`), plus a short `detail` that never holds a value.
  - `calls`: per model call, the role, the model, latency, and the cost that `claude -p` reports, for the run report.

**Sources** are how an answer traces back. Each one is one of:

- `{ kind: 'field', key }`
- `{ kind: 'fact', text }`: the fact sentence, quoted exactly. Slice 04 made fact sentences unique for this reason.
- `{ kind: 'answer', id, variant? }`, where `variant` is the index of the variant used.
- `{ kind: 'story', id }`
- `{ kind: 'job-post', quote }`: a short exact quote from the description.
- `{ kind: 'run-date' }`, for math.

**Confidence is the status** _(my call)_. The roadmap asked for "a confidence level" and a rule for auto-submit versus blocking. There is no numeric score with a threshold, because a model's own confidence number is exactly what this slice can't trust. "Backed" means the answer passed the code checks _and_ an independent verifier. Nothing else is backed.

**A redacted form of the result**, exported for `run-reports/`. It keeps status, reason, derivation, source kinds with ids, inference count, round count and call stats. Fact sources appear by their index in the bank, never by sentence. Job-post quotes are dropped. It holds no value, no fact text and no question label. The question appears by its caller id only. Slice 06 writes the full result to `private/` and the redacted one to `run-reports/`.

## Field types

The answerer handles these types:

- `text`: one line.
- `textarea`
- `number`
- `select`: a dropdown.
- `radio`
- `checkbox-group`: multi-select.
- `checkbox`: a single box, usually consent.
- `file`: the resume only.
- `typeahead`: a text box that offers suggestions, such as a city. It is answered like `text`, and picking the suggestion is slice 06's job.

Any other type blocks as `unsupported-field`, and so does a `file` that isn't asking for a resume, such as a cover letter. Slice 06 decides whether that is a safety stop.

## How one question is answered

```
1. Field mapping (code)    label is a field label     -> backed, done
2. Generate (claude -p)    answer + sources + derivation, or "can't answer"
3. Check (code)            fails -> blocked (no second try: a broken trace isn't fixed by asking again)
4. Verify (claude -p)      confirmed -> backed
                           rejected  -> regenerate once with the verifier's reasons, back to 3
                           rejected again -> blocked
```

### 1. Field mapping

- Code normalizes the label (lower case, punctuation removed) and matches it **whole** against a fixed list of patterns per field key. A pattern only matches the full label, never a part of it. So "Which city would you like to work in?" matches nothing and goes to the generator. It is never filled with the home city.
- The field keys are: first name, last name, full name, email, phone, phone country code, mobile, city, location, country, LinkedIn profile, GitHub, portfolio or website, and resume or CV. The derived values from slice 04 (full name, location, full phone) are used.
- On a choice type, field mapping picks the option that equals the bank value. Examples are LinkedIn's email dropdown, or "United Kingdom (+44)" for the phone country. If no option matches, the question **blocks**. It isn't handed to the model, because a field value is never reworded.
- A label that matches no pattern goes to the generator. The generator can still cite a field as a source.
- A field the bank doesn't have, such as an optional link, blocks as `bank-silent`.

### 2. Generate

- One call per question _(my call: accuracy over batching a whole step)_. It asks for structured output against a JSON schema. If the output doesn't match the schema, the call is tried again with the errors, up to 3 tries.
- The prompt holds:
  - the rules from "What counts as backed";
  - the whole bank, rendered as text: fields, facts, known answers with their variants and `when`, and stories with titles and tags (no RAG, locked in the roadmap);
  - the job post;
  - the run date;
  - the question.
- The generator returns one of two things:
  - `cannot-answer`, with a reason: `bank-silent`, `no-story-fits` or `boundary`.
  - A value with its sources, its derivation and, for `composed`, its inferences. For `math` it also returns the calculation as an expression (below).

### 3. Check (deterministic)

Each failed check blocks the question as `check-failed`, with a detail that holds no value.

- **Every source exists.** A fact quote is an exact fact sentence. An answer or story id exists. A variant index is in range. A job-post quote is an exact substring of the description, with whitespace normalized.
- **At least one source is about the author**, unless the question is purely about the company. A job-post quote alone never backs an answer.
- **Choice values are offered.** A single choice is exactly one of the options. A multi-select is a subset of them.
- **`as-written`**: the value equals the cited answer or variant text, with placeholders filled, character for character apart from surrounding whitespace.
- **`fitted`**: every number in the value appears in the cited answer's text. For a choice, the value is one of the options.
- **Numbers everywhere**: in every derivation, every number in the value appears in a cited source or is the result of checked math. This covers digits and number words, percentages, amounts and years.
- **`math`**:
  - The expression uses only `+ − × ÷`, parentheses, and numbers that each appear in a cited source or in the run date.
  - Code evaluates the expression with a small parser, never `eval`.
  - The result is rounded down to a whole number, and must equal the value.
  - Year-only dates count from 1 January of that year (see above).
- **Field limits**:
  - `number` fields hold only a number.
  - Required fields aren't empty.
  - `maxLength`, when given, is respected. An answer that's too long blocks. It is never cut short.
- **Placeholders**: all of them are filled, and no `{…}` is left in the value.
- **A `file`** value is the bank's resume path, and the question asks for a resume.

### 4. Verify

- The verifier is a separate, fresh `claude -p` call with no memory of the generator's call. It has its own system prompt: the judge's job, not the writer's. One call per question.
- **Choice and number questions.** The verifier answers on its own, without seeing the generator's value, from the same bank, job post, run date and question. Matching values are `confirmed`. Different values, or a verifier `cannot-answer`, are `rejected`. This is how Jev verifies closed fields in 10xjobs (`2026-11-07-generate-then-verify-design.md`).
- **Short values used as written or fitted.** The verifier also checks that the cited entry, and the variant if there is one, actually answers _this_ question. Examples it should catch: the monthly salary cited for a yearly question, or the "no period" variant used on a per-hour question. A wrong fit is `rejected`.
- **Text.** The verifier gets the generator's answer and its sources, and lists every claim the answer makes. Each claim gets one of four marks:
  - backed by a named source;
  - a fair inference from a named source;
  - an unsupported claim about the author;
  - a company claim not in the post.

  Any claim with one of the last two marks, any detail added to a story, and any inference that doesn't follow plainly, make the answer `rejected`. The claims it rejected are listed.

- **On rejection.** The generator runs once more and is told which claims or values were rejected and why. It is told that `cannot-answer` is allowed. It is not told what the verifier picked. Then steps 3 and 4 run again. A second rejection blocks as `verifier-rejected`. The number of regenerations is set in config, default 1 _(my call)_.
- The verifier never supplies the value that gets used.

**Same company, independent check** _(user: one provider)_. Both roles are Claude. The verifier's independence comes from four things: a fresh call, a different job, answering choice questions blind, and claim-by-claim checking of text. It doesn't come from a second company. The code checks don't depend on the model at all.

## Model calls: `claude -p`

- **Every role is a `claude -p` run** on the author's own subscription _(user)_. That covers the generator, the verifier and the eval judge. This replaces the roadmap's "LLMs through OpenRouter" for 10xapply. The roadmap and `CLAUDE.md` are updated in this slice to say so. Nothing goes through OpenRouter, and 10xjobs's OpenRouter client isn't copied.
- **The model per role** comes from config in `apps/runner/.env.local`: `ANSWER_MODEL`, `ANSWER_VERIFY_MODEL` and `ANSWER_JUDGE_MODEL`. Each is passed as `--model`. The default for all three is the strongest Claude model the subscription offers (Opus) _(my call, accuracy first)_. No code names a model.
- **Each call is locked down.** The flags below were seen in `claude --help` on 2.1.322. The builder confirms the exact spelling.
  - `-p` with the prompt on stdin, `--output-format json` and `--json-schema <schema>` for structured output.
  - `--system-prompt <ours>`, which replaces Claude Code's default prompt.
  - No tools: `--tools ""`, or whatever the CLI accepts for "none".
  - `--strict-mcp-config` with no MCP config.
  - `--setting-sources` set so this repo's hooks, settings and `CLAUDE.md` are not loaded. The builder checks whether `--bare` does this and still keeps the subscription sign-in.
  - `--no-session-persistence`.
  - It runs from an empty temporary working directory, never the repo. So even a mistake can't reach `private/`.
- **The subscription, not a key.** The child process's environment has `ANTHROPIC_API_KEY` (and any other Anthropic key variable) removed, so `claude` uses the signed-in subscription. It's never billed to a key by accident.
- **One call at a time** _(my call)_. A form has a handful of questions, the runner keeps a human pace, and this stays well inside subscription limits.
- **Failures.**
  - A timeout, a crash or unreadable JSON is retried up to 2 times. After that the question blocks as `model-error`.
  - A sign-in problem, or the subscription's usage limit, **throws** instead of blocking, because every later question would fail the same way. The caller (slice 06) stops the run.
  - The builder finds out how `claude -p` reports these. Exit code and JSON fields are the usual places.
- **Prompt and stderr are never logged.** Both contain the bank.
- **Wrapped behind an interface.** `ModelCaller` takes a role, a system prompt, a user prompt and a schema, and returns JSON. The `claude -p` caller implements it, and unit tests use a fake. If Phase 3 needs an API key on a server, that becomes a second implementation.
- **The runner is the parent process.** The guard hook never sees these calls, because they are child processes of the runner, not Claude Code tool calls. A `claude -p` run started by the runner can't act anyway, because it has no tools.

## Optional questions

Every question gets an attempt _(user)_. When the bank can't back an answer to an **optional** question, the result is still `blocked`, with `required: false`. The caller decides: block the run, or leave the question empty and say so in the report. My lean for slice 06 is to leave it empty, because a blank optional answer claims nothing. That decision belongs to slice 06's spec.

## The golden set and eval

Two sets share one format and one command.

### Case format

The format is YAML, one file per set. Each case looks like this:

```yaml
- id: notice-bucket-under-two-weeks
  question:
    label: What is your notice period?
    type: select
    options: [Immediate, Less than 2 weeks, One month, More than one month]
    required: true
  job: default # a job post defined at the top of the file
  expect:
    status: backed
    value: Less than 2 weeks
    sources: [{ fact: 3 }] # bank index or id; must be among the result's sources
    derivation: bucket
- id: terraform-silent
  question:
    {
      label: Do you have experience with Terraform?,
      type: radio,
      options: [Yes, No],
      required: true,
    }
  expect: { status: blocked, reason: bank-silent }
- id: ai-review-question
  question:
    {
      label: How has AI changed the way you review code?,
      type: textarea,
      required: true,
    }
  expect:
    status: backed
    sources: [{ answer: ai-perspective }]
    mustNotClaim:
      [
        a percentage or time saved,
        a tool not in the bank,
        a team or company not in the bank,
      ]
```

- **`value`** is the exact expected value. For a short value on a real bank that only the author knows, it is `TODO-author` (below). Free text has no `value`.
- **`valueFrom: { answer: id }` or `{ field: key }`** is used only where the expected value is the bank entry's text as written. The eval looks it up at run time, so the case file never holds the value. A fitted value, such as a number from an amount or an option from a fact, uses `value` instead. That way the answerer's fitting code never grades itself.
- **`sources`** lists what must be among the result's sources. Facts are given by bank index, so the case file never quotes a fact.
- **`mustNotClaim`** lists things a text answer must not say. The judge (below) checks it.

### Scoring free text: the judge

The verifier is part of what's being tested, so it can't also grade the text answers. A third role, the **eval judge**, runs only in the eval and never on a real application. It is a fresh `claude -p` call that gets the answer, the bank, the job post and the case's `mustNotClaim`. It lists every claim about the author that has no source and isn't a fair inference, and every `mustNotClaim` it finds. Either one fails the case. On the **private** set, the eval also writes the full answers to `private/answers-eval/` so the author can read them. Claude never reads that folder.

### The committed set (example bank)

- `libs/answerer/golden/example.yaml`, run against `libs/fact-bank/fact-bank.example.yaml` and made-up job posts in the same file. Claude writes it, runs it and reads the full report.
- It covers every rule in "What counts as backed", and every block reason:
  - **Fields:** each field key; a label that only contains a field word (the "city you'd like to work in" case).
  - **Known answers:** one used as written; fitted to a dropdown; fitted to a number box; the wrong-period cited entry; a variant picked by `when`; each placeholder.
  - **Text:** a known answer adapted to a differently worded question; a fair inference; a claim that isn't a fair inference; an added number; a story reworded; two stories combined; a scenario no story fits; a "why this company" with no known answer (job post plus facts); a company claim not in the post.
  - **Math and choices:** math from a "since" fact with a month; math from one with only a year; a bucket; a boundary; silence on a yes/no; silence on one box of a multi-select; a consent box.
  - **Other blocks:** a cover-letter upload; an unknown field type; a `maxLength` too short for the answer.
- The example bank gains the few entries those cases need, such as "since" facts and a second link. It stays made-up.

### The private set (the author's bank)

- `private/answer-golden.yaml`, run against `private/fact-bank.yaml`. It is built from the author's ~40 known answers plus tricky variations: reworded questions, a different set of options, a number-only box, and a question that looks like an answer but should still block _(user)_.
- Claude can't read `private/`. So the author pastes the 40 answer ids and question texts (no answers) into the session. Claude then writes the cases into the session scratchpad. Expectations use `valueFrom`, bank indexes and ids. Where only the author knows the value, they say `value: TODO-author`. The author fills those in, reviews the file and moves it into `private/` _(my call)_. The eval refuses to run while any `TODO-author` is left.

### The command

- `runner answers eval [--set example|private] [--answer-model m] [--verify-model m] [--judge-model m] [--repeat n] [--case id]`, with the Nx target `runner:answers-eval`. The default set is `example`.
- It uses the author's subscription and is never run in CI.
- **The report** gives, per case:
  - pass or fail;
  - expected and actual status, reason and derivation;
  - source kinds and ids, and the inference count;
  - the judge's findings;
  - rounds, latency and cost.

  The **example** set's report also shows values. The **private** set's report shows only case ids: no value, no fact sentence, no question label, and judge findings as counts only. Both write a JSON report to `run-reports/answers-eval/`, which Claude can read. The private one is in its redacted form.

- **Bars.** The eval exits 1 unless both hold:
  - **No wrong backed answer.** This is the hard bar. A case fails it when the result is backed but the expected status is `blocked`; or a value or source doesn't match; or the judge finds an unsupported claim or a `mustNotClaim`.
  - **Few needless blocks.** Cases expected to be backed that came back blocked stay at or under 10% _(my call; the report shows the rate so the author can tighten it)_.
- **`--repeat n`** runs every case n times. A case passes only when every run passes, because model output varies _(my call)_. The builder runs `--repeat 3` on the example set before calling the slice done.

### Guard

`answers` and `answers-eval` are added to `RUNNER_SAFE_SUBCOMMANDS` in `.claude/hooks/guard.mjs`, with a guard test. They never touch the browser or LinkedIn. The command and safe-subcommand lists in `CLAUDE.md` are updated to match. Claude may run the example set freely. It runs the private set only when the author asks, since that sends the real bank to the model.

## Where the code lives

- **`libs/answerer`**, a new library _(my call)_. The runner calls it in slice 06, and later hosted workers may too. It holds:
  - the field mapping;
  - the prompts;
  - the generator and the verifier;
  - the checks and the expression parser;
  - the `ModelCaller` interface and the `claude -p` caller;
  - the redaction;
  - the golden loader, the judge and the scoring.
- **The `runner answers eval` command** lives in `apps/runner/src/commands/`, like `facts check`.
- **Unit tests** run in CI with a fake `ModelCaller`. They cover:
  - every check, including numbers in text;
  - the field mapping, including the whole-label rule;
  - the expression parser and year-only dates;
  - the regeneration loop;
  - the `claude -p` caller's arguments and its environment with the key removed;
  - the redaction (no value survives);
  - the rule that error text never holds a value.
- **No new model SDK dependencies.**

## Roadmap and `CLAUDE.md` changes in this slice

- **Roadmap:**
  - The "Mirror 10xjobs" decision no longer includes OpenRouter. LLM calls go through `claude -p` on the author's subscription _(user)_.
  - Slice 05's "Copy from" (the OpenRouter client) is replaced by the 10xjobs generate-then-verify pattern only.
  - Slice 05b's extractor is also a `claude -p` role.
  - Phase 3 notes that hosted runs need a different `ModelCaller`.
- **`CLAUDE.md`:**
  - The stack line "LLMs through OpenRouter" changes to `claude -p`.
  - The new library and the new commands are added.

## Left to the builder

- The exact prompts, as long as they state the rules above.
- The label patterns for field mapping, starting from what slice 06's saved LinkedIn snapshots show.
- The exact `claude -p` flags that give no tools, no settings and no hooks while keeping the subscription sign-in.
- Whether one verifier call checks a multi-select option by option or as a whole.
