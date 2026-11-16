# 10xapply

## What this is

10xapply applies to LinkedIn jobs from users' own LinkedIn accounts. It receives job matches from 10xjobs (a separate app that matches engineers with jobs) by webhook. It stores them, lets the user approve each one, and then runs an application through that user's LinkedIn session.

It is an experiment, kept apart from 10xjobs so the risky LinkedIn automation cannot harm the main product. It follows 10xjobs's conventions so the two can merge later.

## Top risk and anti-goals

The number one risk is LinkedIn detecting automated behaviour and restricting or banning a user's account. It ranks above speed, volume and convenience.

Failure even if it technically works:

- A user's LinkedIn account gets flagged, restricted or banned.
- Applying to a job the user did not approve.
- Submitting a wrong or invented answer on an application form.
- Applying twice to the same job.
- Leaking a user's LinkedIn session.

## Decisions so far

- **Separate from 10xjobs.** Separate users, sign-in, database and servers. The only link is webhooks and API keys with a payload 10xapply defines.
- **Webhooks.** 10xjobs posts one signed webhook per match, authenticated by a single integration API key. The payload carries the user's email and the job. The email is the only data the two apps share; 10xapply matches it to its own user. Matches for an unknown email are held until that person signs up. Intake is idempotent on the job.
- **Approval.** The user approves each match in 10xapply's web app; only then does the engine queue an application run.
- **Facts and answers.** 10xapply keeps its own per-user fact bank (contact details, resume, work authorization, skills, salary, and so on). An LLM answers each form question from it. When the facts don't support a confident answer, the run stops and asks the user.
- **LinkedIn access.** The user signs in once through a browser we host, in a live view they drive themselves; we keep the session and ask them to sign in again when it expires. We never see or store their password. A Chrome extension that captures cookies is a possible later option.
- **Browsers on our own servers.** No third-party browser services: their IPs and fingerprints are shared with other automation customers. Each user gets a persistent browser profile (same device every time) and a dedicated static residential (ISP) IP from a proxy provider, in or near their own location; never datacenter IPs. Runs go at a human pace, one at a time per account, with daily caps, and stop on captchas, security checks or unfamiliar forms.
- **Users.** The author first, then a few friends; a wider audience only in the far future.

## Stack

