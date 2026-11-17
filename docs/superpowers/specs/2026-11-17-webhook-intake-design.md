# Webhook intake: design

Date: 2026-11-17
Status: approved 2026-11-17
Roadmap slice: [12 Webhook intake](../../roadmap/README.md#12-webhook-intake)
Builds on: [slice 11 spec](2026-11-17-hosted-api-design.md) (hosting, and the decision to receive 10xjobs's webhook as it is) and [slice 08 spec](2026-11-16-supabase-and-the-database-design.md) (contract, grants, RLS).
Sender: 10xjobs's `docs/webhooks.md` (payload version 1, signing, retries, auto-disable).

Decision marks: _(user)_ the author decided it in the brainstorm; _(locked)_ already locked by the roadmap, `CLAUDE.md` or slice 11; _(my call)_ Claude's proposal, open to correction.

## Intent

The API gets its first real route: the receiver for 10xjobs's match webhook. Each new qualified match 10xjobs finds for the author is stored in 10xapply's database, once. Until slice 13 builds the approval list, the author reads the matches in the Supabase dashboard.

Why now: real matches give the author LinkedIn jobs they are eligible for, which 07b's open items (live dry runs, date fields, city typeahead) and 07c's misses need. Build order 08 → 11 → 12 was decided 2026-11-16 _(user)_.

## Goals

- `POST /api/intake/<token>` accepts 10xjobs's signed webhook, checks the token, the signature and the timestamp, stores the request, and answers 2xx.
- Each `match.qualified` delivery becomes one `matches` row the author can read in the dashboard, deduplicated on the delivery id and on (user, 10xjobs `job.id`). The `job.id` stands for the application itself, whatever the source.
- A small PR in 10xjobs adds `job.key` to payload version 1, so the intake gets the LinkedIn id of an Easy Apply job directly.
- The author's intake link (the URL and the pasted 10xjobs secret) is set up without a web app.
- The API connects to the cloud database, and the health check covers it.
- A live check: a "Send test" from 10xjobs's Webhook page and one real match both arrive.

## Non-goals

- Approving or skipping matches, and any web UI (slices 09 and 13).
- Detecting Easy Apply. The payload doesn't say, so that's slice 13's job.
- Running the disqualification check on arrival. It needs `claude -p`, which runs only on the author's subscription and not on the server _(my call)_. The runner still checks every job.
- A self-service flow for creating or rotating links (the web app, later).
- Rate limiting or abuse protection beyond the token check. 10xjobs sends one delivery at a time, and an unknown token costs one indexed lookup _(my call)_.
- Any 10xjobs change beyond the one `job.key` field.

## Anti-goals (failure even if it works)

- A forged or replayed request stored as a match.
- The same job stored twice for one user, or two users' matches mixed up.
- A secret, token, signature or payload body in a log, an error response, git or the image.
- Answering 10xjobs with a non-2xx for a request that came from 10xjobs and was signed correctly but couldn't be parsed. 10xjobs would retry the same bytes for about 21 h and could auto-disable the webhook, and after that it never resends what it missed.
- Any route other than the intake answering without the API key.

## Locked before this brainstorm

- A per-user intake URL carrying a long random token, which identifies the user. The user pastes 10xjobs's secret into 10xapply _(locked, slice 11)_.
- The token, the signature (`v1=` HMAC-SHA256 over `${timestamp}.${rawBody}`) and the timestamp (5 min tolerance) are checked. The request is stored and answered 2xx at once _(locked)_.
- Duplicates are dropped on `X-10xjobs-Delivery` _(locked)_. The second key changed in this brainstorm (below).
- No email is shared and there are no held matches. One 10xjobs webhook URL per user is accepted _(locked)_.

## Changed in this brainstorm

- **A match's identity is the application, which means 10xjobs's `job.id`, not the LinkedIn job id** _(user)_. Jobs also come straight from Greenhouse and Ashby, and those have no LinkedIn id. 10xjobs already gives each job a unique `jobKey` built from where you apply, in `apps/xjobs/src/modules/ingest/normalize/job-key.ts` in 10xjobs:
  - `ats:<greenhouse|ashby>/<tenant>/<posting>` for an ATS posting, whether found on the ATS or behind a LinkedIn listing's apply link;
  - `url:<canonical apply URL>|<title>` for any other company site, with tracking parameters stripped;
  - `linkedin-job:<id>` for a LinkedIn listing with no outside apply link, which in practice is Easy Apply;
  - `linkedin-post:<id>` for a LinkedIn post.

  Listings that share a key are one 10xjobs job with one `job.id`, and a delivery for a merged job carries the job it was merged into. So (user, `job.id`) deduplicates on the application, as the author asked. Rebuilding that from raw apply URLs in 10xapply would only drift from 10xjobs's rules.

- **One small PR in 10xjobs is allowed** _(user)_. It adds `job.key` (the job's `jobKey`) to payload version 1, a new field, which 10xjobs's doc allows without bumping the version. It's its own small piece of work in 10xjobs. The intake doesn't wait for it: until it lands, `job.key` is absent and the LinkedIn id comes from `postingUrl`. The roadmap and `CLAUDE.md` lines that say "no PR in 10xjobs" are reworded.
- Intake runs on the NestJS API, not on Supabase edge functions _(locked)_.

## Approaches

### How the author gets their link (no web app yet)

- A) A command inside the API container, run by the author over SSH. It prints the URL once and reads the secret from a hidden prompt.
- B) A route on the API, protected by the API key, called with curl.
- C) **Claude inserts the row with the Supabase tools** _(user picked)_. It's quickest and adds no code path for creating links. In exchange, Claude sees the token and the 10xjobs secret, which the author accepts.

