# Slice 02: Tooling and CI

Date: 2026-11-10
Status: approved
Roadmap: [docs/roadmap/README.md](../../roadmap/README.md), Phase 0, slice 02

## Intent

Every PR to `main` should be checked for everything it could break, and only for that. 10xjobs's CI is slow mainly because it runs everything on every PR, including starting the whole Supabase stack for docs-only changes. It also misses checks: Prettier, the hook tests, migration drift and e2e never run in CI _(user: "ci processes should run conditionally to save us from redundancies")_.

This slice sets up linting, testing and formatting through Nx, plus one CI workflow that decides at the start which jobs a change needs. The workspace has no projects yet, so the database job (slice 08) and the e2e job (slice 09 or later) don't exist here. This slice leaves a defined place for them, so those slices add a job without redesigning CI.

## What 10xjobs does today (for reference)

Read from `/home/lab/apps/10xjobs/.github/workflows/ci.yml`, `nx.json`, `eslint.config.mjs`, `vitest.config.mts`:

- `main` job: `nx run-many -t lint test build typecheck` (every project, every PR), then `nx fix-ci` (Nx Cloud).
- `database` job, on every PR: `supabase start` (most services), Prisma migrate, seed, a check that the generated types are current, RLS tests.
- Missing: no Prettier check, no `test:hooks`, no e2e in CI, no migration drift check, and no `concurrency` cancel.

## Goals

1. **Local tooling through Nx, copied from 10xjobs:**
   - ESLint flat config at the root (`eslint.config.mjs`, from 10xjobs), with `@nx/eslint/plugin` registered in `nx.json` as target `lint`.
   - Vitest root config (`vitest.config.mts`, from 10xjobs), with `@nx/vitest` registered in `nx.json` as target `test`.
   - Prettier stays as it is (`.prettierrc` with `singleQuote`). Root scripts `format` (write) and `format:check` (check), both through `nx format`.
   - Root scripts `lint`, `test`, `typecheck`, `build` that call `nx run-many -t <target>`, so they're easy to run by hand.
   - `CLAUDE.md` Commands section lists the new scripts.
2. **Version alignment with 10xjobs** _(my call)_: Nx and `@nx/*` to 24.0.2 and pnpm to 12.15.0 (`packageManager`), so config copied between the repos behaves the same. `pnpm-lock.yaml` regenerated. If moving pnpm from 10 to 12 breaks anything, keep pnpm 10 and note it in the PR.
3. **One workflow, `.github/workflows/ci.yml`**, on `pull_request` to `main` and on `push` to `main`:
   - `concurrency` keyed on the workflow and ref, with `cancel-in-progress: true` _(my call)_, so a new push to a PR cancels the older run. Pushes to `main` are not cancelled.
   - `permissions: contents: read` (and `actions: read` if `nx-set-shas` needs it).
   - **`changes` job** (runs first): works out which areas changed and exposes them as job outputs. Slice 02 defines:
     - `hooks`: anything under `.claude/hooks/`.
     - `code`: anything that isn't only docs (`docs/**`, `**/*.md`). CI files, `package.json`, the lockfile, `nx.json`, `tsconfig*` and ESLint/Vitest/Prettier config all count as code.
     - Placeholders, documented in a comment and not yet wired: `database` (`libs/database/prisma/**`, migrations, `supabase/**`) for slice 08, and `web` for slice 09. For `web`, `nx show projects --affected` is more accurate than paths, since it includes the libraries the web app depends on.
   - **`checks` job** (always runs, needs `changes`): checkout with full history, pnpm, Node 24 with the pnpm cache, `pnpm install --frozen-lockfile`, `nrwl/nx-set-shas` for the affected base. Then:
     - `pnpm nx format:check` on the affected files (always, so docs are format-checked too);
     - `pnpm test:hooks` when `hooks` changed, and always on push to `main`;
     - `pnpm nx affected -t lint test build typecheck` when `code` changed.
   - **Nx local cache** saved between runs with `actions/cache` on `.nx/cache`, keyed on the lockfile and the commit, restoring from the newest match _(my call)_. No Nx Cloud _(user)_: no `nxCloudId`, no `nx fix-ci`, no `start-nx-agents`.
   - **`ci-ok` gate job** _(my call)_: `needs` every other job, `if: always()`, and fails unless each needed job is `success` or `skipped`. It is the one check a future branch protection would require, so jobs that only run sometimes never leave a required check waiting. Slices 08 and 09 add their jobs to its `needs` list.
4. **Proof the pipeline works on a real project.** There are no projects yet, so `nx affected` has nothing to run, and CI only triggers on PRs to `main`. The author doesn't squash-merge _(user)_, so the probe never touches the slice's own branch:
   - Once the slice branch has the finished CI, branch a throwaway `ci-probe` branch off it. Add a small project (for example `packages/ci-probe` with one passing test and one lint rule it can break), push, and open a **draft PR to `main`** titled as not-for-merge.
   - Check on that PR that CI runs lint, test, build and typecheck for the probe; that a deliberate failure turns `ci-ok` red; that a docs-only commit skips the `code` steps; and that a push cancels the older run.
   - Close that PR unmerged. The author deletes the remote `ci-probe` branch (Claude can't).
   - The slice's own PR is opened normally and links the probe PR's runs as evidence. Any CI fixes the probe uncovers are made on the slice branch, not the probe branch.

## Decisions

- **No Nx Cloud** _(user)_. Speed comes from `nx affected`, the local Nx cache, the pnpm cache and skipping jobs.
- **Jobs run only when their area changed** _(user)_. The database and e2e jobs follow the same pattern when they arrive.
- **No branch protection for now** _(user)_. The repo is private on the free GitHub plan, and GitHub refuses protection and rulesets ("Upgrade to GitHub Pro or make this repository public"). The author keeps the admin override anyway, and the guard already stops Claude from merging. CI still runs and reports on every PR. If the plan changes, protection is one rule: require the `ci-ok` check and a PR before merging, with admins allowed to bypass _(user)_. The spec doesn't build that.
- **The migration drift check belongs to slice 08** _(user agreed)_. Recorded here so slice 08 picks it up: `prisma migrate diff` from the migrations to the schema with `--exit-code`, in the database job, next to the check that the generated types are current and the RLS tests. RLS policies written as SQL in migrations aren't covered by the diff; the RLS tests cover them.
- **CI commands stay inside the guard's rules.** `nx affected -t lint test build typecheck` uses only dev targets, which the slice-01 guard allows.

## Non-goals

- Database, migration drift, RLS or e2e jobs (slices 08 and 09).
- Deploy workflows (slice 11).
- Changing 10xjobs's CI. The findings above can go to that repo separately.
- Branch protection (not available on the current plan).
- Remote caching of any kind.

## Anti-goals

- A docs-only PR that waits on lint, test, build or typecheck.
- A PR that breaks something CI could have caught but skipped, because the "what changed" rules were too narrow. When in doubt, a path counts as `code`.
- A required check that can sit "waiting" forever because its job was skipped.
- Secrets in CI. This slice needs none.

## Left to the builder

- How `changes` detects paths: `dorny/paths-filter` pinned to a commit SHA, or a short `git diff --name-only` script against the base from `nx-set-shas`. Either is fine; a third-party action must be pinned by SHA.
- Exact cache keys, and whether the format check uses `--base`/`--head` or `--all` when the affected set is small.
- `targetDefaults` and `namedInputs` in `nx.json` (for example `production` excluding test files, and `sharedGlobals` including `.github/workflows/ci.yml` as 10xjobs does).
- Which ESLint and Vitest plugin packages and versions to install, matching 10xjobs.
