# Webhook Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/intake/<token>` receives 10xjobs's signed match webhook, stores every signed request in `webhook_deliveries` and every new match in `matches` (one per user and 10xjobs `job.id`), and answers 200.

**Architecture:** Three new tables in the Prisma contract (`intake_links` and `webhook_deliveries` engine-only, `matches` owner-readable). `libs/database` gains a runtime client copied from 10xjobs (no local-only guard). The API gets a database module, a health ping and an `intake` module of small pure parts (token hash, signature, payload, LinkedIn id) plus a repository and a controller. A separate small PR in 10xjobs adds `job.key` to its payload.

**Tech Stack:** NestJS 11 on Express, Prisma 8 (`@prisma/orm-postgres` runtime, `raw.sql`), zod 4, Vitest, Supabase local stack (DB 55322).

**Spec:** [docs/superpowers/specs/2026-11-17-webhook-intake-design.md](../specs/2026-11-17-webhook-intake-design.md)

## Global Constraints

- Signature: header `X-10xjobs-Signature` = `v1=` + hex HMAC-SHA256 of `${timestamp}.${rawBody}` keyed by the stored secret; compare in constant time.
- Timestamp tolerance: 5 minutes (300 s) either way, from `X-10xjobs-Timestamp` (Unix seconds).
- Token: 32 random bytes, base64url; stored only as its SHA-256 hex in `intake_links."tokenHash"`.
- Status codes: no link for the token, bad signature, bad or missing timestamp, missing or repeated header → **401** `{"error":"unauthorized"}`. Database error → **500**. Every signed request otherwise → **200** `{"ok":true}`, including duplicates and `unparsed`.
- Body limit on the intake route: 1 MB, read as raw bytes (never JSON-parsed before the signature check).
- Never log or echo the token, its hash, the secret, the signature or the body. Log one line per request: `intake: <deliveryId> <outcome> <status>`, or `intake: unauthorized`.
- Delivery outcomes, exact spellings: `match`, `duplicate-job`, `test`, `unparsed`. Match status: `new` only.
- Every route except `POST /api/intake/<one segment>` still needs `X-Xapply-Key`.
- The runtime client never calls `assertLocalDatabase`; `XAPPLY_ALLOW_REMOTE_DB` stays CI's alone.
- New table grants: `authenticated` SELECT on `matches` only; `service_role` ALL on all three; `anon` nothing. Any new function: `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`.
- Commit and PR bodies that mention the Supabase CLI word use `git commit -F` / `gh pr create --body-file`.

## Review Focus

1. **A signed body that isn't JSON or isn't version 1.** Expect 200 and a delivery with outcome `unparsed`, never a 400 (Task 7 test `stores an unparsed delivery for a signed non-JSON body`).
2. **The same delivery retried after a crash between our commit and our answer.** Expect a no-op 200, no second match (Task 7 test `answers 200 and writes nothing for a repeated delivery id`).
3. **Two 10xjobs profiles matching the same job.** Two delivery ids, same `job.id`: expect one match and the second delivery `duplicate-job` (Task 7).
4. **A GET, or a POST to a deeper path, under `/api/intake/`.** Expect 401 without the key (Task 5 tests).
5. **The database down when a delivery arrives.** Expect 500 so 10xjobs retries, and nothing half-written (Task 7 test `answers 500 when the database fails`).

---

## File Structure

- `libs/database/src/contract/contract.prisma`: three models, two enums, one policy.
- `libs/database/src/migrations/app/<ts>_webhook_intake/`: planned migration plus a `rawSql` grants step.
- `libs/database/src/client/connection.source.ts` (+ spec): `createDatabaseClient`, `DatabaseClient`, `DatabaseTransaction`, `contract`.
- `apps/db-tests/src/support/registry.ts`, `grants.db.spec.ts`, new `engine-only.db.spec.ts`.
- `apps/api/src/config/environment.ts`: adds `DATABASE_URL`.
- `apps/api/src/database/database.module.ts`, `database.service.ts`.
- `apps/api/src/health/health.controller.ts`: adds the ping.
- `apps/api/src/app.module.ts`: becomes `AppModule.register(env)`.
- `apps/api/src/create-app.ts`, `apps/api/src/common/api-key.middleware.ts`: raw body, exemption.
- `apps/api/src/intake/`: `token.ts`, `signature.ts`, `payload.ts`, `linkedin-job-id.ts`, `intake.repository.ts`, `intake.controller.ts`, `intake.module.ts`, each with a spec; `intake.db.spec.ts` for the local-stack tests.
- `apps/api/vitest.config.mts` (exclude `*.db.spec.ts`), `apps/api/vitest.db.config.mts`, an api `db-test` target, root `db:test`.
- Docs: `CLAUDE.md`, `docs/database.md`, `docs/roadmap/README.md`, `deploy/api/README.md`, `deploy/api/.env.example`.
- 10xjobs (separate repo, separate PR): payload `job.key`, `docs/webhooks.md`.

