# Supabase and the Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `libs/database` library with the Prisma contract as the only schema source, holding one RLS-protected `users` table tied to Supabase Auth. Alongside it: a local Supabase stack that runs next to 10xjobs's, a two-user isolation harness, a CI job that migrates the one cloud project after a merge, and guard rules that limit Claude to rows in that one project.

**Architecture:** Copy and trim 10xjobs's `libs/database`, `apps/db-tests`, CI `database` job and `dev-database.yml`. The local-only guard lives in the env loader that `prisma.config.ts` and the seed runner both use, so every Prisma command passes through it. `.claude/hooks/guard.mjs` gains three Supabase rule sets:

- an allowlist for the Supabase MCP tools;
- a text check on `execute_sql`;
- a local-only rule for the Supabase CLI in Bash.

**Tech Stack:**

- Nx 24 and pnpm, TypeScript strict with `nodenext` (ESM, `.js` import suffixes);
- Prisma 8 rc: `prisma` 8.0.0-rc.28, `@prisma/orm-postgres` and `@prisma/orm-extension-supabase` 8.0.0-rc.21, `@prisma/cli-engine` 0.9.0;
- the Supabase CLI `supabase` 3.0.0-next.27 as a root devDependency;
- `@supabase/supabase-js`, `pg`, Vitest, and `node:test` for the hooks and scripts.

**Spec:** `docs/superpowers/specs/2026-11-16-supabase-and-the-database-design.md`

**Copy from:** `/home/lab/apps/10xjobs/`. Each task names the files.

## Global Constraints

- The Prisma contract is the only schema source, RLS policies included. There are no hand-written SQL files outside Prisma migrations.
- RLS is on for every table in `public`. Owner policies are a plain `id = auth.uid()` (on `users`) or `"userId" = auth.uid()`, for the `authenticated` role only.
- The env prefix is `XAPPLY_`: `XAPPLY_SKIP_ENV_FILES`, `XAPPLY_ALLOW_REMOTE_DB`. Only CI sets `XAPPLY_ALLOW_REMOTE_DB=1`.
- Test users, fixtures, seeds and `db-tests` only ever touch the local stack.
- No seed runs on the cloud project. `database-deploy.yml` migrates only.
- Local ports are `project_id = "xapply"`: API 55321, DB 55322, shadow 55320, pooler 55329, studio 55323, mail 55324, analytics 55327, inspector 8084. The local DB URL is `postgresql://postgres:postgres@127.0.0.1:55322/postgres`.
- The package is `@xapply/database` at `libs/database`, with the `@xapply/source` export condition, `"type": "module"`, and nx name `database`.
- Credentials never go in git or in a file Claude reads. The cloud `DATABASE_URL` lives only in GitHub secrets (environment `prod`) and the untracked `.env`.
- Messages that mention a database URL name the variable and host only, never the password or the full URL.
- The Supabase MCP and CLI rules are as the spec's section 6 lists them. Anything not named is refused.

## Review Focus

1. **An opt-in in `.env`.** `XAPPLY_ALLOW_REMOTE_DB=1` written in `.env`, not the shell, must not turn the guard off. Task 2 has the test.
2. **A host hidden in the query string.** A URL such as `postgresql://u:p@127.0.0.1:55322/db?host=db.example.com` is remote. Task 2 has the test.
3. **Ordinary `execute_sql` spellings pass.** Lowercase, leading whitespace, a single trailing `;`, and a `-- comment` line before `select` must pass. Two statements must be refused, and so must `;` hidden after a comment. Task 6 has the tests.
4. **Other ways to call the CLI.** `pnpm exec supabase db push`, `npx supabase link`, `supabase --workdir x link` (a flag before the subcommand) and `bash -c "supabase db push"` are all refused. Task 7 has the tests.
5. **`db:reset` and `db:test` on the new ports.** Nothing may still point at 54322, or the suite would hit 10xjobs's stack. Task 4's `assertLocal` test checks the port, and Task 1 verifies `db:status` shows 55322.

---

### Task 1: Local Supabase stack on its own ports

**Files:**

- Create: `supabase/config.toml`, copied from `10xjobs/supabase/config.toml`.
  - Set `project_id = "xapply"` and the ports from Global Constraints.
  - Set `site_url` and `additional_redirect_urls` to `http://localhost:3002`, so they don't clash with 10xjobs's web on 3001 when slice 09 arrives.
  - Keep the auth settings: invite-only, so `enable_signup = false` for email.
  - Drop the `resumes` storage bucket and the email templates block (slice 09 brings templates).
- Create: `supabase/.gitignore` (copy).
- Create: `scripts/ensure-signing-key.sh` and `scripts/supabase-env.sh` (copy, executable).
- Modify: the root `package.json`.
  - Add the devDependency `"supabase": "3.0.0-next.27"`.
  - Add the scripts `db:start` (`scripts/ensure-signing-key.sh && supabase start`), `db:stop`, `db:status`.
