# Slice 08: Supabase and the database

Status: draft, 2026-11-16. Implements slice 08 of the [roadmap](../../roadmap/README.md), under its locked decisions ("Mirror 10xjobs", "Build infrastructure only when a slice needs it").

## Intent

Slices 11 and 12 bring real 10xjobs matches into 10xapply, which gives the author jobs they are eligible for, and those jobs are what 07b's open items and 07c's misses need (see "Build order after 07b" in the roadmap). This slice gives them a database to land in. It copies 10xjobs's setup so the two apps can merge later:

- the Prisma contract as the only schema source, RLS included;
- a shared `libs/database` library;
- the local Supabase CLI stack;
- one Supabase Cloud project that CI migrates after a merge to `main`;
- the two-user isolation harness, plus a CI check that fails on any table without RLS.

It creates one table, `users`, tied to Supabase Auth. That is what the harness and the RLS pattern need. Slice 12 adds the match tables and slice 10 the facts, each as a harness registry entry.

## Goals

- A new auth user gets exactly one `public.users` row, created by the database.
- RLS is on for every table in `public`, written in the contract, and CI fails if a table has it off.
- The harness proves user A can't read, insert into, update or delete user B's `users` row, and that a signed-out client sees nothing. Later tables join it with one registry entry.
- The local stack runs side by side with 10xjobs's local stack.
- After a PR merges to `main` and CI passes, a workflow applies pending migrations to the cloud project. It never runs for pull requests.
- Claude can read and write rows in the cloud project through the Supabase tools, locked to that one project, and can never change its schema or manage projects.

## Non-goals

- Sign-in, invites, the web app (slice 09). No account is created in the cloud project in this slice.
- Match, held-match or fact tables (slices 12 and 10).
- The hosted API and its database connection (slice 11).
- A second cloud project for dev or prod. There is one project, and it holds the author's real data _(user)_.
- Storage buckets (slice 10 adds the resume bucket).

## Anti-goals

- **Fake data in the cloud project.** Test users, fixtures and the `db-tests` suite only ever touch the local stack. A local-only command pointed at the cloud project refuses to run.
- **A schema change reaching the cloud project outside CI.** That covers a hand-run `db:migrate`, a Supabase tool call such as `apply_migration`, or DDL through `execute_sql`.
- **Claude acting on another Supabase project.** The author's Supabase account also holds the 10xjobs projects.
- **A table without RLS**, or a user-owned table whose policy isn't a plain `"userId" = auth.uid()` check (`id = auth.uid()` on `users`).
- **Isolation tests that bypass RLS for the operation under test**, or that look for an error to prove isolation. These rules come from 10xjobs: RLS hides rows, so tests check outcomes.
- **Credentials in git, or in any file Claude reads.** The cloud database URL and the service-role key live only in untracked `.env*` files and GitHub secrets.

## Approaches

**The library and the stack.** There was one sensible way: copy 10xjobs's `libs/database`, `apps/db-tests`, the CI `database` job and `dev-database.yml`, keeping only what `users` needs. Hand-written Supabase SQL migrations were dropped because they break the locked rule that the Prisma contract is the only schema source.

**How Claude reaches the cloud project.** Two options were considered:

1. **Through the Supabase tools in the Claude session, checked by the guard.** Chosen _(user)_. No database password sits in a file Claude reads. The cost: tool calls only (no `psql` or scripts), and it depends on the author's Supabase sign-in in that session.
2. **A database URL in a file Claude may read**, for `psql` and scripts. Dropped, because it puts a full-access database password in plain text in the repo folder.

## Decisions