- Nx 24 monorepo with pnpm, TypeScript strict with nodenext. Seven projects so far: the runner (`apps/runner`, a Node CLI), the bridge extension (`apps/bridge-extension`, plain-JS MV3), `libs/fact-bank` (the fact bank's schema, loader and check), `libs/answerer` (answers form questions from the bank through `claude -p`, plus its golden eval) `libs/disqualify` (the disqualification extractor, rules, decision and golden eval), `libs/database` (the Prisma contract, migrations, seed and env guard) and `apps/db-tests` (the RLS tests).
- Expected, mirroring 10xjobs, **not built yet**: NestJS API (webhook intake) and workers (browser runs), Next.js web app, Redis queues, LLMs through `claude -p` on the author's subscription, browsers on our own server. Each piece is decided in its own slice.
- **Set up** (slice 02): ESLint, Vitest and Prettier, all run through Nx.
- **Set up** (slice 08): Supabase (Auth and Postgres with per-user row-level security) and Prisma, a local stack plus one cloud project. See [docs/database.md](docs/database.md).
- **Set up** (slice 03): Patchright (Playwright API) through our own bridge extension in the author's everyday Chrome (`apps/bridge-extension`, and the runner in `apps/runner`).

## Workflow

Build in small slices, one per session: brainstorm, then spec (`docs/superpowers/specs/`), then plan (`docs/superpowers/plans/`), then a branch and a PR to `main`.

## Commands

- `pnpm test:hooks` runs the guard hook tests.
- `pnpm db:start`, `db:stop` and `db:status` run the local Supabase stack (API 55321, DB 55322, alongside 10xjobs's). `db:reset` rebuilds and seeds it, `db:migrate` and `db:seed` run against `DATABASE_URL`, `db:types` regenerates the Database type, and `db:test` runs the RLS tests (after `eval "$(scripts/supabase-env.sh)"`).
- `pnpm test:scripts` runs the tests for the repo's own scripts (added in slice 02).
- `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm typecheck` run that target on all projects through Nx.
- `pnpm format` writes Prettier formatting and `pnpm format:check` checks it, on changed files; add `--all` for everything.
- `pnpm nx run runner:bridge-install` copies the bridge extension to the Windows side and creates the token.
- `pnpm nx run runner:bridge-check` starts the relay and opens and closes one blank window. It never touches LinkedIn.
- `pnpm nx run runner:bot-check` loads three public bot-detection pages and prints a pass/fail table. It never touches LinkedIn.
- `pnpm nx run runner:bot-check-repeat` runs `bot-check` three times in a row and records the runs. It never touches LinkedIn.
- `pnpm nx run runner:bridge-check-crash` runs the bridge check then crashes the run tab and checks that the run stops (`crash stop: ok`). It never touches LinkedIn.
- `pnpm nx run runner:pace-record` records the author's own timing while they browse by hand. It only listens.
- `pnpm nx run runner:pace-record-typing` serves a local page of text boxes so the author can record typing gaps. The text is never kept.
- `pnpm nx run runner:pace-summary` prints how much recorded data there is per pace input, and "enough" or "short" for each.
- `pnpm nx run runner:pace-build` builds the pace profile from the recordings.
- `pnpm nx run runner:pace-practice` has the runner fill the local practice page five times, recorded for the comparison.
- `pnpm nx run runner:pace-compare` compares the runner's recordings with the author's and writes a report.
- `pnpm nx run runner:facts-check [-- <path>]` checks the fact bank file, the disqualify rules file (`disqualify.yaml` in the private folder) and the misses file when it exists, and prints counts and problems, never a value or a country code. The optional path is the bank's, resolved from the repo root. In a non-TTY shell add `--outputStyle=stream` to see its output.
- `pnpm nx run runner:answers-eval [-- --set example|private|misses --answer-model m --verify-model m --judge-model m --repeat n --case id]` runs the answerer's golden eval. It uses the subscription, never in CI. The default set is `example`. The private set prints and reports only ids and counts, and writes the full results under `private/answers-eval/`. The misses set runs the answered misses from `private/answer-misses.yaml` against the private bank, and prints and reports ids and counts only, like the private set.
- `pnpm nx run runner:disqualify-eval [-- --model m --repeat n --case id]` runs the disqualification extractor's golden eval on the committed example set. It uses the subscription, never in CI, and never touches LinkedIn. In a non-TTY shell add `--outputStyle=stream` before the `--` (after it, the runner rejects the flag).
- `pnpm nx run runner:apply -- <job-url> [--dry-run]` walks an Easy Apply form, answers and fills it. Without `--dry-run` it also submits (author mode only, else exit 2); with `--dry-run` it stops on the review page. It needs the disqualify rules file and can end `disqualified` (on the job page or a form step, for a work authorization or a location requirement) before filling anything. Both modes consult the applied-jobs record (refusing an `applied` or `disqualified` job before a window opens) and record LinkedIn's Applied marker and disqualifications; only a real run writes `submitting` or `failed`. It prints a closing line.
- Quote a long LinkedIn job URL given to `runner:apply`, or replace it with `https://www.linkedin.com/jobs/view/<id>/`: an unquoted `&` backgrounds the command.
- `pnpm nx run runner:snapshot -- <job-url>` opens the job in a run window while the author drives by hand and presses Enter to save each page's DOM (shadow roots included) under the private folder's `snapshots/`. It touches LinkedIn.
- `pnpm nx run runner:snapshot-scrub` turns the raw snapshots into scrubbed copies in `snapshots/`, then leak-checks every scrubbed file against the bank. It prints counts only (per leaking file its name, kinds and counts) and a `leaks: <n>` line, and exits 1 on any leak. It never touches LinkedIn.
- `pnpm nx run runner:session` loads LinkedIn's feed once and reports whether the session is signed in.
- `bridge-install` also copies a 1-byte practice PDF next to the extension, for the upload check.
- The runner's local config (the token, and an optional `RUNNER_RELAY_PORT`, default 9333) lives in the untracked `apps/runner/.env.local`, written by `bridge-install`.
- CI runs `nx affected` for lint, test, build and typecheck, and only on code changes.

## Roadmap

See [docs/roadmap/README.md](docs/roadmap/README.md): phases, slice order and the decisions locked for every slice.

## Guardrails

- `.env*` files (except `.env.example`) are off-limits. Claude may read and write the repo-root `private/` folder, except `applications.json` (see below), and never commits anything from it. `.claude/hooks/guard.mjs` enforces this for file tools and Bash.
- Claude may push a feature branch only as `git push -u origin <branch>` and may open its PR to `main` with `gh pr create`. Claude never pushes `main`, force-pushes or deletes remote branches; `guard.mjs` blocks every other push form, and the human merges. `guard.mjs` also blocks `gh pr merge`, approving or retargeting PRs, PRs to anything but `main`, and `gh api` write calls.
- Credentials go only in untracked `.env*` files; personal data (resumes, facts) only in the untracked `private/` folder. Never commit either.
- Never commit or log LinkedIn session cookies or proxy credentials.
- `run-reports/` holds redacted run reports (no personal facts, no cookies). It is git-ignored and Claude may read it.
- `snapshots/` holds scrubbed page snapshots only. It is git-ignored and Claude may read it. Raw snapshots go to the private folder's `snapshots/`, and full run reports to its `runs/`; Claude may read both.
- `pace-recordings/` holds timing-only recordings and the pace profile. It is git-ignored, Claude may read it, and it is never committed.
- The author's fact bank is `fact-bank.yaml` in the private folder (`private/`). Claude may read and edit the file, and runs `facts-check` after an edit.
- The author's disqualification rules are `disqualify.yaml` in the private folder (`authorizedCountries` and `locatedIn`). Claude may read and edit it, and runs `facts-check` after an edit.
- The applied-jobs record is `applications.json` in the private folder. The runner writes it. Claude may read it, never write it; the guard blocks writes. Clear an entry by editing it by hand (the web app later).
- The misses record is `answer-misses.yaml` in the private folder. The runner writes it after each apply run, listing the questions it could not answer. Claude may read and edit it.
- Claude may read and write rows in 10xapply's Supabase project through the Supabase tools only, and the guard holds it to the ref in `.claude/supabase-project.json`. The schema changes only through CI (`database-deploy.yml`). The Supabase CLI is local-only. `XAPPLY_ALLOW_REMOTE_DB` is CI's alone.
- Personal overrides go in `.claude/settings.local.json`.
- Prettier runs automatically on files Claude edits or writes.

## Running against LinkedIn

- The author runs every real submit and takes over when a form goes wrong.
- Claude debugs from `run-reports/`, the full reports under the private folder's `runs/`, and scrubbed page snapshots committed as fixtures.
- Claude may start a `--dry-run` against a real job only when the author asks in that session, and only a few a day.
- `guard.mjs` blocks runner launches without `--dry-run` (after the target or file, not in front of it). In `guard.mjs`, `RUNNER_NAME = 'runner'` and `RUNNER_SAFE_SUBCOMMANDS = ['bridge', 'bridge-install', 'bridge-check', 'bridge-check-crash', 'pace', 'pace-record', 'pace-record-typing', 'pace-summary', 'pace-build', 'pace-practice', 'pace-compare', 'bot-check', 'bot-check-repeat', 'session', 'facts', 'facts-check', 'answers', 'answers-eval', 'disqualify', 'disqualify-eval', 'snapshot', 'snapshot-scrub']`.
- The guard treats any `node -e` script that names `apps/runner`, and `node <path>` in a command that names `apps/runner` elsewhere, as a runner launch; use a test file run through `pnpm nx test runner` for offline reads instead.
- Claude may run the answers eval on the example set, the private set and the misses set.
- Claude may run `runner:session` or `runner:snapshot` only when the author asks in that session. Every other safe subcommand (the bridge, `pace`, bot-check, `facts`, `answers` and `disqualify` ones) never touches LinkedIn and needs no ask.
- Author mode (stdin and stdout are TTYs and `CLAUDECODE` is unset) is the only mode that prints labels, answers or bank text, or reads the keyboard; any other run prints redacted output.
- No scripts run in LinkedIn's page; the runner reads through locators only. An ESLint rule in `apps/runner` bans `evaluate`, `evaluateHandle`, `$eval`, `$$eval`, `evaluateAll`, `exposeFunction`, `exposeBinding` and `addInitScript`. The relay and extension also refuse cookie and storage reads, `Browser.close`, `Runtime.addBinding`, and `Page.addScriptToEvaluateOnNewDocument` (except Patchright's own empty-source utility-world script). On a run tab's sessions they pass only three `Target.*` methods: `setAutoAttach`, `detachFromTarget` and `getTargetInfo`.
- Only the pace module (`apps/runner/src/pace/`) acts on a page; other code calls `pace.click`, `pace.type` and so on. ESLint bans Patchright input methods elsewhere.
- The runner's file uploads go through the relay (`DOM.setFileInputFiles` on a Windows-side path), not Patchright's setFiles.
- The recorder's LinkedIn match is `https://www.linkedin.com/*`, because LinkedIn is a single-page app. It records only on `/jobs/` paths.
- The recorder captures timing and event shape plus numbers only (target box size, press offset, option counts, description length, window geometry). It never captures text or which key was pressed; it records only a key class (space, backspace, other) for key gaps.
- The recorder's content script exists only while a recording command runs.
- Slice 14 relaxes the guard's runner rule and the author-mode-only submit when the runner goes unattended.

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->