- Modify: `.gitignore` to add `supabase/signing_keys.json` if `supabase/.gitignore` doesn't cover it.

**Interfaces:**

- Produces: `pnpm db:start`, `pnpm db:stop` and `pnpm db:status`, with the stack on 55321/55322.
- Produces: `eval "$(scripts/supabase-env.sh)"`, which exports `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_PUBLISHABLE_KEY`.

- [ ] **Step 1:** Run `pnpm install`, then `pnpm db:start` while 10xjobs's stack is running (`docker ps --filter name=supabase_ --format '{{.Names}}'` shows `_xjobs` containers).
  - Expected: it starts, and `pnpm db:status` prints `DB URL: postgresql://postgres:postgres@127.0.0.1:55322/postgres` and an API URL on 55321.
- [ ] **Step 2:** Run `docker ps --format '{{.Names}}' | grep -c _xapply`. Expected: non-zero, and the `_xjobs` containers are still up.
- [ ] **Step 3:** Run `eval "$(scripts/supabase-env.sh)" && echo "$SUPABASE_URL"`. Expected: `http://127.0.0.1:55321`.
- [ ] **Step 4: Commit**

```bash
git add supabase scripts/ensure-signing-key.sh scripts/supabase-env.sh package.json pnpm-lock.yaml .gitignore
git commit -m "feat(database): local Supabase stack on its own ports"
```

---

### Task 2: `libs/database` with the env loader and local guard

**Files:**

- Create: `libs/database/package.json`. Its exports are `.`, `./env` and `./types`, all with the `@xapply/source` condition, in the same shape as `libs/fact-bank/package.json`.
  - Dependencies: `@prisma/orm-extension-supabase` and `@prisma/orm-postgres` 8.0.0-rc.21, `@supabase/supabase-js` ^2.118.0, `dotenv` ^18.0.9, `zod` ^4.6.7.
  - devDependencies: `prisma` 8.0.0-rc.28, `@prisma/cli-engine` 0.9.0, `tsx` ^4.23.15.
- Create: `tsconfig.json`, `tsconfig.lib.json`, `tsconfig.spec.json`, `eslint.config.mjs` and `vitest.config.mts`, following `libs/fact-bank`.
- Create: these files in `src/env/`, copied from 10xjobs and renamed `XJOBS_` → `XAPPLY_`:
  - `environment.loader.ts`;
  - `local-guard.ts`;
  - `database-environment.ts`, keeping only `databaseEnvironmentSchema`, `seedEnvironmentSchema` (without `NODE_ENV`), `parseEnvironment`, `loadDatabaseEnvironment` and `loadSeedEnvironment`;
  - `index.ts`.
- Create: `libs/database/prisma.config.ts`.
- Test: `libs/database/src/env/local-guard.spec.ts` and `libs/database/src/env/database-environment.spec.ts`.
- Modify: the root `tsconfig.json` references (add `./libs/database`).

**Interfaces:**

- Produces:
  - `isLocalUrl(url: string): boolean`
  - `captureRemoteOptIn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `assertLocalDatabase(urls: Record<string, string | undefined>, optIn: NodeJS.ProcessEnv): void`
  - `loadDatabaseEnvironment(): { DATABASE_URL: string; DIRECT_DATABASE_URL?: string }`, which captures the opt-in **before** loading env files and throws through `assertLocalDatabase` on a remote URL without the opt-in.
  - `loadSeedEnvironment()`, which adds an optional `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
  - `loadEnvironmentFiles()`, which is skipped when `XAPPLY_SKIP_ENV_FILES=1`.
- The guard is inside `loadDatabaseEnvironment` (a spec change from 10xjobs, where it was a separate CLI). `prisma.config.ts` calls it, so every `prisma …` command is guarded.

- [ ] **Step 1: Write the failing tests** in `local-guard.spec.ts`:

```ts
it('treats 127.0.0.1, localhost and ::1 as local', () => {
  expect(
    isLocalUrl('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
  ).toBe(true);
  expect(isLocalUrl('postgresql://p:p@localhost:55322/postgres')).toBe(true);
  expect(isLocalUrl('postgresql://p:p@[::1]:55322/postgres')).toBe(true);
});
it('treats a host query parameter as a target', () => {
  expect(isLocalUrl('postgresql://u:p@127.0.0.1:55322/db?host=db.example.com')).toBe(false);
});
it('refuses a remote URL without the opt-in and names only variable and host', () => {
  expect(() =>
    assertLocalDatabase(
      {
        DATABASE_URL:
          'postgresql://u:secretpw@aws-0-eu.pooler.supabase.com:5432/postgres',
      },
      {},
    ),
  ).toThrow(
    /DATABASE_URL at non-local host aws-0-eu\.pooler\.supabase\.com.*XAPPLY_ALLOW_REMOTE_DB=1/,
  );
  // and the message does not contain 'secretpw'
});
it('allows a remote URL with XAPPLY_ALLOW_REMOTE_DB=1', () => { ... });
```