| Question                               | Decision                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How many cloud projects                | One, holding the author's real data _(user)_.                                                                                                                                       |
| Claude's access to the cloud project   | It may read and write rows _(user)_. The schema changes only through CI _(my call)_.                                                                                                |
| How Claude reaches it                  | The Supabase tools, locked by the guard to this one project _(user)_.                                                                                                               |
| Tables in this slice                   | `users` only _(my call)_.                                                                                                                                                           |
| Seeds on the cloud project             | None. The CI workflow migrates only. Local seeds create the test users _(my call)_.                                                                                                 |
| The author's account                   | Not created here. Slice 12 holds matches for an email with no account, and slice 09's invite creates the account _(my call)_.                                                       |
| Prisma and the extension pack versions | The same as 10xjobs: `prisma` 8.0.0-rc.28, `@prisma/orm-postgres` and `@prisma/orm-extension-supabase` 8.0.0-rc.21, `@prisma/cli-engine` 0.9.0 _(my call)_.                         |
| Local ports                            | 10xjobs's stack uses 54320–54329 and 8083. 10xapply's `config.toml` moves every port to its own block (for example 55320–55329 and 8084), with `project_id = "xapply"` _(my call)_. |
| Where `applications.json`'s rule goes  | The rule for `applications.json` (Claude may read it, never write it) does not apply yet. Slice 14 decides whether it carries over to the applied-jobs table.                       |

## Shape

### 1. `libs/database`

- Package `@xapply/database` at `libs/database`, following the workspace's existing TypeScript setup and the `@xapply/source` condition the other libs use.
- It holds the contract (`src/contract/contract.prisma`, plus the emitted `contract.json` and `contract.d.ts`), `prisma.config.ts`, `src/migrations/` (`app`, `supabase`, `snapshots`, `refs`, as 10xjobs lays them out), the seeds, the env loader and local guard (`src/env/`), the generated `src/supabase/database.types.ts`, and the framework-free client (`connection.source.ts`) if it is needed now.
- Entry points copied from 10xjobs where they have content: `.` (client and contract), `./env`, `./types`. Skip `./enums` until a table has an enum.
- Scripts on the package: `db:emit`, `db:format`, `db:migration:plan`, `db:migration:status`, `db:migrate` (behind the local guard), `db:migrate:show`, `db:verify`, `db:seed` (behind the local guard).
- Root scripts: `db:start` (with the signing-key script if 10xjobs still needs it), `db:stop`, `db:status`, `db:reset` (local only, hard-coded local URL as in 10xjobs, on the new port), `db:types`, `db:migrate`, `db:seed`, `db:test`.
- Env variable names use an `XAPPLY_` prefix where 10xjobs uses `XJOBS_` (`XAPPLY_SKIP_ENV_FILES`, `XAPPLY_ALLOW_REMOTE_DB`).

### 2. The contract

- `User`: `id` is a relation to the pack's `supabase:auth.AuthUser` with cascade delete, with no generated id. Add `Timestamps` (the 10xjobs mixin) and no other columns. There is no `email` column, as in 10xjobs, because Auth is the only copy.
- A hand-written migration adds the sign-up trigger, copied from 10xjobs's `users_from_auth`:
  - `public.handle_new_auth_user()`, `SECURITY DEFINER`, `search_path = ''`, inserts `(id)`;
  - an `AFTER INSERT ON auth.users` trigger;
  - `EXECUTE` revoked from `public`, `anon` and `authenticated`.
- RLS on `users`, for `authenticated` only:
  - select: own row;
  - update: own row (nothing to update yet, but it is the pattern);
  - insert: none (the trigger creates it);
  - delete: none (removal is an admin task: delete the auth user and it cascades).
- The migration history starts fresh. 10xjobs's migrations aren't copied, only its patterns.

### 3. `apps/db-tests`

- Copy the support layer from 10xjobs: `stack-env`, `pg`, `test-users`, `admin`, `registry`, `fixtures`, and `mailpit` only if a test needs it. Keep only what `users` uses.
- Tests:
  - `rls-enabled`: every table in `public` has RLS on (a direct catalog query);
  - `accounts`: one `users` row per new auth user, cascade on auth delete, and a user can't insert a second row or delete their own;
  - `isolation`: the registry-driven A/B checks, with `users` as the first entry;
  - `smoke`.
- The suite refuses to run unless its target is the local stack.

### 4. Guards on remote targets

These are copied from 10xjobs's `local-guard` and `assert-local`:

- `db:migrate` and `db:seed` exit 1 when the database URL isn't local, unless `XAPPLY_ALLOW_REMOTE_DB=1` is set. Only the CI workflow sets it.
- `db:reset` and `db:test` only ever target the local stack.
- `.claude/hooks/guard.mjs` blocks Claude from running a `db:*` command with `XAPPLY_ALLOW_REMOTE_DB` in it.
- The guard also covers raw `prisma` commands, not only the `db:*` wrappers _(my call)_:
  - The check sits in the env loader that `prisma.config.ts` uses, so every Prisma command goes through it: `prisma db migrate`, `db:verify`, `migration status` and so on.
  - A remote URL is refused without `XAPPLY_ALLOW_REMOTE_DB=1`, whether it comes from `.env` or the shell.
  - The read-only commands (`db:verify`, `db:migration:status`, `db:migrate:show`) refuse it too. Nothing in this slice needs to run them against the cloud project from a laptop, and CI is the one place the flag is set.
- `docs/database.md` says the cloud block in `.env` stays commented out unless the author is doing something deliberate.

### 5. CI

- `ci.yml` gains a `database` job, gated by a new `database` output of `scripts/ci-changes.mjs`. The output is true when `libs/database/`, `apps/db-tests/`, `supabase/`, the root `package.json` or the lockfile change. Add the job to `ci-ok`'s `needs`. Its steps copy 10xjobs's job:
  1. start the stack without studio, realtime, edge-runtime, imgproxy, logflare and vector;
  2. migrate;
  3. export the stack env;
  4. seed;
  5. check `database.types.ts` is current;
  6. run `db:test`;
  7. dump container logs on failure.
- A new workflow, `database-deploy.yml`, copied from 10xjobs's `dev-database.yml`:
  - it triggers on `workflow_run` of CI, completed on `main`, and runs only when the conclusion is success and the event was a push;
  - it uses the GitHub environment `prod`, with `cancel-in-progress: false` in the concurrency group;
  - it runs `db:migrate` with `XAPPLY_SKIP_ENV_FILES=1`, `XAPPLY_ALLOW_REMOTE_DB=1` and `DATABASE_URL` from secrets;
  - it has no seed step;
  - its run-name carries the head SHA, so slice 11's deploy can chain on it as 10xjobs's `deploy-engine.yml` does.
- CI runs only on code changes today. A merge that changes only the database still counts as a code change, so check that `ci-changes.mjs` triggers on it.

### 6. Claude and the Supabase tools

- The guard's `PreToolUse` matcher gains every MCP tool whose name contains `supabase` (`mcp__.*supabase.*`), not only the plugin's current prefix. A Supabase connector under another name is then still checked _(my call)_.
- The project's ref is committed in a small config file (for example `.claude/supabase-project.json`) once the author creates the project. A project ref isn't a secret.
- **An allowlist, not a denylist** _(my call)_. A Supabase tool not named below is refused, so a tool the server adds later is blocked until it is added here on purpose. The tools are named by their suffix after the server prefix.
  - **Allowed with the committed ref:**
    - `list_tables`, `list_extensions`, `list_migrations`, `get_advisors`, `get_project_url`, `get_publishable_keys`, `generate_typescript_types`, `query_logs` and `execute_sql`, with `project_id` equal to the ref;
    - `get_project`, with `id` equal to the ref.

    The builder checks each tool's argument name against the installed server's schemas and writes the guard tests from them.

  - **Allowed with no project:** `list_projects`, `list_organizations`, `get_organization` and `search_docs`.
  - **Everything else is refused**, including:
    - `apply_migration`;
    - the project and branch tools;
    - the edge function tools;
    - the notebook tools (`create_notebook`, `run_notebook` and the rest), because a saved notebook runs any SQL and would get around the `execute_sql` check;
    - `submit_feedback` and `delete_feedback`.
  - With no committed ref, every project-scoped call is refused.
