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

- Nx 24 monorepo with pnpm, TypeScript strict with nodenext. The workspace is empty so far.
- Expected, mirroring 10xjobs, **not built yet**: NestJS API (webhook intake) and workers (browser runs), Next.js web app, Supabase (Auth and Postgres with per-user row-level security), Prisma, Redis queues, LLMs through OpenRouter, browsers on our own server. Each piece is decided in its own slice.
- **Set up** (slice 02): ESLint, Vitest and Prettier, all run through Nx.
- **Set up** (slice 03): Patchright (Playwright API) through our own bridge extension in the author's everyday Chrome (`apps/bridge-extension`, and the runner in `apps/runner`).

## Workflow

Build in small slices, one per session: brainstorm, then spec (`docs/superpowers/specs/`), then plan (`docs/superpowers/plans/`), then a branch and a PR to `main`.

## Commands

- `pnpm test:hooks` runs the guard hook tests.
- `pnpm test:scripts` runs the tests for the repo's own scripts (added in slice 02).
- `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm typecheck` run that target on all projects through Nx.
- `pnpm format` writes Prettier formatting and `pnpm format:check` checks it, on changed files; add `--all` for everything.
- `pnpm nx run runner:bridge-install` copies the bridge extension to the Windows side and creates the token.
- `pnpm nx run runner:bridge-check` starts the relay and opens and closes one blank window. It never touches LinkedIn.
- `pnpm nx run runner:bot-check` loads three public bot-detection pages and prints a pass/fail table. It never touches LinkedIn.
- `pnpm nx run runner:session` loads LinkedIn's feed once and reports whether the session is signed in.
- The runner's local config (the token, and an optional `RUNNER_RELAY_PORT`, default 9333) lives in the untracked `apps/runner/.env.local`, written by `bridge-install`.
- CI runs `nx affected` for lint, test, build and typecheck, and only on code changes.

## Roadmap

See [docs/roadmap/README.md](docs/roadmap/README.md): phases, slice order and the decisions locked for every slice.

## Guardrails

- `.env*` files (except `.env.example`) and the repo-root `private/` folder are off-limits. `.claude/hooks/guard.mjs` enforces this for file tools and Bash.
- Claude may push a feature branch only as `git push -u origin <branch>` and may open its PR to `main` with `gh pr create`. Claude never pushes `main`, force-pushes or deletes remote branches; `guard.mjs` blocks every other push form, and the human merges. `guard.mjs` also blocks `gh pr merge`, approving or retargeting PRs, PRs to anything but `main`, and `gh api` write calls.
- Credentials go only in untracked `.env*` files; personal data (resumes, facts) only in the untracked `private/` folder. Never commit either.
- Never commit or log LinkedIn session cookies or proxy credentials.
- `run-reports/` holds redacted run reports (no personal facts, no cookies). It is git-ignored and Claude may read it.
- Personal overrides go in `.claude/settings.local.json`.
- Prettier runs automatically on files Claude edits or writes.

## Running against LinkedIn

- The author runs every real submit and takes over when a form goes wrong.
- Claude debugs from `run-reports/` and from scrubbed page snapshots committed as fixtures.
- Claude may start a `--dry-run` against a real job only when the author asks in that session, and only a few a day.
- `guard.mjs` blocks runner launches without `--dry-run` (after the target or file, not in front of it). In `guard.mjs`, `RUNNER_NAME = 'runner'` and `RUNNER_SAFE_SUBCOMMANDS = ['bridge', 'bridge-install', 'bridge-check', 'bot-check', 'session']`.
- Claude may run `runner:session` only when the author asks in that session. `bridge-install`, `bridge-check` and `bot-check` never touch LinkedIn and need no ask.
- No scripts run in LinkedIn's page; the runner reads through locators only. An ESLint rule in `apps/runner` bans `evaluate`, `evaluateHandle`, `$eval`, `$$eval`, `evaluateAll`, `exposeFunction`, `exposeBinding` and `addInitScript`. The relay and extension also refuse cookie and storage reads, `Browser.close`, `Runtime.addBinding`, and `Page.addScriptToEvaluateOnNewDocument` (except Patchright's own empty-source utility-world script).
- From slice 07, a real submit also asks for a typed confirmation at the keyboard. Slice 14 removes that prompt when the runner goes unattended, and relaxes the guard's runner rule.

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
