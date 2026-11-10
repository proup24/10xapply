# Slice 01: Claude harness

Date: 2026-11-10
Status: draft
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 0, slice 01

## Intent

10xapply will drive the author's real LinkedIn account. The top risk is that account getting restricted or banned. This slice puts guardrails around Claude before there is any product code. Claude must not be able to read the author's secrets or personal facts, must not merge or push to `main`, and must not be able to run a real (non-dry-run) application against LinkedIn. Claude should still be able to help fully with development: editing code, running tests, and debugging failed runs from redacted reports.

It mirrors 10xjobs's harness (`/home/lab/apps/10xjobs/.claude/`) so the two repos stay alike.

## How Claude and the author split the work in Phase 1 _(user)_

- The author runs every real submit and watches the Chrome window. When a form goes wrong, the author takes over.
- Claude debugs from what a run leaves behind: the redacted run report and scrubbed page snapshots committed as fixtures. Claude fixes the code and adds a test that replays the broken step against the saved page.
- Claude may start a `--dry-run` against a real job, but only when the author asks in that session and only a few times a day. A dry run never submits.
- Claude never reads `private/` (facts, full run reports, the applied-jobs record, any browser profile copy).
- A real submit asks the author to type a confirmation at the keyboard before every submit in Phase 1 _(user)_. Claude's shell can't answer an interactive prompt, so this is the second lock behind the guard. That prompt is built in slice 07, not here. Slice 14 removes it when the runner goes unattended, and also relaxes the guard's runner rule.

## Goals

1. `.claude/hooks/guard.mjs` (PreToolUse) blocks:
   - reads, writes and searches of `.env*` (except `.env.example`) and of any `private/` path segment, through file tools and Bash, the same as 10xjobs;
   - every `git push` form except `git push [-u|--set-upstream] origin <branch>` where the branch isn't `main`/`master`, the same as 10xjobs;
   - every way Claude could merge or retarget a PR _(my call; 10xjobs's guard doesn't check `gh`)_. Until slice 02 decides on branch protection, the guard is the only lock:
     - `gh pr merge` in any form;
     - `gh pr edit` with `--base`/`-B`;
     - `gh pr review` with `--approve`/`-a`;
     - `gh api` write calls: a `-X`/`--method` other than `GET`, or any `-f`/`-F`/`--field`/`--raw-field`/`--input` without an explicit `GET` (gh turns those into a POST). Read-only `gh api` calls stay allowed, for example reading PR comments;
     - `gh pr create` with a `--base`/`-B` other than `main`. With no base it is allowed (the repo default is `main`);
   - any runner command that is not a dry run (see "Runner rule" below).
2. `.claude/hooks/format.mjs` (PostToolUse) runs the project's Prettier on files Claude edits or writes, copied unchanged.
3. `.claude/hooks/guard.test.mjs` covers every rule above, starting from 10xjobs's tests, with new cases for `gh` and the runner rule. It runs with `pnpm test:hooks` (`node --test ".claude/hooks/*.test.mjs"`).
4. `.claude/settings.json` gets the permissions and hooks, and keeps the existing `extraKnownMarketplaces` / `enabledPlugins` entries for Nx.
5. `run-reports/` at the repo root is git-ignored and Claude may read it. The runner (from slice 06) writes the redacted copy of each run report there. Its name must not contain a `private` segment, or the guard would block it.
6. `CLAUDE.md` is updated: Guardrails (mirroring 10xjobs's wording, plus `gh` and the runner rule), a new "Running against LinkedIn" section stating the split above, and a Commands note for `pnpm test:hooks`.

## Runner rule

The runner doesn't exist yet. Slice 03 creates it and names it. This slice builds the check and tests it with a placeholder name, so slice 03 only fills in configuration.

- At the top of `guard.mjs` there are two constants: `RUNNER_NAME` (the runner's Nx project name; its code lives in `apps/<name>/`) and `RUNNER_SAFE_SUBCOMMANDS` (subcommands that never touch the application form, which slice 03 may fill, for example a session check). The name is empty in this slice, so the check does nothing until slice 03.
- Only **launches** of the runner are checked. Developing the runner is never blocked: building, testing, linting, reading, diffing or committing its code, and commit messages that name it _(my call)_. A Bash command segment is a launch when either:
  - it's an Nx invocation of the runner project with a target that isn't one of the dev targets `build`, `test`, `lint`, `typecheck`. That covers `nx run <name>:<target>`, `nx <target> <name>` and `nx run-many`/`affected` with `-t` holding a non-dev target, whether called through `pnpm`, `pnpm exec` or `npx`. A `run-many`/`affected` with a non-dev target is blocked outright, since it may include the runner;
  - or it runs a file under `apps/<name>/` with `node`, `tsx`, `ts-node` or `pnpm exec`.
  Nested `bash -c` / `eval` commands are checked too, using the existing parser.
- The launch's **subcommand** is the Nx target, or for a file launch the first non-flag argument after the file. The launch is allowed only if the subcommand is in `RUNNER_SAFE_SUBCOMMANDS`, or if `--dry-run` comes **after** the launch token (the target or the file path). A `--dry-run` in front of it goes to `node` or `pnpm`, not to the runner, so it doesn't count. With Nx, arguments after `--` count as after the launch token.
- A runner name inside an unterminated quote is blocked (fail closed, like the push rule).
- Tests inject the name, for example `evaluate(event, { runnerName: 'fake-runner' })`. Blocked: `pnpm nx run fake-runner:apply <url>`, `node apps/fake-runner/dist/main.js apply <url>`, the same inside `bash -c "…"`, and `node --dry-run apps/fake-runner/main.js apply <url>`. Allowed: the same launches with `--dry-run` after the launch token, a safe subcommand, `pnpm nx test fake-runner`, `pnpm nx run fake-runner:build`, `git add apps/fake-runner`, `cat apps/fake-runner/src/x.ts`, `git commit -m "fake-runner: fix"`.
- Known gap, accepted: a launch that never names the runner (an alias, a script under another name) gets past the guard. The keyboard confirmation from slice 07 covers that. "Only when the author asks" and "a few a day" are rules in `CLAUDE.md`, not something the guard enforces.

## Permissions in `settings.json` _(my call, adapting 10xjobs to pnpm)_

- allow: `pnpm nx lint|test|typecheck|build|run-many|affected …`, `pnpm test:hooks`, read-only `git status|diff|log|show|branch` forms as in 10xjobs.
- ask: `git push:*`, `gh pr create:*`.
- deny: `Read(./.env)`, `Read(./.env.local)`, `Read(./private/**)`.
- hooks: guard on `Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob`, format on `Edit|MultiEdit|Write`, with the same commands as 10xjobs.

## Non-goals

- ESLint, Vitest, CI (slice 02). `test:hooks` uses Node's built-in test runner, so no new dependency.
- The runner, the redaction itself, the keyboard confirmation (slices 03, 06, 07).
- Counting or rate-limiting Claude's dry runs in the guard.
- Branch protection on GitHub (slice 02 decides).

## Anti-goals

- Any way for Claude to read `private/` or `.env*` that a test shows works.
- Weakening any 10xjobs guard rule while copying.

## Left to the builder

- Exact test cases beyond the ones named, and how the runner names are injected for tests.
- Whether the `gh` checks live in a function next to `gitPushProblem` or in a shared "command rule" helper.
- Exact `CLAUDE.md` wording, kept to the house style.