---

### Task 1: Tables, migration and grants

**Files:**

- Modify: `libs/database/src/contract/contract.prisma`
- Create: `libs/database/src/migrations/app/<timestamp>_webhook_intake/` (generated)
- Modify: `libs/database/src/migrations/app/refs/db.json`, `libs/database/src/supabase/database.types.ts` (generated)
- Modify: `apps/db-tests/src/support/registry.ts`, `apps/db-tests/src/grants.db.spec.ts`
- Create: `apps/db-tests/src/engine-only.db.spec.ts`
- Modify: `docs/database.md` (a "Tables" list naming the three tables and their grants)

**Interfaces:**

- Produces (Postgres, `public`):
  - `intake_links`: `id uuid pk default gen_random_uuid()`, `userId uuid unique → users.id on delete cascade`, `tokenHash text unique`, `secret text`, `createdAt`, `updatedAt`. RLS on, no policies.
  - `webhook_deliveries`: `id uuid pk`, `userId uuid → users.id cascade`, `deliveryId text`, `event text`, `sentAt timestamptz(3)`, `rawBody text`, `outcome text` (enum `DeliveryOutcome`: `match`, `duplicate-job`, `test`, `unparsed`), timestamps; `@@unique([userId, deliveryId])`. RLS on, no policies.
  - `matches`: `id uuid pk`, `userId uuid → users.id cascade`, `deliveryId text`, `xjobsJobId text`, `jobKey text?`, `linkedinJobId text?`, `title text`, `companyName text`, `postingUrl text`, `applyUrl text?`, `profileLabel text`, `unverified boolean`, `matchedAt timestamptz(3)`, `status text` (enum `MatchStatus`: `new`) default `new`, timestamps; `@@unique([userId, xjobsJobId])`, `@@unique([userId, linkedinJobId])`, `@@index([userId])`. RLS on; policy `matches_owner_read` SELECT for `authenticated` using `"userId" = auth.uid()`.
  - Prisma model names `IntakeLink`, `WebhookDelivery`, `Match` (used in Task 7 via `raw.sql` only, so table names are what matter).

- [ ] **Step 1: Write the failing db tests**
  - `grants.db.spec.ts`: `AUTHENTICATED` becomes `{ matches: ['SELECT'], users: ['SELECT', 'UPDATE'] }`.
  - `registry.ts`: add `matches` to `ownedTables`, `ownerColumn: 'userId'`, `seed` inserts a row through `admin()` with `xjobsJobId: randomUUID()`, `deliveryId: randomUUID()`, `title: 'T'`, `companyName: 'C'`, `postingUrl: 'https://example.com/j'`, `profileLabel: 'P'`, `unverified: false`, `matchedAt: new Date().toISOString()`; `insertPayload: null`, `patch: null`, `canDelete: false`.
  - `engine-only.db.spec.ts`: `it.each(['intake_links', 'webhook_deliveries'])('a signed-in user reads no rows and cannot insert into %s')`. Seed one row per table for user A through `withCatalog`, then assert A's client `select('*')` returns an error with code `42501` and an insert returns error code `42501`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm db:test` (after `eval "$(scripts/supabase-env.sh)"`)
Expected: FAIL: relation `matches` does not exist.

- [ ] **Step 3: Add the models to the contract**, with comments in the style of `User`. Follow 10xjobs's `Webhook` model for the `id` default and the enum `@@type("pg/text@1")` form. Then `pnpm --filter @xapply/database db:emit` and `pnpm --filter @xapply/database db:migration:plan --name webhook_intake`.

