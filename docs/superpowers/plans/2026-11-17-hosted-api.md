# Hosted API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A NestJS API (`apps/api`) that answers a keyed `GET /api/health` over HTTPS from the author's shared Hetzner server, deployed on every merge to `main`, with an hourly uptime alert and Claude's SSH access.

**Architecture:** One `api` container joins an external Docker network `edge` and is served by 10xjobs's existing Caddy, which imports `/home/deploy/caddy-sites/*.caddy` after a one-time 10xjobs PR. `deploy-api.yml` copies 10xjobs's `deploy-engine.yml` (check, build, deploy jobs), cut down to one service, and installs the site file only after `caddy validate` passes. No database connection in this slice.

**Tech Stack:** NestJS 11, Nx 24.0.2 (`@nx/nest`, `@nx/webpack`, `@nx/docker`, `@nx/node`), Node 24, zod 4, Vitest, Docker Compose, Caddy `2.11.6-alpine`, GitHub Actions, GHCR.

**Spec:** [docs/superpowers/specs/2026-11-17-hosted-api-design.md](../specs/2026-11-17-hosted-api-design.md)

## Linear ticket

None. The spec has no `## Linear tickets` section.

## Global Constraints

- **The 10xapply repo is public.** Never commit the server IP, the hostname, any key or any personal data. The runbook uses `<ip>` and `<hostname>` placeholders.
- Versions match 10xjobs: `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` `^11.0.0`, `@nestjs/testing` `^11.0.0`, every `@nx/*` at `24.0.2`, `node:24-alpine` and `caddy:2.11.6-alpine`.
- Header `X-Xapply-Key` (Node lowercases it to `x-xapply-key`); env `API_KEY`, at least 32 characters. It is checked on every route, health included.
- Global prefix `api` and container port 3000. No Swagger on the hosted API.
- Image `ghcr.io/proup24/10xapply-api`, tagged `:<40-char sha>` and `:prod`.
- Compose project `xapply-api` in `/home/deploy/xapply/`. Service `api`, with network alias `xapply-api` on the external network `edge`. No host ports.
- Site file `/home/deploy/caddy-sites/xapply.caddy`, served at `/etc/caddy/sites/xapply.caddy` inside 10xjobs's Caddy container `xjobs-engine-caddy-1`. Staged as `/home/deploy/caddy-sites/.incoming-xapply` (the `*.caddy` glob skips it).
- Hostname pattern: `^xapply\.[0-9]{1,3}(-[0-9]{1,3}){3}\.sslip\.io$`, or later a real domain matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`. Anything else is refused.
- GitHub environment `prod`. Secrets: `XAPPLY_SSH_PRIVATE_KEY`, `XAPPLY_SSH_KNOWN_HOSTS`, `XAPPLY_SSH_HOST`, `XAPPLY_SSH_USER`, `XAPPLY_HOSTNAME` and `XAPPLY_API_KEY`.
- No error body or log line ever contains the key or request headers.
- Claude's server rules, written into `CLAUDE.md` and not enforced by the guard:
  - **Allowed without asking:** status and logs for both projects, and restarting or redeploying 10xapply's `api`.
  - **Only on the author's ask in that session:** anything else on 10xjobs's side.
  - **Never:** printing a secret value: a `.env`, `docker inspect`, `docker compose config`, `printenv` or `env` in a container, or `/proc/*/environ`.
- Commit messages go through `git commit -F <file>`; PR bodies through `gh pr create --body-file <file>` (see the guard rules in `CLAUDE.md`).
- Work on branch `hosted-api`, created from `main`. The spec and this plan are its first commit.

## Review Focus

1. **A key with stray whitespace in the server `.env`** (a trailing `\r` or a space) must fail at startup with a message naming `API_KEY`. Otherwise every request gets 401 for no visible reason. Owned by Task 2.
2. **A repeated `X-Xapply-Key` header** arrives as an array and must get 401, never a match on its first element. Owned by Task 3.
3. **`XAPPLY_HOSTNAME` set with a scheme, a path or a trailing newline** (`https://xapply…/`) must make the render refuse it with a plain error, never write a broken site file into the shared Caddy. Owned by Task 5.
4. **A site file present while 10xapply's container is down** must still let Caddy start, serving 10xjobs. Proven by the throwaway Caddy check in Task 5.
5. **A rollback dispatch naming a tag that is not in GHCR** must leave the live compose file, the site file and `image.env` untouched, because the pull happens with staged files first. Owned by Task 6's review step.

---

### Task 0: Branch and commit the spec

**Files:**

- Add: `docs/superpowers/specs/2026-11-17-hosted-api-design.md`, `docs/superpowers/plans/2026-11-17-hosted-api.md`

- [ ] **Step 1:** `git stash push .claude/settings.json` if it is still modified, then `git switch main && git pull --ff-only && git switch -c hosted-api`. Then `git stash pop`. The spec and plan are untracked, so they follow you.
- [ ] **Step 2:** Commit both files with the message `docs(api): hosted API spec and plan`.

### Task 1: The 10xjobs PR (the shared Caddy loads other sites)

Done in the 10xjobs repo, under **its** `CLAUDE.md` and guard. Its local `main` has another session's uncommitted work, so use a worktree: `git -C /home/lab/apps/10xjobs worktree add ../10xjobs-caddy-sites -b feat/caddy-sites-import origin/main`.

**Files (in the 10xjobs worktree):**

- Modify: `deploy/engine/Caddyfile`: add `import /etc/caddy/sites/*.caddy` as the last line, after the existing site block.
- Modify: `deploy/engine/compose.yaml`, `caddy` service:
  - add `- /home/deploy/caddy-sites:/etc/caddy/sites:ro` to `volumes`;
  - add `networks: [default, edge]`;
  - add a top-level `networks: { default: {}, edge: { external: true } }`.
- Modify: `deploy/engine/README.md`: a new section, "Other sites on this server". It says:
  - `edge` and `/home/deploy/caddy-sites` must exist **before** this change deploys: as `deploy`, `docker network create edge` and `mkdir -p /home/deploy/caddy-sites`.
  - 10xapply ships `xapply.caddy` there and reloads this Caddy itself.
  - A 10xjobs deploy reloads the imported sites too.
  - A broken site file is refused by 10xapply's validate step before it is installed.

- [ ] **Step 1:** Make the three edits.
- [ ] **Step 2:** Verify the compose file: `docker network create edge 2>/dev/null; ENGINE_IMAGE_TAG=x ENGINE_HOSTNAME=example.test docker compose -f deploy/engine/compose.yaml --env-file /dev/null config -q`. Expected: exit 0. If it complains about `env_file: .env`, run it from a temp folder holding an empty `.env`.
- [ ] **Step 3:** Verify Caddy accepts the glob with an empty folder: `mkdir -p /tmp/sites && docker run --rm -e ENGINE_HOSTNAME=example.test -v "$PWD/deploy/engine/Caddyfile:/etc/caddy/Caddyfile:ro" -v /tmp/sites:/etc/caddy/sites:ro caddy:2.11.6-alpine caddy validate --config /etc/caddy/Caddyfile`. Expected: `Valid configuration`.
- [ ] **Step 4:** Commit (`feat(deploy): caddy imports other sites from caddy-sites, on the edge network`), push with `git push -u origin feat/caddy-sites-import`, and open a PR to 10xjobs `main` with `--body-file`. The body states the setup order: network and folder first, then merge.
- [ ] **Step 5:** Tell the author the PR number and the two server commands to run before merging it. Do not wait for it; Tasks 2–8 don't depend on it.

### Task 2: Scaffold `apps/api` and its environment

**Files:**

- Modify: `package.json` (root devDependencies: `@nx/nest`, `@nx/webpack`, `@nx/docker` and `@nx/node` at `24.0.2`; `@nestjs/testing` `^11.0.0`), `nx.json` (the plugins the generator adds), `pnpm-lock.yaml`
- Create: `apps/api/package.json`, `tsconfig*.json`, `webpack.config.js`, `vitest.config.mts`, `eslint.config.mjs`, `src/main.ts`
- Create: `apps/api/src/config/environment.ts`
- Test: `apps/api/src/config/environment.spec.ts`

**Interfaces:**

- Produces:
  - `environmentSchema` (zod);
  - `type Environment = { API_KEY: string; PORT: number; NODE_ENV: 'development' | 'production' | 'test' }`;
  - `loadEnvironment(env: NodeJS.ProcessEnv): Environment`. It throws `Error` whose message names the failing variables and never includes a value.

- [ ] **Step 1:** Generate: `pnpm nx g @nx/nest:application apps/api --name=api --linter=eslint --unitTestRunner=none --e2eTestRunner=none` (check `--help` first; never guess flags). Then align with 10xjobs's `apps/xjobs`:
  - `package.json` name `@xapply/api`, with the `prune-lockfile`, `copy-workspace-modules`, `prune`, `serve` and `docker:build` targets copied from 10xjobs's `apps/xjobs/package.json` (paths changed to `apps/api`, no worker targets). Not `"type": "module"`: webpack emits CommonJS, as in 10xjobs.
  - `webpack.config.js` as 10xjobs's, with one entry (`./src/main.ts`), no externals and no `src` alias unless needed.
  - `tsconfig.app.json` with `experimentalDecorators` and `emitDecoratorMetadata`.
  - `vitest.config.mts` like `apps/runner`'s (name `@xapply/api`).
  - Delete the generated sample controller, service and module.
- [ ] **Step 2: Write the failing tests** in `environment.spec.ts`:
  - `accepts a 32-char key and defaults PORT to 3000 and NODE_ENV to development`;
  - `rejects a missing API_KEY, and the message names API_KEY`;
  - `rejects a 31-char API_KEY`;
  - `rejects an API_KEY with surrounding whitespace or a trailing \r` (Review Focus 1);
  - `the error message never contains the key value`: build a key of 31 `k`s and assert the message has no `kkkk`.
- [ ] **Step 3:** Run `pnpm nx test api`. Expected: FAIL (module not found).
- [ ] **Step 4:** Implement `apps/api/src/config/environment.ts`. `API_KEY` is `z.string().min(32).regex(/^\S+$/)`, and `PORT` is `z.coerce.number().int().min(1).max(65535).default(3000)`. In `main.ts`, unless `XAPPLY_SKIP_ENV_FILES=1`, load `apps/api/.env.local` with `process.loadEnvFile` when it exists, then call `loadEnvironment(process.env)`.
- [ ] **Step 5:** Run `pnpm nx test api`. Expected: PASS. Also run `pnpm nx run-many -t lint typecheck build -p api`. Expected: all pass.
- [ ] **Step 6:** Commit: `feat(api): scaffold the NestJS API app and its environment`.

### Task 3: The key check and health route

**Files:**

- Create: `apps/api/src/common/api-key.middleware.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/app.module.ts`, `apps/api/src/create-app.ts`
- Modify: `apps/api/src/main.ts` (calls `createApp`, then `listen(env.PORT, '0.0.0.0')`)
- Test: `apps/api/src/common/api-key.middleware.spec.ts`, `apps/api/src/create-app.spec.ts`

**Interfaces:**

- Consumes: `Environment` and `loadEnvironment` from Task 2.
- Produces:
  - `API_KEY_HEADER = 'x-xapply-key'`.
  - `apiKeyMiddleware(expected: string): (req: Request, res: Response, next: NextFunction) => void`. It compares SHA-256 digests with `timingSafeEqual`, as 10xjobs's `engine-key.middleware.ts` does. Only a single string header counts. A failure answers `401` with exactly `{"error":"unauthorized"}` and no `WWW-Authenticate` header.
  - `createApp(env: Environment): Promise<NestExpressApplication>`. It disables `x-powered-by`, applies `app.use(apiKeyMiddleware(env.API_KEY))` before the routes, sets the global prefix `api`, and does no Swagger.
  - `HealthController`: `GET health` returns `{ status: 'ok' }` with `@Header('Cache-Control', 'no-store')`.
- The spec says "one global guard". This uses a middleware instead, as 10xjobs does, because Nest's exception filters don't wrap `app.use` middleware. That keeps the 401 body fixed. Slice 12 adds its opt-out inside this middleware.

- [ ] **Step 1: Write the failing tests.**
  - In `api-key.middleware.spec.ts`, with fake req and res:
    - `calls next for the right key`;
    - `401 for no header`;
    - `401 for a wrong key of the same length`;
    - `401 for a key of a different length`;
    - `401 for a repeated header (array)` (Review Focus 2);
    - `the 401 body is exactly {"error":"unauthorized"} and never contains the sent key`.
  - In `create-app.spec.ts`: `createApp` with a test env, then `app.listen(0)` and global `fetch`:
    - `GET /api/health with the key → 200 {"status":"ok"}, Cache-Control no-store`;
    - `GET /api/health without the key → 401`;
    - `GET /api/nope without the key → 401, with the key → 404`;
    - `no x-powered-by header`.
  - Close the app in `afterAll`.
  - Vitest's esbuild doesn't emit decorator metadata. Keep the controller free of constructor injection. If a test still needs metadata, add `unplugin-swc` to the vitest config.
- [ ] **Step 2:** `pnpm nx test api`. Expected: FAIL.
- [ ] **Step 3:** Implement the four files and wire `main.ts`.
- [ ] **Step 4:** `pnpm nx test api`. Expected: PASS. Also `pnpm nx run-many -t lint typecheck build -p api`. Expected: pass.
- [ ] **Step 5:** Commit: `feat(api): keyed health route`.

### Task 4: The image

**Files:**

- Create: `apps/api/Dockerfile` (10xjobs's, minus the Claude CLI lines: `FROM docker.io/node:24-alpine`, `ENV HOST=0.0.0.0 PORT=3000`, `WORKDIR /app`, `COPY dist .`, `RUN npm --omit=dev -f install`, `CMD ["node","main.js"]`)
- Modify: `apps/api/package.json` (`docker:build` options, if the plugin needs any)

- [ ] **Step 1:** `pnpm nx run @xapply/api:prune`, then check that `apps/api/dist/` has `main.js`, `package.json`, `pnpm-lock.yaml` and `workspace_modules`. Expected: all present. `workspace_modules` may be empty, but must exist.
- [ ] **Step 2:** Build the image: `docker build -t xapply-api:local apps/api`.
- [ ] **Step 3:** Run it and check the health route:
  - `docker run -d --name xapply-api-test -e API_KEY=$(openssl rand -hex 24) -e XAPPLY_SKIP_ENV_FILES=1 -e NODE_ENV=production -p 127.0.0.1:3999:3000 xapply-api:local`;
  - then `curl -s -o /dev/null -w '%{http_code}' localhost:3999/api/health`. Expected: `401`.
  - Then `docker rm -f xapply-api-test`. The key is random and thrown away, so never print it.
- [ ] **Step 4:** Commit: `feat(api): docker image`.

### Task 5: Deploy files, the site file, and the offline checks

**Files:**

- Create: `deploy/api/compose.yaml`
  - Service `api` with image `ghcr.io/proup24/10xapply-api:${API_IMAGE_TAG:?}`, `restart: unless-stopped`, `stop_grace_period: 30s`, `env_file: .env`, environment `NODE_ENV: production` and `XAPPLY_SKIP_ENV_FILES: "1"`, and `expose: ["3000"]`.
  - `networks: { edge: { aliases: [xapply-api] } }`, with top-level `edge: { external: true }`.
  - A healthcheck: `wget -qO- --header "X-Xapply-Key: $$API_KEY" http://127.0.0.1:3000/api/health`, interval 15s, timeout 5s, retries 5, start_period 20s.
  - 10xjobs's `x-logging` anchor (10m × 5).
- Create: `deploy/api/xapply.caddy.template`: `__HOSTNAME__ {` / `encode gzip` / `reverse_proxy xapply-api:3000` / `}`.
- Create: `deploy/api/.env.example`: `API_KEY=` with a comment: at least 32 characters, no spaces; generate with `openssl rand -hex 32`.
- Create: `deploy/api/render-site.sh <hostname>`. It prints the site file to stdout. It exits 2 with `invalid hostname` (never echoing the input) unless the argument matches the hostname pattern in Global Constraints.
- Create: `deploy/api/install-site.sh`. It runs **on the server**, as `deploy`, from `~/xapply`, reading `/home/deploy/caddy-sites/.incoming-xapply`:
  1. Back up the current `xapply.caddy` if there is one.
  2. Validate the full config with the staged file in place. Copy it to `xapply.caddy`, run `docker exec xjobs-engine-caddy-1 caddy validate --config /etc/caddy/Caddyfile`, and on failure restore the backup (or remove the file if there was none), then exit 1.
  3. Run `docker exec xjobs-engine-caddy-1 caddy reload --config /etc/caddy/Caddyfile`. On failure, restore and reload again, then exit 1.
  4. Write with `cat >`, not `mv`, so Caddy's bind mount keeps seeing the folder. The folder is a directory mount, so either works; `cat` mirrors 10xjobs.
- Create: `deploy/api/vendor/10xjobs.Caddyfile`: a copy of the Caddyfile from Task 1's branch, with a top comment saying it mirrors 10xjobs's `deploy/engine/Caddyfile` for CI only and must be updated when that file changes.
- Create: `scripts/deploy-api-check.sh`. Offline checks, each printing one `ok:` line:
  1. `shellcheck deploy/api/*.sh scripts/deploy-api-check.sh`.
  2. `docker compose -f deploy/api/compose.yaml config -q`, run in a temp folder with an empty `.env`, `API_IMAGE_TAG=x`, and the `edge` network created if missing.
  3. Render with `xapply.203-0-113-10.sslip.io` into a temp sites folder, then `caddy validate` the vendored Caddyfile with that folder mounted, using `caddy:2.11.6-alpine` and `ENGINE_HOSTNAME=api.203-0-113-10.sslip.io`.
  4. A throwaway Caddy started with `caddy run` on the same config, publishing no ports. It must still be running after 5 s, even though `xapply-api` doesn't exist (Review Focus 4). Then remove it.
  5. A deliberately broken site file (`__HOSTNAME__ {` with no closing brace) makes `caddy validate` fail (Done when 6).
- Create: `scripts/render-site.test.mjs` (node:test, run by `pnpm test:scripts`):
  - it renders the sslip example and a real domain;
  - it refuses `https://xapply.1-2-3-4.sslip.io/`, a trailing `\n`, an empty string, `a b`, `x;rm -rf ~` and `xapply.1-2-3-4.sslip.io/path`, each with exit 2 and no echo of the input (Review Focus 3).
- Modify: `scripts/ci-changes.mjs` (and its test): a new area `deploy`, true for `deploy/` and `scripts/deploy-api-check.sh`.
- Modify: `.github/workflows/ci.yml`: a `deploy-files` job gated on `deploy` (or a push) that runs `scripts/deploy-api-check.sh`. Ubuntu runners have Docker and shellcheck. Add it to `ci-ok`'s `needs`.

- [ ] **Step 1:** Write `scripts/render-site.test.mjs` and the `ci-changes` test case. Run `pnpm test:scripts`. Expected: FAIL.
- [ ] **Step 2:** Write `render-site.sh`, then the `ci-changes` change. Run `pnpm test:scripts`. Expected: PASS.
- [ ] **Step 3:** Write the remaining files.
- [ ] **Step 4:** Run `scripts/deploy-api-check.sh`. Expected: five `ok:` lines, exit 0.
- [ ] **Step 5:** Commit: `feat(deploy): api compose, the shared-Caddy site file and offline checks`.

### Task 6: `deploy-api.yml`

**Files:**

- Create: `.github/workflows/deploy-api.yml`

Copy 10xjobs's `.github/workflows/deploy-engine.yml` job for job (`check`, `build`, `deploy`), with these changes only:

- Name `Deploy API`, triggered by `workflow_run` of `Database deploy` (that workflow's run name carries the migrated SHA, as 10xjobs's does). Concurrency `deploy-api`, environment `prod`, and `IMAGE: ghcr.io/proup24/10xapply-api`.
- **Guard** on `XAPPLY_SSH_HOST`. The "migrations ran" check reads `Database deploy`'s job named `deploy`.
- **Build:** `pnpm exec nx run @xapply/api:prune`, a dist-layout check (`main.js`, `package.json`, `pnpm-lock.yaml`, `workspace_modules`), context `apps/api`, tags `:<sha>` and `:prod`.
- **Deploy**, using the server folder `~/xapply` and project `xapply-api`:
  - The "newer commit" check reads `~/xapply/image.env` (`API_IMAGE_TAG=`).
  - Copy `deploy/api/compose.yaml` to `~/xapply/.incoming/`. Render the site file in CI with `XAPPLY_HOSTNAME`, then `scp` it to `/home/deploy/caddy-sites/.incoming-xapply`. Copy `install-site.sh` to `~/xapply/`.
  - Roll out: prune old 10xapply images (keep the new one and the previous one), then `pull api` with the staged compose file, then `mv` it in place, then write `image.env`, then `docker compose -p xapply-api --env-file image.env --env-file .env up -d --remove-orphans`, then `bash ~/xapply/install-site.sh`.
  - GHCR login and logout exactly as 10xjobs does. **Deviation:** run them with `DOCKER_CONFIG=~/xapply/.docker` on every docker command in this workflow, so this repo's login never shares or clears 10xjobs's.
  - Health check from CI, not from inside a container. Wait for the container's own healthcheck with `docker inspect -f '{{.State.Health.Status}}'`, which prints only the status. Then `printf 'X-Xapply-Key: %s\n' "$XAPPLY_API_KEY" | curl -sf --retry 12 --retry-delay 5 --retry-all-errors -H @- "https://$XAPPLY_HOSTNAME/api/health"`, and check that a request without the key gets `401`. Never use `printenv`.
  - The failure dump shows `ps` and `logs --tail 100 api`, for 10xapply only.
- Keep 10xjobs's comments that still apply. Keep the chain-depth note: CI → Database deploy → Deploy API is the maximum of three levels.

- [ ] **Step 1:** Write the workflow.
- [ ] **Step 2:** Lint it: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/deploy-api.yml`. Expected: no findings. Shellcheck findings inside `run:` blocks count too.
- [ ] **Step 3:** Review Focus 5: read the rollout step and confirm that a failed `pull` exits before any `mv`, before `image.env` is written, and before `install-site.sh` runs. Write that order as a comment above the step.
- [ ] **Step 4:** Commit: `feat(ci): deploy the API after the database deploy`.

### Task 7: `api-uptime.yml`

**Files:**

- Create: `.github/workflows/api-uptime.yml`
  - `on: schedule: [{cron: '17 * * * *'}]` and `workflow_dispatch`; `permissions: {}`; environment `prod`; `timeout-minutes: 5`.
  - First step: if `XAPPLY_HOSTNAME` is empty, print `::notice::` and end green.
  - Then `printf 'X-Xapply-Key: %s\n' "$XAPPLY_API_KEY" | curl -sf -o /dev/null --retry 4 --retry-delay 15 --retry-all-errors -H @- "https://$XAPPLY_HOSTNAME/api/health"`. On failure, print `::error::API health failed` (no hostname in the log, since the repo is public) and exit 1.
  - A comment saying GitHub emails failures of scheduled runs to whoever last changed the cron line.

- [ ] **Step 1:** Write it. Lint it with actionlint as in Task 6. Expected: no findings.
- [ ] **Step 2:** Commit: `feat(ci): hourly API uptime check`.

### Task 8: Runbook and docs

**Files:**

- Create: `deploy/api/README.md` (the runbook). Placeholders only. It covers:
  - **First setup, in order:**
    1. As `deploy`: `docker network create edge`; `mkdir -p /home/deploy/caddy-sites /home/deploy/xapply`.
    2. Merge Task 1's 10xjobs PR and confirm 10xjobs's health.
    3. Create `~/xapply/.env` (mode 600) from `.env.example`.
    4. Create CI's deploy key (`ssh-keygen -t ed25519 -N '' -C xapply-ci`) and add its public half to `authorized_keys`.
    5. Add Claude's public key from Task 9.
    6. Add the six GitHub `prod` secrets (`XAPPLY_SSH_KNOWN_HOSTS` from `ssh-keyscan`).
    7. Trigger a deploy with a merge or a dispatch.
  - **Day to day:**
    - logs (`docker compose -p xapply-api logs -f api`);
    - restart;
    - changing the key (edit `.env`, `up -d`, then update the `XAPPLY_API_KEY` secret);
    - rollback by dispatch with `image_tag`;
    - adding or removing a key;
    - moving to a real domain (a new `XAPPLY_HOSTNAME`, then redeploy);
    - what to do when `install-site.sh` refuses the site file (Caddy keeps the old config; read the validate error in the job log).
  - **What's shared with 10xjobs:** the `edge` network, the sites folder, 10xjobs's Caddy, and the order for changing them.
- Modify: `CLAUDE.md`
  - "Decisions so far: Webhooks": rewritten as in the spec's "A decision this brainstorm changed" (per-user URL token plus the pasted 10xjobs secret; deduplication on `X-10xjobs-Delivery` and on user plus LinkedIn job id; no email shared; no held matches; no 10xjobs PR).
  - "Separate from 10xjobs": servers are shared (author, 2026-11-17).
  - Stack: the API is set up (slice 11), and the project count becomes eight.
  - Commands: `pnpm nx serve api` (needs `apps/api/.env.local` with `API_KEY`, written by the author) and `pnpm nx run @xapply/api:docker:build`.
  - Guardrails: a "Server access" bullet with Claude's rules from Global Constraints, and the key path `~/.ssh/10xapply-server`.
- Modify: `docs/roadmap/README.md`
  - Slice 11: add a spec link and mark its "Spec answers" as settled: shared server _(user)_.
  - Slice 12: new scope and locks per the spec. Its spec answers drop the signing scheme, held matches and when 10xjobs sends. They keep idempotency details, how the user gets and rotates their URL and secret, and the database role the API uses.
  - Slice 17: the resume reference becomes a new field in 10xjobs's payload version 1.
  - Build order step 3: no sending PR in 10xjobs.

- [ ] **Step 1:** Write the runbook and edit the docs.
- [ ] **Step 2:** `pnpm format:check`. Expected: clean. Then `grep -rnE '[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}\.sslip' deploy docs CLAUDE.md`. Expected: only the `203-0-113-10` documentation example.
- [ ] **Step 3:** Commit: `docs: hosted API runbook; webhooks and shared server decisions`.
- [ ] **Step 4:** Push `git push -u origin hosted-api` and open the PR with `--body-file`. The body lists the author's setup steps and says that `Deploy API` skips itself until the secrets exist, so merging first is safe.

### Task 9: Claude's key, the author's setup, and the live checks

Each step here needs the author: they run the server and GitHub steps, and Claude runs only what the spec allows.

- [ ] **Step 1:** Claude runs `ssh-keygen -t ed25519 -N '' -C claude-10xapply -f ~/.ssh/10xapply-server` and gives the author **only** the `.pub` line.
- [ ] **Step 2:** The author follows the runbook's first setup (steps 1–6) and merges the 10xjobs PR, then the `hosted-api` PR.
- [ ] **Step 3:** Check Done when 1–3: the run chain CI → Database deploy → Deploy API goes green; `image.env` on the server holds the merge SHA; `curl` with the key returns 200; without it, 401; 10xjobs's hostname still answers.
- [ ] **Step 4:** Done when 8: Claude runs `ssh -i ~/.ssh/10xapply-server deploy@<host> 'docker compose -p xapply-api ps; docker compose -p xjobs-engine ps'`. Expected: both listed.
- [ ] **Step 5:** Done when 4, **only on the author's ask**: the hairpin check from inside 10xjobs's `api` container. The key goes over stdin from this machine, never `printenv`: `printf 'X-Xapply-Key: %s\n' "$KEY" | ssh … 'docker exec -i xjobs-engine-api-1 sh -c "wget -qO- --header \"\$(cat)\" https://<hostname>/api/health"'`. The author provides `KEY` in their own shell, or runs the step themselves. Expected: `{"status":"ok"}`.
- [ ] **Step 6:** Done when 5 and 7: Claude runs `docker compose -p xapply-api stop api`. Then:
  - 10xjobs's health still answers, and 10xapply's hostname returns 502;
  - the author dispatches `API uptime`, which fails, and the author confirms the email.
  - Then Claude runs `docker compose -p xapply-api start api`, and a second dispatch passes.
- [ ] **Step 7:** Done when 9: dispatch `Deploy API` with the previous SHA, and confirm `image.env`. Then dispatch with the current SHA.
- [ ] **Step 8:** Record the outcome in memory (slice 11 merged, live checks passed or pending), and run `/linear-tickets sync` only if a tickets map was added by then.