### How the API connects to the database

- A) Its own login role (`xapply_api`) with grants only on the intake tables.
- B) **The `postgres` session pooler URL in the server's `.env`**, like 10xjobs's engine _(user picked)_. It takes no setup. Anyone who gets the server's `.env` has full control of the database, which the author accepts.
- C) The service-role key through Supabase's REST API.

### What is stored

1. **A raw delivery table plus a match table, written in one transaction** _(user picked)_. The matches can be read in the dashboard without parsing JSON, and the raw body lets a field added later in payload version 1 be filled in afterwards. That matters because 10xjobs never resends.
2. Raw deliveries only, with matches read out later. Rejected: the user-plus-job dedup needs the job id pulled out anyway, and the dashboard would show JSON.
3. Matches only. Rejected: anything not parsed today is lost for good.

## Design

### Tables (in the Prisma contract)

Names are the builder's within the contract's conventions. Every table has `userId` _(locked, slice 08)_.

**`intake_links`**: engine-only. RLS is on with no policies, and `authenticated` and `anon` get no grants.

- `id`, `userId` (unique: one link per user, _my call_), `tokenHash` (unique, hex SHA-256 of the token), `secret` (10xjobs's secret, plain text), `+Timestamps`.
- The secret is stored as plain text _(my call)_. Claude sees it anyway under option C, and the guard refuses the vault functions in `execute_sql`, so encryption would add a server-held key for little gain. The table is unreadable to `authenticated`.

**`webhook_deliveries`**: engine-only, RLS on, no policies.

- `id`, `userId`, `deliveryId` (the `X-10xjobs-Delivery` header), `event` (the `X-10xjobs-Event` header, as received), `sentAt` (from `X-10xjobs-Timestamp`), `rawBody` (text, exactly as received), `outcome` (enum, below), `+Timestamps`.
- Unique on (`userId`, `deliveryId`).
- `outcome`:
  - `match`: a `matches` row was created.
  - `duplicate-job`: a `match.qualified` for a job this user already has, by `job.id` or by LinkedIn id.
  - `test`
  - `unparsed`: the body is not valid JSON, `version` is not 1, the event is unknown, or required fields are missing.
- Kept indefinitely _(my call: a few KB per match, a handful a day; revisit in Phase 3)_.

**`matches`**: user-owned. RLS is on, with an owner `SELECT` policy for `authenticated` (`"userId" = auth.uid()`). `authenticated` gets SELECT only, so slice 13 can read the list. Slice 13 adds UPDATE for approve and skip. `service_role` gets ALL, as on `users`.

- `id`, `userId`, `deliveryId` (the delivery that created it), `xjobsJobId` (the payload's `job.id`), `jobKey` (the payload's `job.key`, nullable until the 10xjobs PR lands), `linkedinJobId` (text, nullable), `title`, `companyName`, `postingUrl`, `applyUrl` (nullable), `profileLabel`, `unverified` (boolean), `matchedAt` (the payload's `createdAt`), `status` (enum, starting with only `new`; slice 13 adds `approved` and `skipped`), `+Timestamps`.
- Unique on (`userId`, `xjobsJobId`): the identity. Also unique on (`userId`, `linkedinJobId`) as a second guard, which catches a LinkedIn listing 10xjobs later re-merges under a new `job.id` _(my call)_. Postgres treats NULLs as distinct, so jobs with no LinkedIn id never collide on that key.
- `applyUrl` null on a match with a LinkedIn id is a strong hint the job is Easy Apply, since 10xjobs keeps only outside apply links. It isn't proof, because missing data also gives null. Slice 13 decides how far to trust it.
- No columns for the description, salary, locations and so on. They stay in the raw body until a slice needs them _(my call)_.

Grants are written in the migration, as `init_users` does. `apps/db-tests/src/grants.db.spec.ts` gains the new `authenticated` grants, and RLS tests prove one user can't read another's matches and that `authenticated` can't read `intake_links` or `webhook_deliveries`. Any function this slice adds revokes the default EXECUTE from `anon` and `authenticated` (see the slice 08 note).

### The route

`POST /api/intake/:token`, in its own Nest module.

1. **Raw body.** The app is created with `rawBody: true`, so the signature is checked over the exact bytes. The JSON size limit for this route is 1 MB _(my call: the description alone can be 20,000 characters)_.
2. **API key exemption.** `apiKeyMiddleware` lets through only `POST` requests whose path is exactly `/api/intake/<one segment>`. Every other route, including `GET /api/intake/...`, still needs the key. Tests cover both sides.
3. **Token.** Hash the path token (SHA-256, hex) and look it up in `intake_links`. If there's no row, answer **401**.
4. **Signature and timestamp.** Use the code from 10xjobs's `docs/webhooks.md`, with the row's secret: a constant-time compare and a 5-minute tolerance either way. If either check fails, answer **401**. A missing or repeated header counts as a failure.
5. **Store.** All of this runs in one transaction:
   - Insert the `webhook_deliveries` row. If (`userId`, `deliveryId`) already exists, do nothing and answer **200**. That's a 10xjobs retry.
   - Then parse the body:
     - `test` event: outcome `test`, and no match.
     - `match.qualified` that parses as version 1: insert the `matches` row with `ON CONFLICT DO NOTHING` (no target, so either unique key counts). Outcome `match` if a row went in, else `duplicate-job`.
     - Anything else: outcome `unparsed`.
6. **Answer.** `200 {"ok":true}` for every signed request, including `unparsed` and duplicates. A database error answers **500**, so 10xjobs retries.

The order is deliberate: an unknown token is refused before the secret is touched, and nothing is written until the signature passes.

**LinkedIn job id:** when `job.key` starts with `linkedin-job:`, the id is the rest of the key. When `job.key` is another kind (`ats:`, `url:`, `linkedin-post:`), the id is null: the application isn't an Easy Apply form. Only when `job.key` is absent (before the 10xjobs PR) is the id taken from `job.postingUrl`, when its host is `www.linkedin.com` or `linkedin.com`. That fallback reuses the runner's parser, `apps/runner/src/linkedin/job-url.ts` (`/jobs/view/<id>` or `currentJobId`), moved into a small shared lib or copied, as the builder sees fit. When the URL is not LinkedIn's, the id is null, and the match is still stored. Slice 13 shows those but won't let them be approved.

**What a valid `match.qualified` needs:** `version === 1`, `deliveryId` equal to the header, `createdAt`, `profile.label`, `match.unverified`, `job.id`, `job.title`, `job.company.name`, `job.postingUrl`. `job.applyUrl` may be null, and `job.key` may be absent or a string. Extra fields are ignored, since new ones can appear within version 1. Checked with zod.

**Logging:** one line per request, with the delivery id (once signed), the outcome and the status code. Never the token, its hash, the secret, the signature or the body. A 401 logs only `intake: unauthorized` _(my call)_.

### Database connection

- The API gets `DATABASE_URL` (the cloud session pooler URL, as the `postgres` role, port 5432), validated in `environment.ts` (a `postgres://` or `postgresql://` URL; its value never appears in an error) and set only in the server's `.env`. **The author writes it there**: Claude has no copy of the URL, by design (`docs/database.md`). The same value is the GitHub `prod` secret.
- `libs/database` has no runtime client today. This slice adds one for application code. It does **not** go through the local-only guard (`assertLocalDatabase`), because a deployed API reaching the cloud is its purpose, not a mistake. The guard keeps covering Prisma commands, migrations and the seed, and the opt-in stays CI's alone _(my call)_. The API's local `.env.local` points at the local stack.
- Local development points `apps/api/.env.local` at the local stack (port 55322).
- `GET /api/health` adds a `select 1` and answers 503 if it fails _(my call, planned in slice 11)_. The hourly uptime check then catches a database outage too.
- The deploy keeps its order: the API deploys after `Database deploy` succeeds, so the route never runs against an unmigrated schema _(locked, slice 11)_.

### Setting up the author's link (option C)

A runbook section, in `deploy/api/README.md` or `docs/`, lists the steps:

1. The author is invited from the Supabase dashboard (Auth → Users → Invite). The `on_auth_user_created` trigger creates their `users` row. Accepting the invite isn't needed for intake.
2. Claude generates a token locally: 32 random bytes, base64url. Claude computes its SHA-256 hex and gives the author the URL `https://xapply.<ip>.sslip.io/api/intake/<token>`. The URL is not written to any repo file, because the repo is public and holds no server address.
3. The author pastes the URL into 10xjobs's Webhook page, turns the webhook on, and pastes the secret to Claude.
4. Claude inserts the `intake_links` row with `execute_sql`: the user id, the token hash and the secret.
5. The author presses "Send test", and Claude reads the `webhook_deliveries` row (outcome `test`).

Rotating works the same way. A new token means a new hash in the row plus the new URL in 10xjobs. A new secret is regenerated in 10xjobs and updated in the row. The intake stops accepting the old value as soon as the row changes.

`CLAUDE.md`'s guardrails gain one line: Claude may create and update `intake_links` rows only when the author asks in that session.

### Docs this slice updates

- `CLAUDE.md`: the stack line (the API now has a database), commands if any are added, the guardrail above, and the "Webhooks" decision: duplicates are dropped on the delivery id and on (user, 10xjobs `job.id`), and one 10xjobs PR adds `job.key`.
- `docs/database.md`: the three tables and their grants.
- The roadmap: slice 12's entry points to this spec with its spec answers, and its "no PR in 10xjobs" and "user plus the LinkedIn job id" wording is updated. Slice 13's "how Easy Apply is detected" question notes the `applyUrl` hint. Phase 2's exit criterion "matches for an email with no account are held" is out of date since slice 11 and is reworded: a match reaches only the user whose URL received it.
- `deploy/api/README.md`: `DATABASE_URL` in the server's `.env`, and the link setup steps.

## Testing

- Unit tests:
  - signature verification: valid, a wrong secret, a changed body, the timestamp ±5 min edge, a missing or repeated header;
  - the token hash;
  - the LinkedIn id from each `job.key` kind, and from each `postingUrl` shape when the key is absent, including non-LinkedIn URLs;
  - payload parsing: valid, version 2, missing fields, extra fields;
  - the middleware exemption: POST to the intake path passes, GET to it and anything else gets 401.
- Integration tests against the local stack: each outcome is written correctly, a repeated delivery id is a no-op 200, a second delivery with the same `job.id` (for example from another 10xjobs profile) gives `duplicate-job`, a new `job.id` with a LinkedIn id already stored gives `duplicate-job`, a non-LinkedIn job is stored with a null id, and a database failure gives 500.
- RLS and grants tests in `apps/db-tests`: owner-only reads on `matches`, no access to the engine-only tables.
- Live check after the deploy: the link set up as above, a "Send test" arrives as `test`, and the next real match arrives as `match` and shows in the dashboard.

## Left to the builder

- Exact table and column names, enum spellings, and the Nest module layout.
- Whether the job-id parser moves to a lib or is copied.
- How `rawBody` and the size limit are wired in Nest 11.
- Which runtime database client the API uses, from what `libs/database` offers.