- [ ] **Step 4: Add the grants step** to the new `migration.ts`: a `rawSql` step like `init_users`'s, id `grants.webhook_intake`, executing:

```sql
GRANT SELECT ON public.matches TO authenticated;
GRANT ALL ON public.matches, public.intake_links, public.webhook_deliveries TO service_role;
```

Then move the ref (`prisma migration ref set db <hash>` from the plan output), `pnpm db:reset`, `pnpm db:types`.

- [ ] **Step 5: Run the tests**

Run: `pnpm db:test` and `pnpm nx test database`
Expected: PASS, including the isolation suite for `matches` and `db-ref.spec.ts`.

- [ ] **Step 6: Commit** `feat(database): intake_links, webhook_deliveries and matches`

---

### Task 2: Runtime database client in `libs/database`

**Files:**

- Create: `libs/database/src/client/connection.source.ts`, `libs/database/src/client/connection.source.spec.ts`
- Modify: `libs/database/src/index.ts`, `libs/database/package.json` (add `pg` only if the runtime needs it directly)

**Interfaces:**

- Produces:
  - `createDatabaseClient(config: { url: string; connectionTimeoutMs: number; idleTimeoutMs: number }): DatabaseClient`
  - `type DatabaseClient = PostgresClient<Contract>`; `type DatabaseTransaction` = the `tx` argument type of `DatabaseClient['transaction']`
  - `contract`
  - all exported from `@xapply/database`.

- [ ] **Step 1: Write the failing test** `connection.source.spec.ts`:
  - `creates a client for a remote URL without throwing or connecting`: `createDatabaseClient({ url: 'postgresql://u:p@db.example.com:5432/postgres', connectionTimeoutMs: 1000, idleTimeoutMs: 1000 })` returns an object with `transaction` and `execute` functions; then `await client.close()`.
  - `never calls the local-only guard`: `vi.mock('../env/local-guard.js')` and assert `assertLocalDatabase` was not called.

- [ ] **Step 2: Run it to see it fail.** Run: `pnpm nx test database`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**, copying 10xjobs `libs/database/src/client/connection.source.ts` (the `postgres({ contract, url, extensions: [supabaseRuntimeDescriptor], poolOptions })` call). Leave out its query-logger middleware and logger parameter: log events go nowhere, so no SQL or values reach logs. The contract type comes from `../contract/contract.d.ts`.

