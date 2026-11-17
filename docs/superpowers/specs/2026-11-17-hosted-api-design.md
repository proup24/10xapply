# Hosted API: design

Date: 2026-11-17
Status: approved 2026-11-17
Roadmap slice: [11 Hosted API](../../roadmap/README.md#11-hosted-api)
Copies from: 10xjobs specs `2026-11-10-engine-hosting-design.md` and `2026-11-10-engine-auth-design.md`, and its `deploy/engine/` and `.github/workflows/deploy-engine.yml`.

Decision marks: _(user)_ the author decided it in the brainstorm; _(10xjobs)_ copied from 10xjobs's settled choice; _(my call)_ Claude's proposal, open to correction.

## Intent

10xapply gets a NestJS API that is always up, on a hosted server, deployed by a merge to `main`. Slice 12 adds its first real route: the receiver for 10xjobs's match webhook. Once that lands, real matches from 10xjobs give the author eligible jobs, which 07b's open items and 07c's misses need (build order decided 2026-11-16 _(user)_).

This slice ships only the hosting: an API app answering a keyed health check over HTTPS, the server setup, the deploy, an uptime alert, and the decisions that slice 12 builds on.

## A decision this brainstorm changed: 10xapply receives 10xjobs's existing webhook

10xjobs already built general match webhooks (its PRs #72–#76, documented in its `docs/webhooks.md`): each 10xjobs user sets one `https` URL and gets their own secret; each new qualified match is POSTed as 10xjobs's own versioned JSON payload, signed `v1=` HMAC-SHA256 over `${timestamp}.${rawBody}`, with a stable `X-10xjobs-Delivery` id.

**10xapply receives that webhook as it is** _(user)_. It replaces the plan in `CLAUDE.md` ("Webhooks": one integration API key, the user's email in the payload, a payload 10xapply defines, a sending PR in 10xjobs). In its place:

- Each 10xapply user gets **their own intake URL** carrying a long random token, which identifies the 10xapply user. They paste it into 10xjobs's Webhook page, and paste 10xjobs's secret back into 10xapply.
- The intake checks the token, the signature and the timestamp (5 min tolerance), stores the request, and answers 2xx at once.
- Duplicates are dropped on `X-10xjobs-Delivery` and on (user, LinkedIn job id from `job.postingUrl`).
- **No email crosses between the apps.** No held matches for unknown emails: nobody has a URL without a 10xapply account.
- **No PR in 10xjobs** for sending.

Consequences slice 12 inherits:

- One webhook URL per 10xjobs user, so a user who points it at 10xapply can't also feed Slack or n8n from it. Accepted _(user)_.
- 10xjobs retries for about 21 h and auto-disables after 10 failed sends in a row, and never resends what it missed. So downtime longer than about a day loses matches. Hence the uptime alert in this slice.
- The payload has no Easy Apply flag and no resume reference. Slice 13 detects Easy Apply (already an open question there); slice 17 can add a field in 10xjobs within payload version 1.

This slice updates `CLAUDE.md` ("Webhooks" and "Separate from 10xjobs") and the roadmap's slice 11 and 12 entries to match. Slice 12's own spec designs the intake itself.

## Goals

- A NestJS API app, `apps/api`, built and tested through Nx, mirroring 10xjobs's engine layout and versions (NestJS 11, Nx 24, Node 24).
- It runs on **the author's existing Hetzner server, alongside 10xjobs** _(user)_, served over HTTPS by **10xjobs's existing Caddy**.
- A merge to `main` deploys it after `Database deploy` succeeds, with no manual step.
- `GET /api/health` answers 200 over HTTPS with the API key, and 401 without it.
- An hourly check emails the author when the API is down.
- Claude can SSH into the server to read status and logs and restart 10xapply's API _(user)_.

## Non-goals

- The intake route, its tables and the per-user token and secret (slice 12).
- A database connection. The API needs none until slice 12, so slice 11 holds no database credential _(my call: build only what the slice needs; health checks the process only)_.
- Redis, workers and queues (Phase 3, per the roadmap).
- A real domain, monitoring beyond restarts, logs and the uptime check, and server backups (all state is in Supabase).
- A separate server for 10xapply. Considered and declined (see Approaches).

## Anti-goals (failure even if it works)

- 10xjobs going down or misbehaving because of 10xapply: a 10xapply deploy breaking 10xjobs's Caddy, network or containers.
- Secrets in git, in the image, in workflow logs or in the runbook.
- 10xapply code running against a schema it was not migrated for.
- Any API route answering without the key. Slice 12's intake route is the one planned exception, and it authenticates itself.
- The API's port or anything internal reachable from the internet other than through Caddy.
- Claude printing either app's secret values (from a `.env`, the container environment or the resolved compose config), or touching 10xjobs's containers without the author's ask in that session.

## Approaches

1. **Copy 10xjobs's engine hosting, cut down, on a new small server.** Own Caddy, own box, about €4–5 a month. It gives full separation, so Claude's access and any compromise of 10xapply reach only 10xapply. Declined: the author already runs a server with Caddy and accepts the shared risk.
2. **Share the 10xjobs server and its Caddy** _(user picked)_. One extra container, with a site file that 10xjobs's Caddy imports. It costs nothing more and needs one small one-time PR in 10xjobs. In exchange, the two apps share a box, a Caddy and a Docker network, and two repos deploy to one host, so the shared parts need a set order for changes. Claude's SSH access reaches both projects; the author accepts that knowingly _(user)_.
3. **A platform such as Fly or Render.** Ruled out: it breaks "mirror 10xjobs" and makes the later merge harder.

## Design

### The API app

- `apps/api`, generated with `@nx/nest` and shaped like 10xjobs's `apps/xjobs`: global prefix `api`, port 3000, `main.ts`, `app.module.ts`, `config/environment.validation.ts` (zod), and an `XAPPLY_SKIP_ENV_FILES` switch like the other projects _(10xjobs)_.
- **One global guard** checks the header `X-Xapply-Key` against `API_KEY` (at least 32 characters, compared in constant time) on every route, health included _(10xjobs, engine-auth)_. Slice 12 adds a decorator that lets the intake route opt out and authenticate itself. Slice 11 ships no opt-out.
- `GET /api/health` returns `{ "status": "ok" }` with `Cache-Control: no-store` _(my call: no dependencies to check yet; slice 12 adds the database)_.
- No Swagger on the hosted API. Errors never echo the key or request headers.
- A `Dockerfile` like 10xjobs's: `node:24-alpine`, the pruned `dist`, `npm --omit=dev install`, `CMD node main.js`. No Claude CLI. Built with `@nx/docker` (`nx docker:build api` after `build` and `prune`) _(10xjobs)_.

### The server, shared with 10xjobs

What exists today: 10xjobs's compose project `xjobs-engine` lives in `/home/deploy/engine/`. Its Caddy publishes 80 and 443 and serves `{$ENGINE_HOSTNAME}` → `api:3000`. Every 10xjobs deploy copies `deploy/engine/Caddyfile` over the server's copy and reloads Caddy.

**The one-time 10xjobs PR** (specced here; the plan's first task builds it in the 10xjobs repo, on its own branch and under that repo's guardrails, and the author merges it there _(my call)_):

- `deploy/engine/Caddyfile` gains `import /etc/caddy/sites/*.caddy` after its own site block.
- `deploy/engine/compose.yaml`: Caddy mounts `/home/deploy/caddy-sites` read-only at `/etc/caddy/sites`, and joins an external Docker network `edge` as well as its default one.
- Its runbook gets a short "Other sites on this server" section: the `edge` network, the sites folder, and the fact that 10xapply ships `xapply.caddy` there.
- The import is a glob, so an empty folder is valid. The PR is safe to deploy before 10xapply exists **only once the `edge` network and the `caddy-sites` folder exist on the server**: without the network, 10xjobs's `up` fails after its deploy has already moved the new files in place, and a missing bind-mount source would be created owned by root. Hence the order below.

**One-time server setup by the author**, in this order (runbook in this repo):

1. As `deploy`: `docker network create edge`, `mkdir /home/deploy/caddy-sites /home/deploy/xapply`.
2. Merge the 10xjobs PR and let it deploy; check 10xjobs's health.
3. In this repo's setup, write `/home/deploy/xapply/.env` (mode 600) holding `API_KEY`. Then add CI's and Claude's public keys to `deploy`'s `authorized_keys`, and add the GitHub secrets. No new firewall rule is needed, since 80 and 443 are already open.

**10xapply on the server** _(my call unless marked)_:

- Compose project `xapply-api` in `/home/deploy/xapply/` with one service, `api`. The image is `ghcr.io/proup24/10xapply-api:${API_IMAGE_TAG}`, with `restart: unless-stopped`, `stop_grace_period: 30s`, `env_file: .env`, `NODE_ENV=production` and `XAPPLY_SKIP_ENV_FILES=1`.
- `api` joins the `edge` network with the alias `xapply-api` and publishes no host port.
- A Docker healthcheck calls `/api/health` with the key, using `$$` as 10xjobs's compose does. `json-file` logs rotate (10m × 5) _(10xjobs)_.
- **Hostname:** `xapply.<ip-with-dashes>.sslip.io` on the server's IP (10xjobs's engine has `api.…`). Caddy gets its certificate automatically. Moving to a real domain later is a new hostname value plus a DNS record.
- **Site file** `/home/deploy/caddy-sites/xapply.caddy`, rendered by the deploy from `deploy/api/xapply.caddy.template` with the literal hostname: `<hostname> { encode gzip; reverse_proxy xapply-api:3000 }`.

**Shared-Caddy safety** (the main anti-goal):

- The deploy stages the new site file and runs `caddy validate` on the full config with it, inside 10xjobs's Caddy container. Only on success does it move the file in place and `caddy reload`.
- If the reload fails, the deploy restores the previous file and reloads again. Caddy keeps its old config on a failed reload in any case.
- A bad file therefore never reaches a Caddy restart, where it would stop Caddy from starting and take 10xjobs down with it.
- If 10xapply's container is down, Caddy still starts and only 10xapply's hostname returns 502, because upstreams resolve at request time.
- 10xapply's deploy touches only its own compose project, its own site file, and `caddy validate` and `caddy reload` in 10xjobs's Caddy container. It never runs `up`, `pull` or `down` on `xjobs-engine`.

**10xjobs calling its own server:** 10xjobs's engine sends to `xapply.<ip>.sslip.io`, which resolves to the box's public IP. 10xjobs's address guard allows public IPs, so it connects out and back in. Slice 11 checks that the hostname answers from inside 10xjobs's API container (a `wget` with the key); slice 12's live check runs a real "Send test".

### Deploy

New workflow `.github/workflows/deploy-api.yml` _(10xjobs, cut down)_:

- **Trigger:** `workflow_run` of `Database deploy` completing with `success` on `main`, plus `workflow_dispatch` with an optional `image_tag` for rollback.
- **Settings:** GitHub environment `prod` (as `Database deploy`), and `concurrency: deploy-api`, not cancel-in-progress.
- **Skips itself, green, with a notice** until the `XAPPLY_SSH_HOST` secret exists, so it can merge before the server is set up.
- **Steps:**
  1. Check out `head_sha`.
  2. Install, build and prune.
  3. Build the image, tag it `:<sha>` and `:prod`, and push it to GHCR. The rollback dispatch skips this.
  4. `scp` `deploy/api/compose.yaml` and the rendered site file to staging names on the server.
  5. On the server: `docker login ghcr.io` with the job's `GITHUB_TOKEN` (`packages: read`), pull, `up -d --remove-orphans`, then `docker logout`. Prune old 10xapply images only, keeping a few.
  6. Install the site file: validate, then move it in place and reload, as above.
  7. Wait for `https://<hostname>/api/health` to return 200 with the key; fail the job otherwise.
- **Secrets (`prod` environment):**
  - `XAPPLY_SSH_PRIVATE_KEY`: CI's own ed25519 key, separate from 10xjobs's.
  - `XAPPLY_SSH_KNOWN_HOSTS`, `XAPPLY_SSH_HOST` and `XAPPLY_SSH_USER` (`deploy`).
  - `XAPPLY_HOSTNAME`.
  - `XAPPLY_API_KEY`, for the health wait and the uptime check.
- **Rollback:** dispatch with an earlier SHA.

`Database deploy` runs only after CI passes on a push to `main`, and CI runs only on code changes. A docs-only merge therefore deploys nothing, which is fine _(my call)_.

### Uptime alert

New workflow `.github/workflows/api-uptime.yml`, run hourly by `schedule` and also by `workflow_dispatch` _(my call)_:

- It `curl`s `https://<hostname>/api/health` with the key, with a few retries over about a minute.
- It fails on anything but 200, and GitHub emails the author about the failed scheduled run.
- It skips itself until `XAPPLY_HOSTNAME` is set.
- Hourly checks leave plenty of room inside 10xjobs's 21-hour retry window.

### Claude's server access _(user, details my call)_

- Claude generates its own ed25519 key on the author's machine, outside the repo (`~/.ssh/10xapply-server`). The author adds its public key to `deploy`'s `authorized_keys`, with a comment naming it.
- Being in the `docker` group makes it effectively root on the box, so it can reach both projects. The author accepts that knowingly _(user)_.
- **Rules in `CLAUDE.md`:**
  - **Allowed without asking:** reading 10xapply's and 10xjobs's container status and logs, and restarting or redeploying 10xapply's `api`.
  - **Only on the author's ask in that session:** any change to 10xjobs's containers, its Caddy (other than the deploy's validate and reload), the `edge` network, the firewall or the system.
  - **Never:** printing either app's secret values. That rules out reading a `.env`, `docker inspect` on a container, `docker compose config`, `printenv` or `env` inside a container, and `/proc/*/environ`. Health checks from inside a container pass the key by reference (as the compose healthcheck's `$$API_KEY` does), never by printing it.
- **Rules only, no guard rule** _(user)_. These rules live in `CLAUDE.md` and nothing enforces them. `guard.mjs` does not change in this slice.
- The private key never enters the repo, a log or a GitHub secret. Removing access means deleting one `authorized_keys` line.

### Repo layout

```
apps/api/                       NestJS app, Dockerfile, project.json
deploy/api/
  compose.yaml                  the api service, on the external edge network
  xapply.caddy.template         <hostname> -> xapply-api:3000
  .env.example                  names only (API_KEY)
  README.md                     runbook
.github/workflows/deploy-api.yml
.github/workflows/api-uptime.yml
```

**The runbook covers:**

- Order of first setup: the `edge` network and folders, then the 10xjobs PR deployed, then the `.env`, keys and GitHub secrets, then the first deploy.
- Day-to-day operation: reading logs, restarting, changing a secret, rolling back, and adding or removing a key.
- Moving to a real domain, and what to do if the shared Caddy refuses the site file.

### Docs updated in this slice

- `CLAUDE.md`:
  - "Separate from 10xjobs": servers are now shared.
  - "Webhooks": rewritten as above.
  - Stack: the API is set up.
  - Commands: `pnpm nx serve api` and `nx docker:build api`.
  - Guardrails: Claude's server-access rules.
- Roadmap:
  - Slice 11's "Spec answers": settled.
  - Slice 12's scope, locked decisions and spec answers: the per-user URL and pasted secret, idempotency on delivery id and (user, job), no held matches, no 10xjobs PR.
  - Slice 17's note on the resume reference.

## Testing

- **Unit tests (Vitest):**
  - The key guard: no header, a wrong key, a right key, and a key of a different length.
  - Environment validation: `API_KEY` missing or too short.
  - Health: 200 with the key, 401 without it, and the `no-store` header.
- **Offline checks in CI, cheap ones only:**
  - `docker compose -f deploy/api/compose.yaml config`, with dummy env and the external network declared.
  - `shellcheck` on any deploy script.
  - `caddy validate` on 10xjobs's Caddyfile plus the rendered site file, run in the pinned Caddy image.

## Done when

1. The 10xjobs PR is merged and deployed, and 10xjobs's health and webhooks still work.
2. A merge to `main` here runs CI, then `Database deploy`, then `Deploy API`, with no manual step. The server runs the image tagged with that commit's SHA.
3. `curl https://xapply.<ip>.sslip.io/api/health` with the key returns 200 with a valid certificate. Without the key it returns 401. 10xjobs's own hostname is unaffected.
4. From inside 10xjobs's API container, the same request with the key returns 200, which proves the hairpin path. Claude runs this one on the author's ask during the live checks, since it touches a 10xjobs container.
5. Stopping 10xapply's `api` makes only its hostname fail and 10xjobs keeps answering. That Caddy starts with 10xapply's site file present and its upstream down is proven with a throwaway Caddy container running the same config, not by restarting the live one _(my call)_.
6. A deliberately broken site file (tested once by hand, or in the CI validate step) is refused, and Caddy keeps serving both apps.
7. The uptime workflow fails, and the author gets the email, while the API is stopped. It passes again once the API is back.
8. Claude can SSH in with its own key and read `docker compose ps` and logs for both projects.
9. A `workflow_dispatch` with an earlier SHA rolls the API back.

## Left to the builder

- The exact Nx generator options and how closely `project.json` tracks 10xjobs's.
- How the deploy steps are split between the workflow and a script on the server.
- Healthcheck intervals, retry counts, the number of images kept and the uptime check's retries.
- How to render the site file (`envsubst` or `sed`), as long as the hostname is checked against a strict pattern first.
- The exact wording of the runbook and of the 10xjobs PR.
- Copying 10xjobs's deploy safeguards: the migrated-SHA check against `Database deploy`'s run name, never auto-deploying an older commit, separate GHCR logins for the two repos on the shared `deploy` user, staging the site file under a name the `*.caddy` glob skips, and a committed copy of 10xjobs's Caddyfile for CI's `caddy validate`.