and in `database-environment.spec.ts`, using a temporary dir with a `pnpm-workspace.yaml` and a `.env`:

```ts
it('ignores XAPPLY_ALLOW_REMOTE_DB=1 written in .env', () => {
  // .env: DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres and XAPPLY_ALLOW_REMOTE_DB=1
  expect(() => loadDatabaseEnvironment(/* start: tmp */)).toThrow(/non-local host db\.example\.com/);
});
it('returns local URLs unchanged', () => { ... });
```

`loadDatabaseEnvironment` may take an optional `start` directory for the test. The loader's once-only flag must be resettable in tests: export `resetEnvironmentLoaderForTests()`, or pass the start dir and skip the flag when given.

- [ ] **Step 2:** Run `pnpm nx test database`. Expected: FAIL (the modules are missing).
- [ ] **Step 3:** Implement the files listed above.
  - `prisma.config.ts` follows 10xjobs's: contract `./src/contract/contract.prisma`, `extensions: [supabasePack]`, `migrations: { dir: 'src/migrations' }`, and the connection `env.DIRECT_DATABASE_URL ?? env.DATABASE_URL`.
  - Task 3 creates the contract, so this task only needs the env tests to pass.
- [ ] **Step 4:** Run `pnpm nx test database && pnpm nx typecheck database && pnpm nx lint database`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add libs/database tsconfig.json package.json pnpm-lock.yaml
git commit -m "feat(database): library with a local-only env guard"
```

---

### Task 3: The contract, `users` tied to Auth, migration, types and seed

**Files:**

- Create: `libs/database/src/contract/contract.prisma`.
  - The header comment and the `Timestamps` mixin are copied from 10xjobs.
  - `model User { id Uuid @id; authUser supabase:auth.AuthUser @relation(fields: [id], references: [id], onDelete: Cascade); +Timestamps; @@map("users"); @@rls }`.
  - `policy_select users_owner_read` and `policy_update users_owner_update` are exactly as in 10xjobs (`id = auth.uid()`, `roles = [authenticated]`).
- Create: the emitted `contract.json` and `contract.d.ts` (from `db:emit`).
- Create: `libs/database/src/migrations/…`, planned by `pnpm --filter @xapply/database db:migration:plan --name init_users`, plus a hand-written `rawSql` op in the same or a second migration (`--name users_from_auth`). The op creates:
  - `public.handle_new_auth_user()`: `SECURITY DEFINER`, `SET search_path = ''`, `INSERT INTO public.users (id) VALUES (NEW.id)`;
  - the `on_auth_user_created` `AFTER INSERT ON auth.users FOR EACH ROW` trigger;
  - `REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated`.
  - Copy the SQL text from `10xjobs/libs/database/src/migrations/app/20261103T1348_users_from_auth/migration.ts` lines 125–140.
- Create: these files in `libs/database/src/seeds/`:
  - `index.ts`: the runner, copied without `--allow-production`. It calls `loadSeedEnvironment()`, which already refuses a remote URL. The header says "Seeds are local-only; CI never seeds the cloud project".
  - `seed.interface.ts`;
  - `users.seed.ts`: idempotent. It creates the auth user `test@xapply.local` through the admin API when missing, and finds it by email otherwise.
- Create: `libs/database/src/auth/auth-users.ts` (`findAuthUserByEmail`, copied) if the seed needs it.
- Create: `libs/database/src/supabase/database.types.ts`, generated.
- Create: `libs/database/src/types.ts`, which re-exports `Database`.
- Modify: the scripts in `libs/database/package.json`:
  - `db:emit`, `db:format`, `db:migration:plan`, `db:migration:status`, `db:migrate` (`prisma db migrate --to db`), `db:migrate:show`, `db:verify`, `db:seed` (`tsx src/seeds/index.ts`).
  - Add no `assert-local` wrapper: the config guards them.
- Modify: the root `package.json` scripts:
  - `db:migrate` and `db:seed` (filter to `@xapply/database`);
  - `db:types` (`supabase gen types typescript --local --schema public > libs/database/src/supabase/database.types.ts && prettier --write …`);
  - `db:reset`: as in 10xjobs, with `XAPPLY_SKIP_ENV_FILES=1 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres`.

**Interfaces:**

- Produces: `public.users (id uuid pk → auth.users on delete cascade, createdAt, updatedAt)` with RLS on, and a trigger that inserts one row per new auth user.
- Produces: the `Database` type from `@xapply/database/types`.
- Produces: `pnpm db:reset`, which starts fresh, migrates and seeds locally.

- [ ] **Step 1:** Write the contract and run `pnpm --filter @xapply/database db:emit`. Expected: `contract.json` and `contract.d.ts` are written.
- [ ] **Step 2:** Plan the migration (`db:migration:plan --name init_users`) and add the trigger `rawSql` op. Check the pack docs (`node_modules/@prisma/orm-extension-supabase`, and `skills/prisma-8/references/supabase.md` if present) for the installed syntax.
- [ ] **Step 3:** Run `pnpm db:reset`. Expected: the migrations apply, and the seed prints that `test@xapply.local` was created. A second `pnpm db:seed` prints that it already exists.
- [ ] **Step 4:** Run `psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select count(*) from public.users"`. Expected: 1.
- [ ] **Step 5:** Run `XAPPLY_SKIP_ENV_FILES=1 DATABASE_URL=postgresql://u:p@db.example.com:5432/postgres pnpm --filter @xapply/database exec prisma db migrate --to db`.
  - Expected: exit 1 with `Refusing to use DATABASE_URL at non-local host db.example.com`. This is the spec's "raw prisma" Done-when.