- **`execute_sql`** runs as a privileged role and skips RLS, so the guard checks its text:
  - One statement only. It must start with `SELECT`, `WITH`, `INSERT`, `UPDATE` or `DELETE`.
  - Refused if it contains a schema or privilege keyword: `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COMMENT ON`, `SECURITY`, `DO`, `COPY`, `CALL`, `SET ROLE`.
  - **Writes reach only `public` tables** _(my call)_. An `INSERT`, `UPDATE` or `DELETE` (or a `WITH` that writes) naming `auth.`, `storage.`, `supabase_migrations.`, `extensions.`, `pg_` or Prisma's migration ledger schema is refused. Reads of them stay allowed. This keeps Claude from creating a cloud account through `auth.users` and its sign-up trigger, or from breaking the migration state CI relies on.
  - It is a coarse text check, an extra layer on top of the rule that the schema changes only through CI. The guard tests cover each refusal and a passing read and write on a `public` table.
- **The Supabase CLI in Bash is local-only** _(my call)_. The CLI on this machine is signed in, so without a rule Claude could reach any of the author's projects through it.
  - The guard allows `supabase start`, `stop`, `status`, `gen types` (without `--project-id`, `--linked` or `--db-url`), `gen signing-key`, `migration list --local` and `db reset` (local), and the root `db:*` scripts that wrap them.
  - It refuses everything else: `link`, `login`, `projects`, `orgs`, `secrets`, `functions deploy`, `db push`, `db pull`, `db dump`, `migration repair`, `branches`, and any `--project-ref`, `--linked` or `--db-url` flag. That holds whether the CLI is called as `supabase`, `pnpm exec supabase` or `npx supabase`.
- `CLAUDE.md`'s guardrails gain a line on all of this.

### 7. Setup the author does

These steps are written in a short `docs/database.md`:

1. Create the Supabase Cloud project in the dashboard (for example `10xapply`), in a region near the Hetzner server slice 11 will use. Claude can't create it.
2. Mirror the Auth settings from `config.toml` by hand: invite-only, so public sign-up is off.
3. Add the GitHub environment `prod` with the secret `DATABASE_URL` (the session pooler URL, port 5432). The deploy workflow fails until it exists, so merge this slice's PR after it exists.
4. Commit the project ref to the guard's config file. Claude can open that small PR once the author gives the ref.
5. Fill the local `.env` from `.env.example`. The example gains a local block and a commented cloud block with blank secrets.

## Branch

Branch `slice-08-database` from `main`. PR #9 (slice 07b) has merged, so its guard, settings and `CLAUDE.md` changes are already there _(my call)_.

## Left to the builder

- The file layout inside `libs/database` and `apps/db-tests`, and how much of 10xjobs's env loader is needed for one table.
- How the `@@rls` and policy blocks are written. Check the pack's docs against the installed version.
- The exact port block, as long as it clashes with nothing in 10xjobs's `config.toml`.
- Whether the guard's ref file is JSON or a constant in `guard.mjs`.
- Whether `database-deploy.yml` is its own workflow or a job in `ci.yml` gated on `main`, as long as it runs only after CI passes on a push to `main`.

## Known gaps

- **Free-plan limits.** A free Supabase project pauses after a week without activity and has no downloadable backups. With only `users` and no account, nothing is at risk yet. Slice 10 (the author's facts) should decide whether the project needs the paid plan or a backup.
- **The `execute_sql` check is textual.** A cleverly written query could slip a schema change past it. The real protection is that the schema changes only through CI; drift would show up as a failed `db:verify` or migration.

## Done when

- `pnpm db:start` runs while 10xjobs's stack is up, and `pnpm db:reset` builds the schema and seeds the test users locally.
- A new auth user gets exactly one `users` row. The harness proves isolation on `users`. `rls-enabled` fails if a table has RLS off.
- The CI `database` job passes on the PR, and `nx run-many -t lint test build typecheck` passes.
- After merge, `database-deploy.yml` migrates the cloud project, and `users` exists there with RLS on.
- `pnpm test:hooks` covers the Supabase rules:
  - the tools: a wrong project, a tool not on the allowlist, a notebook tool, DDL through `execute_sql`, a write to `auth.users`, and no ref committed;
  - the CLI: `link`, `db push`, `--project-ref` and `--db-url`.
- A raw `prisma db migrate` with a remote `DATABASE_URL` and no flag exits 1.