- [ ] **Step 4: Run the tests.** Run: `pnpm nx run-many -t test typecheck -p database`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(database): runtime client for application code`

---

### Task 3: The API connects to the database; health pings it

**Files:**

- Modify: `apps/api/src/config/environment.ts` (+ spec), `apps/api/src/app.module.ts`, `apps/api/src/create-app.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/create-app.spec.ts`, `apps/api/package.json` (dependency `@xapply/database: workspace:*`), `deploy/api/.env.example`
- Create: `apps/api/src/database/database.module.ts`, `apps/api/src/database/database.service.ts`

**Interfaces:**

- Consumes: `createDatabaseClient`, `DatabaseClient`, `DatabaseTransaction` (Task 2).
- Produces:
  - `Environment` gains `DATABASE_URL: string` (`postgres://` or `postgresql://`, required).
  - `DatabaseModule.register(url: string): DynamicModule` (global), providing `DatabaseService` with `readonly db: DatabaseClient`, `ping(): Promise<void>`, and `onApplicationShutdown()` closing the client. No ping at startup _(plan's call: the API stays up and health reports 503, so a database outage shows in the uptime check instead of a restart loop)_.
  - `AppModule.register(env: Environment): DynamicModule`; `createApp(env, options)` keeps its signature.

- [ ] **Step 1: Write the failing tests**
  - `environment.spec.ts`: `requires DATABASE_URL`; `refuses a non-postgres URL` (`https://x`); the error message names `DATABASE_URL` and does not contain the URL's password (`hunter2`).
  - `create-app.spec.ts`: pass `DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db'` and change the health test to `GET /api/health with the key answers 503 {"status":"database-unreachable"} when the database is down`. Keep the 401, 404 and x-powered-by tests.

- [ ] **Step 2: Run them to see them fail.** Run: `pnpm nx test api`. Expected: FAIL.

- [ ] **Step 3: Implement.** Health: `await database.ping()` (a `SELECT 1` as 10xjobs's `DatabaseService.ping`), then 200 `{ "status": "ok" }`, or on any error 503 `{ "status": "database-unreachable" }`, both with `Cache-Control: no-store`. Add `DATABASE_URL=` with a comment (session pooler, port 5432, written by the author) to `deploy/api/.env.example`.

- [ ] **Step 4: Run the tests.** Run: `pnpm nx run-many -t test typecheck build -p api`. Expected: PASS, and the build bundles `@xapply/database`.

- [ ] **Step 5: Commit** `feat(api): database connection and health ping`

---

### Task 4: Intake building blocks (token, signature, payload, LinkedIn id)

**Files:**

- Create in `apps/api/src/intake/`: `token.ts`, `signature.ts`, `payload.ts`, `linkedin-job-id.ts`, each with a `.spec.ts`

**Interfaces:**

- Produces:
  - `hashToken(token: string): string`: SHA-256 hex.
  - `verifySignature(input: { rawBody: Buffer; timestamp: unknown; signature: unknown; secret: string; nowSeconds: number }): { ok: true; sentAt: Date } | { ok: false }`. `timestamp` and `signature` are the raw header values: a string array or `undefined` fails.
  - `parseDelivery(rawBody: Buffer, event: string, headerDeliveryId: string): ParsedDelivery`, where
    `type ParsedDelivery = { kind: 'test' } | { kind: 'unparsed' } | { kind: 'match'; match: ParsedMatch }` and
    `type ParsedMatch = { xjobsJobId: string; jobKey: string | null; linkedinJobId: string | null; title: string; companyName: string; postingUrl: string; applyUrl: string | null; profileLabel: string; unverified: boolean; matchedAt: Date }`.
  - `linkedinJobId(jobKey: string | null, postingUrl: string): string | null`.

- [ ] **Step 1: Write the failing tests**
  - `token.spec.ts`: `hashToken('abc')` equals `'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'`.
  - `signature.spec.ts`, with `secret = 's3cret'`, `body = Buffer.from('{"a":1}')`, `ts = 1_800_000_000`, `sig = 'v1=' + createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex')`:
    - valid at `nowSeconds = ts` → `{ ok: true, sentAt: new Date(ts * 1000) }`;
    - valid at `ts + 300` and `ts - 300`; fails at `ts + 301` and `ts - 301`;
    - fails with a wrong secret, a changed body (`{"a":2}`), a signature without `v1=`, a signature of different length, a timestamp `'abc'`, a timestamp or signature given as `['x','y']` or `undefined`.
  - `linkedin-job-id.spec.ts`:
    - `('linkedin-job:4488500594', anything)` → `'4488500594'`;
    - `('ats:greenhouse/acme/123', 'https://www.linkedin.com/jobs/view/1/')` → `null`, and likewise for `url:…` and `linkedin-post:9`;
    - key `null` with `'https://www.linkedin.com/jobs/view/4490505838/'` → `'4490505838'`;
    - key `null` with `'https://www.linkedin.com/jobs/search/?currentJobId=4490356080'` → `'4490356080'`;
    - key `null` with `'https://boards.greenhouse.io/acme/jobs/1'` → `null`;
    - key `null` with `'not a url'` → `null`;
    - `'linkedin-job:abc'` → `null` (digits only).
  - `payload.spec.ts`: a valid version-1 `match.qualified` body built from 10xjobs's `docs/webhooks.md` example (with `job.id`, `job.key: 'linkedin-job:4488500594'`, `deliveryId` equal to the header) → `kind: 'match'` with every `ParsedMatch` field; the same without `job.key` → `jobKey: null` and the id from `postingUrl`; `job.applyUrl: null` → `applyUrl: null`; extra unknown fields → still `match`; event `test` → `{ kind: 'test' }` whatever the body; `version: 2` → `unparsed`; `deliveryId` different from the header → `unparsed`; missing `job.title` → `unparsed`; body `not json` → `unparsed`; event `match.updated` → `unparsed`.

- [ ] **Step 2: Run them to see them fail.** Run: `pnpm nx test api`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `verifySignature` follows the code in 10xjobs's `docs/webhooks.md`.
  - `linkedinJobId` falls back on a copy of `parseJobUrl` from `apps/runner/src/linkedin/job-url.ts`, with a comment naming the original _(plan's call: copy, not a new lib, per the spec's "left to the builder")_.
  - `payload.ts` uses a zod schema with `.loose()` objects for the required fields named in the spec's "What a valid `match.qualified` needs".

- [ ] **Step 4: Run the tests.** Run: `pnpm nx test api`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): intake token, signature, payload and LinkedIn id`

---

### Task 5: Raw body and the API key exemption

**Files:**

- Modify: `apps/api/src/create-app.ts`, `apps/api/src/common/api-key.middleware.ts`, `apps/api/src/common/api-key.middleware.spec.ts`, `apps/api/src/create-app.spec.ts`

**Interfaces:**

- Produces: on `POST /api/intake/*`, `req.body` is a `Buffer` of the exact bytes (any content type, at most 1 MB; larger → 413). Nest's own body parser is off (`bodyParser: false`); no other route takes a body yet.
- `isIntakePost(method: string, path: string): boolean` exported from `api-key.middleware.ts`: true only for `POST` and a path matching `^/api/intake/[^/]+$`.

- [ ] **Step 1: Write the failing tests**
  - `api-key.middleware.spec.ts`: `isIntakePost('POST', '/api/intake/abc')` true; false for `GET /api/intake/abc`, `POST /api/intake/abc/x`, `POST /api/intake/`, `POST /api/intakex/abc`, `POST /api/health`. The middleware calls `next()` without the key for the true case and answers 401 for each false case.
  - `create-app.spec.ts`: `POST /api/intake/some-token without the key gets past the key check` (until Task 7 adds the route, Nest answers 404, which proves the middleware let it through; Task 7 changes this assertion to its own 401); `GET /api/intake/x without the key answers 401`.

- [ ] **Step 2: Run them to see them fail.** Run: `pnpm nx test api`. Expected: FAIL.

- [ ] **Step 3: Implement.** `NestFactory.create(…, { bodyParser: false })`, then `app.use('/api/intake', express.raw({ type: () => true, limit: '1mb' }))` after the key middleware. `isIntakePost` is checked against `req.path`, not `req.url`, so a query string doesn't change the decision.

- [ ] **Step 4: Run the tests.** Run: `pnpm nx test api`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): raw body and key exemption for the intake route`

---

### Task 6: Local-stack test target for the API

**Files:**

- Modify: `apps/api/vitest.config.mts` (exclude `src/**/*.db.spec.ts`), `apps/api/package.json` (`nx.targets.db-test`, `cache: false`), root `package.json` (`db:test` → `nx run-many -t db-test -p @xapply/db-tests @xapply/api`), `.github/workflows/ci.yml` (the database job's test step runs the API's db tests too, the same way it runs `@xapply/db-tests`)
- Create: `apps/api/vitest.db.config.mts` (include only `src/**/*.db.spec.ts`, timeouts 30 s), `apps/api/src/intake/testing/local-db.ts`

**Interfaces:**

- Produces: `localDatabaseUrl(): string` (`process.env.DATABASE_URL` or `postgresql://postgres:postgres@127.0.0.1:55322/postgres`, refusing anything not on 55322 by host and port) and `createTestUser(): Promise<string>` (inserts an `auth.users` row through `pg`, so the trigger creates `users`; returns its id), both in `testing/local-db.ts`.

- [ ] **Step 1:** Add a placeholder `apps/api/src/intake/intake.db.spec.ts` with one test, `local stack answers SELECT 1`, using `createDatabaseClient(localDatabaseUrl())`.
- [ ] **Step 2:** Run `pnpm db:test`. Expected: both projects run, and the API's db test passes. Run `pnpm nx test api`. Expected: the db spec is not collected.
- [ ] **Step 3: Commit** `test(api): local-stack test target`

---

### Task 7: Repository, controller and module

**Files:**

- Create: `apps/api/src/intake/intake.repository.ts`, `intake.controller.ts`, `intake.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `IntakeModule`), `apps/api/src/intake/intake.db.spec.ts`

**Interfaces:**

- Consumes: Tasks 3–5.
- Produces:
  - `IntakeRepository.findLink(tokenHash: string): Promise<{ userId: string; secret: string } | null>`
  - `IntakeRepository.store(input: { userId: string; deliveryId: string; event: string; sentAt: Date; rawBody: string; parsed: ParsedDelivery }): Promise<'retry' | 'match' | 'duplicate-job' | 'test' | 'unparsed'>`
  - `IntakeController`: `@Controller('intake')`, `@Post(':token')`, `@HttpCode(200)`.

- [ ] **Step 1: Write the failing tests** in `intake.db.spec.ts`. Run the real app via `createApp` against the local stack. Before each test, create a user, a random token, and an `intake_links` row (`hashToken(token)`, secret `'s3cret'`). Send signed requests with a `sign(body, ts)` helper.
  - `stores a match and answers 200 {"ok":true}`: one `webhook_deliveries` row with outcome `match`, one `matches` row with `xjobsJobId`, `jobKey`, `linkedinJobId = '4488500594'`, `status = 'new'`.
  - `answers 200 and writes nothing for a repeated delivery id`: the same request sent twice gives 1 delivery and 1 match.
  - `marks a second delivery for the same job.id duplicate-job`: new delivery id, same `job.id` → 2 deliveries (second `duplicate-job`), 1 match.
  - `marks a new job.id with a stored LinkedIn id duplicate-job`.
  - `stores a greenhouse job with a null LinkedIn id`: `job.key: 'ats:greenhouse/acme/1'` → match with `linkedinJobId` null; a second such job with a different `job.id` → also stored.
  - `records a test event without a match`: outcome `test`.
  - `stores an unparsed delivery for a signed non-JSON body`: body `not json` → 200 and outcome `unparsed`, `rawBody = 'not json'`.
  - `answers 401 for an unknown token, a wrong signature and a stale timestamp (now − 301 s)`, writing nothing.
  - `keeps users apart`: user B's token with user A's secret → 401.
  - `answers 500 when the database fails`: build the app with `IntakeRepository.store` overridden to throw (`createApp` gains an optional `overrides` hook used only by tests, or the spec builds the module with `Test.createTestingModule`); a valid signed request answers 500 `{"error":"internal"}`.
  - `logs no secret`: capture the app logger output for one success and one 401; it contains neither the token, the secret, nor `v1=`.

- [ ] **Step 2: Run them to see them fail.** Run: `pnpm db:test`. Expected: FAIL (404).

- [ ] **Step 3: Implement.**
  - **Controller order:**
    1. `findLink(hashToken(token))`, or 401.
    2. `verifySignature` with the raw `x-10xjobs-timestamp` and `x-10xjobs-signature` header values and `Date.now()/1000`, or 401.
    3. Require `x-10xjobs-delivery` and `x-10xjobs-event` as single strings, or 401.
    4. `parseDelivery`, then `store`.
    5. 200 `{ "ok": true }`. An error from `store` becomes 500 `{ "error": "internal" }`. The 401 body is `{"error":"unauthorized"}`.
  - **`store`**, in one `db.transaction` with `raw.sql` (pattern: 10xjobs `segments.repository.ts`, `.returnsRow(...)`):
    1. `INSERT INTO webhook_deliveries … ON CONFLICT ("userId","deliveryId") DO NOTHING RETURNING id`. No row → `'retry'`.
    2. For `kind: 'match'`: `INSERT INTO matches … ON CONFLICT DO NOTHING RETURNING id`, giving `'match'` or `'duplicate-job'`.
    3. The delivery's `outcome` is written in step 1 for `test` and `unparsed`. For a match, step 1 writes `match` and an `UPDATE` sets `duplicate-job` when step 2 inserted nothing.
  - **The controller answers 200 for `'retry'`.** The log line is `intake: <deliveryId> <outcome> <status>`.

- [ ] **Step 4: Run all tests.** Run: `pnpm db:test && pnpm nx run-many -t lint test typecheck build -p api database`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): webhook intake route`

---

### Task 8: Docs and runbook

**Files:**

- Modify: `CLAUDE.md`, `docs/roadmap/README.md`, `deploy/api/README.md`, `docs/database.md` (if Task 1 left anything)

- [ ] **Step 1: `CLAUDE.md`:**
  - **Stack:** `apps/api` now holds the webhook intake and connects to the database.
  - **"Webhooks":** duplicates are dropped on `X-10xjobs-Delivery` and on the user plus 10xjobs's `job.id`; one 10xjobs PR adds `job.key`. Delete "there is no sending PR in 10xjobs".
  - **Guardrails:** a new line: "Claude may create and update `intake_links` rows (token hash and 10xjobs secret) with the Supabase tools only when the author asks in that session, and never writes a token or secret to a file."
- [ ] **Step 2: `docs/roadmap/README.md`:**
  - **Slice 12:** link this spec, and replace its Locked and Spec answers with the spec's outcome.
  - **Phase 2 exit criteria:** replace "matches for an email with no account are held and show up when that person signs up" with "a match reaches only the user whose intake URL received it".
  - **Slice 13's spec answers:** note the `applyUrl`-null Easy Apply hint.
- [ ] **Step 3: `deploy/api/README.md`:**
  - **Server setup:** `DATABASE_URL` in the server's `.env` (the session pooler URL, port 5432, written by the author), and it must be set before this slice's PR merges, or the deploy's health check fails with 503.
  - **A new section, "Intake link"**, with the five setup steps from the spec, rotation, and a check query: `select outcome, "createdAt" from webhook_deliveries order by "createdAt" desc limit 5`.
- [ ] **Step 4:** Run `pnpm format:check`. Expected: clean.
- [ ] **Step 5: Commit** `docs: webhook intake in CLAUDE.md, roadmap and runbook`

---

### Task 9: 10xjobs PR: `job.key` in payload version 1

Runs in `/home/lab/apps/10xjobs` on its own branch, under 10xjobs's own `CLAUDE.md` and guard. It is a separate PR to 10xjobs's `main`, and the intake doesn't depend on it.

**Files (10xjobs):**

- Modify: `apps/xjobs/src/modules/webhooks/payload/build.ts` (+ its spec), `apps/xjobs/src/modules/webhooks/repositories/webhooks.repository.ts` (select `"jobKey"`), `docs/webhooks.md`

- [ ] **Step 1: Write the failing test** in `build.spec.ts` (or the payload spec that exists): `job.key` equals the job row's `jobKey`. The fixed test example has `key: null`.
- [ ] **Step 2: Run it to see it fail.** Run: `pnpm nx test xjobs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `key: string | null` to the payload job type after `id`. The send-time job is the merged-into job, so its `jobKey` is the one sent. `docs/webhooks.md` gets `"key": "linkedin-job:4488500594"` in the example and a bullet listing the four key kinds (`ats:`, `url:`, `linkedin-job:`, `linkedin-post:`).
- [ ] **Step 4: Run the tests.** Run: `pnpm nx run-many -t lint test typecheck -p xjobs`. Expected: PASS.
- [ ] **Step 5: Commit, push and open the PR** with 10xjobs's allowed forms (`git push -u origin <branch>`, `gh pr create --base main --body-file …`).

---

### Task 10: Ship and live check (author and Claude)

- [ ] **Step 1:** The author puts `DATABASE_URL` in `/home/deploy/xapply/.env` on the server.
- [ ] **Step 2:** Push `webhook-intake` with `git push -u origin webhook-intake` and open the PR to `main`. The author merges. `Database deploy` migrates, then `Deploy API` passes its health check.
- [ ] **Step 3:** The author is invited from the Supabase dashboard. Claude reads their `users` id with `execute_sql`.
- [ ] **Step 4:** Claude generates the token locally with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`, computes its SHA-256 hex with `printf %s <token> | sha256sum`,, and gives the author the URL. The URL is never written to a file.
- [ ] **Step 5:** The author pastes the URL into 10xjobs's Webhook page and gives Claude the secret. Claude inserts the `intake_links` row.
- [ ] **Step 6:** The author presses "Send test". Claude confirms a `webhook_deliveries` row with outcome `test`, and 10xjobs shows Delivered.
- [ ] **Step 7:** When a real match arrives, Claude confirms one `matches` row and reports its outcome and LinkedIn id (and that `jobKey` is filled once Task 9 is merged).