- [ ] **Step 6:** Run `pnpm db:types && git status --short libs/database/src/supabase`. Expected: the file exists, and `users` appears in it.
- [ ] **Step 7:** Find the schema holding Prisma's migration ledger (`psql … -c "\dn"`). Note its name in the commit message. Task 6 needs it.
- [ ] **Step 8:** Run `pnpm nx run-many -t lint test build typecheck`. Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add libs/database package.json
git commit -m "feat(database): users tied to Auth, with RLS and the sign-up trigger"
```

---

### Task 4: `apps/db-tests`, the isolation harness

**Files:**

- Create: `apps/db-tests/package.json`.
  - Name `@xapply/db-tests`, with deps `@supabase/supabase-js` and `pg`, and dev dep `@types/pg`.
  - nx targets `db-test` and `db-test-ci` with `cache: false`.
- Create: `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts` (copied, name `@xapply/db-tests`).
- Create: these files in `apps/db-tests/src/support/`, copied from 10xjobs and trimmed to `users`:
  - `stack-env.ts`;
  - `stack-env.spec.ts`;
  - `admin.ts`;
  - `pg.ts`, with `DEFAULT_URL` on port 55322;
  - `test-users.ts`, with emails `db-test-<uuid>@xapply.test`;
  - `registry.ts`, with only the `users` entry: `ownerColumn: 'id'`, `insertPayload: null`, `canDelete: false`, `patch: { updatedAt: new Date().toISOString() }`.
  - Leave out `fixtures.ts` and `mailpit.ts`.
- Create: `apps/db-tests/src/rls-enabled.db.spec.ts`, `accounts.db.spec.ts`, `isolation.db.spec.ts` and `smoke.db.spec.ts`, copied and trimmed to `users`.
- Modify: `nx.json`.
  - Exclude `apps/db-tests/**/*` from the default `@nx/vitest` plugin.
  - Add a second `@nx/vitest` entry for it (`testTargetName: "db-test"`, `ciTargetName: "db-test-ci"`, `testMode: "run"`).
  - Add a `targetDefaults` entry `"db-test-ci--**/**": { "cache": false }`.
- Modify: the root `package.json`, adding the script `"db:test": "nx run @xapply/db-tests:db-test"`.
- Modify: the root `tsconfig.json` references.

**Interfaces:**

- Consumes: the local stack from Task 1 and the `users` schema from Task 3.
- Produces: `assertLocal(url: string): void`, exported from `stack-env.ts`, which throws when the host isn't local **or the port isn't 55321 or 55322**.
- Produces: the `OwnedTable` registry type and `ownedTables`, which slices 10 and 12 extend.

- [ ] **Step 1: Write the failing test** in `stack-env.spec.ts`:

```ts
it('refuses 10xjobs local ports and remote hosts', () => {
  expect(() =>
    assertLocal('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  ).toThrow();
  expect(() => assertLocal('http://127.0.0.1:54321')).toThrow();
  expect(() => assertLocal('https://abc.supabase.co')).toThrow();
  expect(() =>
    assertLocal('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
  ).not.toThrow();
  expect(() => assertLocal('http://127.0.0.1:55321')).not.toThrow();
});
```

- [ ] **Step 2:** Run `pnpm db:test`. Expected: the stack-env test fails.
- [ ] **Step 3:** Implement the support files and the four specs. The checks the spec needs:
  - `accounts`: one `users` row with the auth id, and its `createdAt` set; deleting the auth user removes the row; a user's insert of a second row fails; a user's delete of their own row leaves it there.
  - `isolation`: the 10xjobs registry cases. A reads B's row and gets `[]`; A updates and deletes B's row and B's row is unchanged; A updates their own row to B's id and it fails; A's allowed operations on their own row succeed; `anon` sees none.
  - `rls-enabled`: the catalog query from 10xjobs.
  - The operation under test always goes through `supabase-js`. The service role only sets up and reads back.
- [ ] **Step 4:** Run `eval "$(scripts/supabase-env.sh)" && pnpm db:test`. Expected: every spec passes.
- [ ] **Step 5:** Run `pnpm nx run-many -t lint typecheck`. Expected: PASS, and `pnpm test` doesn't run the db specs.
- [ ] **Step 6: Commit**

```bash
git add apps/db-tests nx.json package.json tsconfig.json pnpm-lock.yaml
git commit -m "test(database): two-user isolation harness for users"
```

---

### Task 5: CI `database` job and the cloud deploy workflow

**Files:**

- Modify: `scripts/ci-changes.mjs`.
  - `classify` returns `database: true` when a file starts with `libs/database/`, `apps/db-tests/` or `supabase/`, or is `package.json`, `pnpm-lock.yaml`, `scripts/supabase-env.sh` or `scripts/ensure-signing-key.sh`.
  - `areasFor`'s fallbacks include `database: true`.
  - `main` writes `database=`.
  - Remove the "Areas still to come: database" comment line.
- Test: `scripts/ci-changes.test.mjs` (exists; extend it).
- Modify: `.github/workflows/ci.yml`.
  - The `changes` job outputs `database`.
  - Add a new `database` job, copied from 10xjobs, with `if: needs.changes.outputs.database != 'false' || github.event_name == 'push'`.
    - Env: `XAPPLY_SKIP_ENV_FILES: '1'` and `DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:55322/postgres`.
    - Steps: signing key; `pnpm exec supabase start -x studio,realtime,edge-runtime,imgproxy,logflare,vector`; `pnpm db:migrate`; export the Supabase env; `pnpm db:seed`; `pnpm db:types && git diff --exit-code libs/database/src/supabase/database.types.ts`; `pnpm db:test`; logs on failure.
  - Add `database` to `ci-ok`'s `needs`.
  - Remove the "Still to come: database" comment line.
- Create: `.github/workflows/database-deploy.yml`, copied from 10xjobs's `dev-database.yml`.
  - `name: Database deploy`, `run-name: Database deploy ${{ github.event.workflow_run.head_sha }}`.
  - Same trigger and `if`, `environment: prod`, `concurrency: { group: database-deploy, cancel-in-progress: false }`.
  - Env: `XAPPLY_SKIP_ENV_FILES: '1'`, `XAPPLY_ALLOW_REMOTE_DB: '1'`, `DATABASE_URL: ${{ secrets.DATABASE_URL }}`.
  - Steps: checkout of `head_sha`, pnpm, node 24, install, then `pnpm db:migrate`. **No seed step.**

**Interfaces:**

- Produces: `classify(files) → { hooks, code, database }`.

- [ ] **Step 1: Write the failing tests** in `scripts/ci-changes.test.mjs`:

```js
test('database area', () => {
  assert.equal(
    classify(['libs/database/src/contract/contract.prisma']).database,
    true,
  );
  assert.equal(classify(['apps/db-tests/src/x.ts']).database, true);
  assert.equal(classify(['supabase/config.toml']).database, true);
  assert.equal(classify(['pnpm-lock.yaml']).database, true);
  assert.equal(classify(['apps/runner/src/x.ts']).database, false);
  assert.equal(
    classify(['libs/database/src/contract/contract.prisma']).code,
    true,
  );
});
test('fallbacks treat database as changed', () => {
  assert.equal(areasFor('', 'abc', () => []).database, true);
});
```

- [ ] **Step 2:** Run `pnpm test:scripts`. Expected: FAIL on `database`.
- [ ] **Step 3:** Implement the `ci-changes.mjs` change, then edit `ci.yml` and write `database-deploy.yml`.
- [ ] **Step 4:** Run `pnpm test:scripts`. Expected: PASS.
- [ ] **Step 5:** Run `pnpm dlx @action-validator/cli .github/workflows/ci.yml && pnpm dlx @action-validator/cli .github/workflows/database-deploy.yml`, or `actionlint` if it's installed. Expected: no errors. If neither tool runs, read both YAML files back and check the job names in `needs`.
- [ ] **Step 6: Commit**

```bash
git add scripts/ci-changes.mjs scripts/ci-changes.test.mjs .github/workflows/ci.yml .github/workflows/database-deploy.yml
git commit -m "ci(database): database job on PRs and migrate the cloud project after merge"
```

---

### Task 6: Guard, the Supabase MCP tools

**Files:**

- Create: `.claude/supabase-project.json` with `{ "projectRef": null }`. The author fills it once the project exists.
- Modify: `.claude/hooks/guard.mjs`.
- Modify: `.claude/settings.json`. Append `|mcp__.*supabase.*` to the `PreToolUse` guard matcher. Keep the author's uncommitted `idleCompaction` line out of this commit: stage the hunk with `git add -p` only if possible; otherwise leave `settings.json` for the author and say so.
- Test: `.claude/hooks/guard.test.mjs`.

**Interfaces:**

- Produces, in `guard.mjs`:
  - `export const SUPABASE_REF_TOOLS = { list_tables: 'project_id', list_extensions: 'project_id', list_migrations: 'project_id', get_advisors: 'project_id', get_project_url: 'project_id', get_publishable_keys: 'project_id', generate_typescript_types: 'project_id', query_logs: 'project_id', execute_sql: 'project_id', get_project: 'id' }`. The key is the tool suffix; the value is the name of the argument that holds the ref.
  - `export const SUPABASE_NO_PROJECT_TOOLS = ['list_projects', 'list_organizations', 'get_organization', 'search_docs']`.
  - `export function supabaseToolProblem(toolName, input, projectRef): string | null`. The suffix is the part after the last `__`. The function applies only when `/^mcp__.*supabase/i` matches the tool name.
  - `export function sqlProblem(query: string): string | null`.
  - `evaluate(event, { …, supabaseProjectRef })`. The ref defaults to `projectRef` read from `.claude/supabase-project.json` next to the hooks (`null` when the file is missing or unreadable).
- `sqlProblem` rules, in order:
  1. Strip `--` line comments and `/* */` block comments.
  2. Refuse a `;` anywhere except one trailing `;`, which means more than one statement.
  3. The first word (case-insensitive) must be `select`, `with`, `insert`, `update` or `delete`.
  4. Refuse any whole word, case-insensitive: `create`, `alter`, `drop`, `truncate`, `grant`, `revoke`, `comment`, `security`, `do`, `copy`, `call`, `set role`, `reset role`, `set session`.
  5. If `insert`, `update`, `delete` or `merge` appears anywhere, refuse when the query names the schemas `auth`, `storage`, `supabase_migrations`, `extensions`, `pg_*`, `information_schema`, or the ledger schema from Task 3 Step 7.
  6. Refuse dollar quoting (`$$` or `$tag$`). That's fail-closed and simple.
  - Keywords inside string literals still count. Fail-closed is intended; the reason text says to reword the query.

- [ ] **Step 1: Write the failing tests:**

```js
const REF = 'abcdefghijklmnopqrst';
const mcp = (suffix, input, ref = REF) =>
  evaluate(
    {
      tool_name: `mcp__plugin_supabase_supabase__${suffix}`,
      tool_input: input,
    },
    { supabaseProjectRef: ref },
  ).block;

test('supabase: allowed tools on the committed project', () => {
  assert.equal(mcp('list_tables', { project_id: REF }), false);
  assert.equal(mcp('get_project', { id: REF }), false);
  assert.equal(
    mcp('execute_sql', {
      project_id: REF,
      query: 'select * from public.users',
    }),
    false,
  );
  assert.equal(mcp('list_projects', {}), false);
  assert.equal(mcp('search_docs', { graphql_query: '{x}' }), false);
});
test('supabase: other projects and no ref are refused', () => {
  assert.equal(
    mcp('list_tables', { project_id: 'zzzzzzzzzzzzzzzzzzzz' }),
    true,
  );
  assert.equal(mcp('get_project', { id: 'zzzzzzzzzzzzzzzzzzzz' }), true);
  assert.equal(mcp('list_tables', {}), true);
  assert.equal(mcp('list_tables', { project_id: REF }, null), true);
});
test('supabase: tools off the allowlist are refused', () => {
  for (const t of [
    'apply_migration',
    'create_project',
    'pause_project',
    'restore_project',
    'create_branch',
    'delete_branch',
    'merge_branch',
    'rebase_branch',
    'reset_branch',
    'deploy_edge_function',
    'create_edge_function_secret',
    'create_notebook',
    'run_notebook',
    'submit_feedback',
    'delete_feedback',
    'some_future_tool',
  ])
    assert.equal(mcp(t, { project_id: REF }), true, t);
});
test('supabase: any server name with supabase is checked', () => {
  assert.equal(
    evaluate(
      {
        tool_name: 'mcp__claude_ai_Supabase__apply_migration',
        tool_input: { project_id: REF },
      },
      { supabaseProjectRef: REF },
    ).block,
    true,
  );
});
test('supabase sql: reads and public writes pass', () => {
  for (const q of [
    'select 1',
    '  SELECT id FROM public.users;',
    '-- look\nselect 1',
    'update public.users set "updatedAt" = now() where id = \'00000000-0000-0000-0000-000000000000\'',
    'with x as (select 1) select * from x',
    'select * from auth.users',
    'select * from supabase_migrations.schema_migrations',
  ])
    assert.equal(sqlProblem(q), null, q);
});
test('supabase sql: schema changes, many statements and system writes are refused', () => {
  for (const q of [
    'create table public.x (id int)',
    'ALTER TABLE public.users DISABLE ROW LEVEL SECURITY',
    'drop table public.users',
    'truncate public.users',
    'grant all on public.users to anon',
    'select 1; drop table public.users',
    'select 1 -- x\n; select 2',
    'do $$ begin end $$',
    "insert into auth.users (id) values ('x')",
    'delete from storage.objects',
    'update supabase_migrations.schema_migrations set version = 1',
    'with d as (delete from auth.users returning id) select * from d',
    'copy public.users to stdout',
    'set role postgres',
  ])
    assert.notEqual(sqlProblem(q), null, q);
});
```

- [ ] **Step 2:** Run `pnpm test:hooks`. Expected: the new tests fail.
- [ ] **Step 3:** Implement `supabaseToolProblem`, `sqlProblem`, the ref loading and the `evaluate` branch.
  - The `evaluate` branch runs before the file-tool checks, for any `mcp__` tool name.
  - Block reason: `Supabase blocked: <problem>. Claude may read and write rows in 10xapply's project only; the schema changes only through CI (see CLAUDE.md).`
  - Check each tool's argument names against the installed server. `ToolSearch` with `select:mcp__plugin_supabase_supabase__get_project,mcp__plugin_supabase_supabase__execute_sql,mcp__plugin_supabase_supabase__list_tables` shows the schemas. Fix `SUPABASE_REF_TOOLS` if one differs.
- [ ] **Step 4:** Run `pnpm test:hooks`. Expected: PASS, the old tests included.
- [ ] **Step 5:** Update the guard matcher in `.claude/settings.json`.
- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/guard.mjs .claude/hooks/guard.test.mjs .claude/supabase-project.json
git add -p .claude/settings.json   # only the matcher hunk
git commit -m "feat(guard): Supabase tools limited to 10xapply's project, rows only"
```

---

### Task 7: Guard, the Supabase CLI and the remote opt-in in Bash

**Files:**

- Modify: `.claude/hooks/guard.mjs`.
- Test: `.claude/hooks/guard.test.mjs`.

**Interfaces:**

- Produces: `export function supabaseCliProblem(command: string): string | null`.
  - It finds every launch of the CLI: as the command word `supabase`, after `pnpm exec`, `pnpm dlx`, `npx`, `npm exec` or `yarn`, and inside `bash -c` or `eval`.
  - It reuses `parse`, `commandIndex` and `nestedCommand`.
  - The subcommand is the first token after the CLI word that isn't a flag. `--workdir`, `--profile` and `--output`/`-o` take a value.
  - **Allowed:**
    - `start`, `stop`, `status`;
    - `gen types` and `gen signing-key`;
    - `migration list` only with `--local`;
    - `db reset` only with `--local` or no target flag;
    - `--help` and `-h` anywhere;
    - `--version`.
  - **Refused:**
    - every other subcommand;
    - in any allowed one, a flag `--project-ref`, `--project-id`, `--linked`, `--db-url` or `--password`/`-p`.
- Also produces: `export function remoteOptInProblem(command: string): string | null`, which refuses any token equal to or starting with `XAPPLY_ALLOW_REMOTE_DB=`, in any segment.
- Root scripts such as `pnpm db:start` and `pnpm db:types` pass: the guard sees only `pnpm db:types`, not the script body. That is accepted, because the scripts are committed and reviewed.

- [ ] **Step 1: Write the failing tests:**

```js
test('supabase cli: local commands pass', () => {
  for (const c of [
    'supabase start',
    'pnpm exec supabase status -o env',
    'supabase stop --no-backup',
    'pnpm exec supabase gen types typescript --local --schema public',
    'supabase gen signing-key --algorithm ES256 --append',
    'supabase db reset',
    'supabase migration list --local',
    'supabase --help',
    'pnpm db:start',
    'pnpm db:types',
  ])
    assert.equal(blocked('Bash', { command: c }), false, c);
});
test('supabase cli: remote and account commands are refused', () => {
  for (const c of [
    'supabase link --project-ref abc',
    'supabase db push',
    'pnpm exec supabase db push',
    'npx supabase link',
    'supabase --workdir x link',
    'supabase projects list',
    'supabase projects delete abc',
    'supabase login',
    'supabase secrets set A=b',
    'supabase functions deploy x',
    'supabase db pull',
    'supabase db dump',
    'supabase migration repair 1 --status applied',
    'supabase branches list',
    'supabase gen types typescript --project-id abc',
    'supabase gen types typescript --linked',
    'supabase db reset --linked',
    'supabase db reset --db-url postgresql://u:p@h/db',
    'bash -c "supabase db push"',
    'ls && supabase link',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
});
test('remote db opt-in is refused', () => {
  for (const c of [
    'XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:migrate',
    'env XAPPLY_ALLOW_REMOTE_DB=1 pnpm db:seed',
    'export XAPPLY_ALLOW_REMOTE_DB=1; pnpm db:migrate',
  ])
    assert.equal(blocked('Bash', { command: c }), true, c);
  assert.equal(blocked('Bash', { command: 'pnpm db:migrate' }), false);
});
```

- [ ] **Step 2:** Run `pnpm test:hooks`. Expected: the new tests fail.
- [ ] **Step 3:** Implement both functions and call them from `evaluate`'s Bash branch, after the runner check.
  - Reasons: `Supabase CLI blocked: <problem>. Claude may run the local stack only (see CLAUDE.md).` and `Remote database blocked: only CI sets XAPPLY_ALLOW_REMOTE_DB.`
  - An unclosed quote fails closed when a raw token is `supabase`.
- [ ] **Step 4:** Run `pnpm test:hooks`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/guard.mjs .claude/hooks/guard.test.mjs
git commit -m "feat(guard): Supabase CLI local-only and no remote database opt-in"
```

---

### Task 8: Docs, env example, CLAUDE.md and the roadmap

**Files:**

- Create: `docs/database.md`.
  - Daily use: `pnpm db:start`, `db:reset`, `db:test` and `db:types`, and the ports.
  - How a schema change flows: contract → `db:emit` → `db:migration:plan --name` → `db:reset` → `db:test` → PR → CI → `database-deploy.yml`.
  - The author's one-time setup, the spec's section 7 steps 1–5, naming the GitHub environment `prod` and the secret `DATABASE_URL` (session pooler, port 5432).
  - The rule that the cloud block in `.env` stays commented out unless the author is doing something deliberate.
  - The free-plan note from Known gaps.
- Create or modify: `.env.example`.
  - A local block: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres`.
  - A commented cloud block: `# DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
- Modify: `CLAUDE.md`.
  - Stack: add `libs/database` and `apps/db-tests` (seven projects), and move Supabase and Prisma from "not built yet" to "Set up (slice 08)".
  - Commands: `db:start`, `db:stop`, `db:status`, `db:reset`, `db:migrate`, `db:seed`, `db:types`, `db:test`.
  - Guardrails, one paragraph:
    - Claude may read and write rows in 10xapply's Supabase project through the Supabase tools only, and the guard holds it to the ref in `.claude/supabase-project.json`.
    - The schema changes only through CI.
    - The CLI is local-only.
    - `XAPPLY_ALLOW_REMOTE_DB` is CI's alone.
- Modify: `docs/roadmap/README.md`. Slice 08 gains `- **Spec:** [slice 08 spec](../superpowers/specs/2026-11-16-supabase-and-the-database-design.md).` and a "Spec answers: settled in the spec" line summarising:
  - one cloud project with the author's real data;
  - `users` only;
  - migrate-only deploy;
  - Claude limited to rows in that project.

- [ ] **Step 1:** Write the four files.
- [ ] **Step 2:** Run `pnpm format:check && pnpm nx run-many -t lint test build typecheck && pnpm test:hooks && pnpm test:scripts`. Expected: PASS.
- [ ] **Step 3: Commit**

```bash
git add docs/database.md .env.example CLAUDE.md docs/roadmap/README.md
git commit -m "docs(database): setup, schema flow and guardrails for slice 08"
```

---

### Task 9: Whole-branch check and PR

- [ ] **Step 1:** Run `pnpm db:reset && eval "$(scripts/supabase-env.sh)" && pnpm db:test`. Expected: PASS, with 10xjobs's stack still up.
- [ ] **Step 2:** Run `git log --oneline origin/main..` and `git diff --stat origin/main`. Expected: no file under `private/`, no `.env`, and no `signing_keys.json`.
- [ ] **Step 3:** Push with `git push -u origin slice-08-database`. Open the PR with `gh pr create --base main`, its body listing the author's setup steps from `docs/database.md`.
  - The PR should merge only after the `prod` environment and the `DATABASE_URL` secret exist; otherwise `database-deploy.yml` fails on its first run.
  - After merge, check the cloud project through the Supabase tools, once its ref is committed: `list_tables` shows `users` with RLS on.
