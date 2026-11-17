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

## Tables

- `users`: one row per Auth user. `authenticated` has SELECT and UPDATE (own row).
- `intake_links`: a user's intake token hash and 10xjobs secret. RLS on, no policies; `service_role` only.
- `webhook_deliveries`: every webhook delivery received. RLS on, no policies; `service_role` only.
- `matches`: job matches from 10xjobs. `authenticated` has SELECT (own rows, policy `matches_owner_read`); writes are `service_role` only.

## Changing the schema

1. Edit `libs/database/src/contract/contract.prisma`.
2. `pnpm --filter @xapply/database db:emit`.
3. `pnpm --filter @xapply/database db:migration:plan --name <name>`.
4. Move the committed ref to the new contract hash, or `db:migrate` stops at the old contract (the cloud deploy too):
   `pnpm --filter @xapply/database exec prisma migration ref set db <hash>`
   The ref is `libs/database/src/migrations/app/refs/db.json`; the plan prints the hash.
   `prisma migration ref set` wipes the ref's `invariants`. Restore them by hand (step 5 says how), or the data-only migrations stop running.
   A unit test in `libs/database` (`src/contract/db-ref.spec.ts`) fails while the ref is behind the contract or the newest migration.
5. Give a new table its own `GRANT`s in the migration (a raw SQL step, as in `init_users`). Nothing is granted by default: `tighten_users_grants` removed `public`'s default table and sequence grants to `anon` and `authenticated` (the cloud project had them, the local stack sets `auto_expose_new_tables = false`). Without a grant, `authenticated` and `service_role` get error 42501. Grant `anon` nothing unless the table is public, and add the table's `authenticated` privileges to `apps/db-tests/src/grants.db.spec.ts`, which fails on any other grant.
   A change with no contract change (grants, functions) is a data-only migration: `prisma migration new --name <name> --from <current hash>`, then run its `migration.ts` with node to emit it. Give its `rawSql` step an `invariantId` and add that id to `invariants` in `refs/db.json`, as `tighten_users_grants` does, or it never runs.
6. `pnpm db:reset`, then `pnpm db:types`, then `pnpm db:test`.
7. Open the PR. CI's `database` job runs on database-area PRs and on every push.
8. After CI passes on `main`, `.github/workflows/database-deploy.yml` migrates the cloud project. It uses the GitHub environment `prod` and the secret `DATABASE_URL`, and runs no seed.

Every Prisma command and the seed refuse a `DATABASE_URL`, `DIRECT_DATABASE_URL` or `SUPABASE_URL` that is not this repo's local stack, unless the shell sets the remote opt-in variable (`XAPPLY_ALLOW_REMOTE_DB`). Local means `127.0.0.1`, `localhost` or `::1` on port 55321 or 55322, so 10xjobs's local stack (543xx) is refused too. Only CI sets the opt-in. A value written in `.env` never counts.

## Setup the author does once

1. Create the Supabase Cloud project in the dashboard (for example `10xapply`), in a region near the Hetzner server slice 11 will use.
2. Mirror the Auth settings from `supabase/config.toml` by hand: invite-only, so public sign-up is off.
3. Add the GitHub environment `prod` with the secret `DATABASE_URL`: the session pooler URL, port 5432. The deploy workflow fails until it exists, so merge the slice's PR after it exists.
4. Commit the project ref to `.claude/supabase-project.json` (`{ "projectRef": "<ref>" }`). It is null until then, and with no ref the guard refuses every Supabase project call.
5. Fill the local `.env` from `.env.example`. Do not put the cloud `DATABASE_URL` in `.env` on this machine: CI holds it, and nothing local needs it. The commented block in `.env.example` only shows the URL's shape.
6. Sign the Supabase CLI out on this machine (`supabase logout`) whenever you don't need it signed in. The local stack needs no sign-in, and Claude's cloud work goes through the Supabase tools. The known gaps say why this matters.

## What Claude may do

- **Supabase tools.** The guard holds them to an allowlist and to the ref in `.claude/supabase-project.json`. `execute_sql` takes one statement, a read or a write to `public` tables only. It refuses schema and privilege keywords, schema-qualified function calls (except `auth.uid` and `auth.jwt`), a list of risky built-ins (`set_config`, `setval`, `nextval` and others), every `pg_*` function off a short read list, `U&"…"` identifiers and queries over 20,000 characters. `apply_migration`, notebooks and the project and branch tools are refused.
- **The Supabase CLI in Bash.** Only the local commands: `start`, `stop`, `status`, `gen types --local`, `gen signing-key`, `db reset` (local) and `migration list --local`. It must run from inside the repo, with no remote flags and no expansion tricks. Any Bash command mentioning the opt-in variable name is refused unless it is read-only.
- **Commit and PR text.** The guard refuses heredoc or `$(...)` commit and PR bodies that mention the CLI word. Use `git commit -F <file>` and `gh pr create --body-file <file>`.
- **The folder name.** `supabase` as a folder given to `git`, `ls`, `prettier`, `tar`, `find`, `grep`, `rm`, `mkdir`, `cp`, `mv` or `echo` is not a CLI call (`git add supabase libs/database`). With any other command, write `supabase/`.

## Known gaps

- **Free plan.** A free Supabase project pauses after a week without activity and has no downloadable backups. With only `users` and no account nothing is at risk yet. Slice 10 (the author's facts) should decide on the paid plan or a backup.
- **`execute_sql` is checked as text.** A cleverly written query could slip a schema change past it. The real protection is that the schema changes only through CI. Drift shows only as a failed migration on a later deploy, until the Prisma pack matches the platform and `db:verify` can pass (next point).
- **`db:verify` fails today** on two Supabase-owned objects (the auth `factor_type` enum and a `storage.objects` index), not on our tables. So it cannot detect drift yet.
- **The CLI and opt-in rules stop direct commands only.** The guard reads the text of each Bash command. It refuses a command that names the CLI with a remote subcommand or flag, and a command that sets the opt-in variable. It does not stop any of these:
  - a script file in the repo, old or new, that holds the CLI command or sets the opt-in (`bash scripts/x.sh`, `./x.sh`). The guard does not read what the Write tool puts in a file;
  - a new package script that does the same (`pnpm run x`);
  - a name built from a variable or by an interpreter (`v=…; export "${v}…"`, `python3 -c`, `node -e`);
  - a tool that runs a shell with the env files loaded (`dotenv -- sh -c …`), or a direct `psql` to a cloud URL. Neither goes through the library's local-only check.

  A session working in good faith takes none of these paths, so the rules catch mistakes, not intent. The real barriers are two facts about this machine, and both are the author's to keep:
  - **The CLI is signed out.** Run `supabase logout` when you don't need it. A signed-out CLI can reach no cloud project, whatever the command text says.
  - **The cloud `DATABASE_URL` is not in the local `.env`.** Without the URL and its password on this machine, no local command can reach the cloud database. CI holds the only copy, as the `prod` environment's secret.
