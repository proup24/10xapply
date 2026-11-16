# Database

Postgres and Auth on Supabase, with the schema in a Prisma contract (`libs/database`, package `@xapply/database`). The contract is the only schema source, RLS policies included. There are no hand-written SQL files outside Prisma migrations.

## Daily use

The local stack uses `project_id = "xapply"`: API on 55321, DB on 55322. 10xjobs's stack can run alongside it.

- `pnpm db:start` and `pnpm db:stop` start and stop the local stack. `pnpm db:status` shows it.
- `pnpm db:reset` wipes the local database, applies the migrations and seeds the test users.
- `pnpm db:migrate` applies the migrations to the database in `DATABASE_URL`. `pnpm db:seed` seeds it.
- `pnpm db:types` regenerates `libs/database/src/supabase/database.types.ts`. CI fails if it is stale.
- `pnpm db:test` runs the RLS tests in `apps/db-tests` against the local stack. Run `eval "$(scripts/supabase-env.sh)"` first.

The library's own scripts (`db:emit`, `db:format`, `db:migration:plan`, `db:migration:status`, `db:migrate:show`, `db:verify`) are in `libs/database/package.json`.

## Changing the schema

1. Edit `libs/database/src/contract/contract.prisma`.
2. `pnpm --filter @xapply/database db:emit`.
3. `pnpm --filter @xapply/database db:migration:plan --name <name>`.
4. Move the committed ref to the new contract hash, or `db:migrate` stops at the old contract (the cloud deploy too):
   `pnpm --filter @xapply/database exec prisma migration ref set db <hash>`
   The ref is `libs/database/src/migrations/app/refs/db.json`; the plan prints the hash.
5. `pnpm db:reset`, then `pnpm db:types`, then `pnpm db:test`.
6. Open the PR. CI's `database` job runs on database-area PRs and on every push.
7. After CI passes on `main`, `.github/workflows/database-deploy.yml` migrates the cloud project. It uses the GitHub environment `prod` and the secret `DATABASE_URL`, and runs no seed.

Every Prisma command and the seed refuse a non-local `DATABASE_URL`, `DIRECT_DATABASE_URL` or `SUPABASE_URL` unless the shell sets the remote opt-in variable (`XAPPLY_ALLOW_REMOTE_DB`). Only CI sets it. A value written in `.env` never counts.

## Setup the author does once

1. Create the Supabase Cloud project in the dashboard (for example `10xapply`), in a region near the Hetzner server slice 11 will use.
2. Mirror the Auth settings from `supabase/config.toml` by hand: invite-only, so public sign-up is off.
3. Add the GitHub environment `prod` with the secret `DATABASE_URL`: the session pooler URL, port 5432. The deploy workflow fails until it exists, so merge the slice's PR after it exists.
4. Commit the project ref to `.claude/supabase-project.json` (`{ "projectRef": "<ref>" }`). It is null until then, and with no ref the guard refuses every Supabase project call.
5. Fill the local `.env` from `.env.example`. Keep the cloud block commented out unless you are doing something deliberate.

## What Claude may do

- **Supabase tools.** The guard holds them to an allowlist and to the ref in `.claude/supabase-project.json`. `execute_sql` takes one statement, a read or a write to `public` tables only. It refuses schema and privilege keywords, schema-qualified function calls (except `auth.uid` and `auth.jwt`) and a list of risky built-ins. `apply_migration`, notebooks and the project and branch tools are refused.
- **The Supabase CLI in Bash.** Only the local commands: `start`, `stop`, `status`, `gen types --local`, `gen signing-key`, `db reset` (local) and `migration list --local`. It must run from inside the repo, with no remote flags and no expansion tricks. Any Bash command mentioning the opt-in variable name is refused unless it is read-only.
- **Commit and PR text.** The guard refuses heredoc or `$(...)` commit and PR bodies that mention the CLI word. Use `git commit -F <file>` and `gh pr create --body-file <file>`.

## Known gaps

- **Free plan.** A free Supabase project pauses after a week without activity and has no downloadable backups. With only `users` and no account nothing is at risk yet. Slice 10 (the author's facts) should decide on the paid plan or a backup.
- **`execute_sql` is checked as text.** A cleverly written query could slip a schema change past it. The real protection is that the schema changes only through CI; drift would show as a failed `db:verify` or migration.
- **`db:verify` fails today** on two Supabase-owned objects (the auth `factor_type` enum and a `storage.objects` index), not on our tables.
- **The CLI name can be built at run time.** Text checks can't stop an interpreter assembling it. The CLI on this machine is signed in to the author's account, so signing it out closes this fully.
