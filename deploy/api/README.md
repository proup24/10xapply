# Hosted API runbook

10xapply's API runs on the server it shares with 10xjobs. It is its own Compose project, `xapply-api`, in `/home/deploy/xapply/`. 10xjobs's Caddy serves it: the deploy puts one site file, `xapply.caddy`, in the folder that Caddy imports, and reloads it.

This repo is public. Below, `<ip>`, `<hostname>` and `<host>` stand for the server's address, the API's hostname and the server's SSH host. Never write the real values into the repo. Until a real domain exists the hostname is `xapply.<ip-with-dashes>.sslip.io` (for example `xapply.203-0-113-10.sslip.io`).

## First setup

Do these in order. The order matters: 10xjobs's change must not deploy before step 1.

1. As `deploy` on the server: `docker network create edge`, then `mkdir -p /home/deploy/caddy-sites /home/deploy/xapply`.
2. Merge the 10xjobs PR (#82 in the 10xjobs repo) and let it deploy. Check that 10xjobs's health still passes. If step 1 was skipped, 10xjobs's `up` fails after its files are in place.
3. Create `/home/deploy/xapply/.env` with mode 600, from `deploy/api/.env.example`. Set `API_KEY` to at least 32 characters, no spaces: `openssl rand -hex 32`. Set `DATABASE_URL` too: the session pooler URL, port 5432, written by the author. It must be in place before the webhook intake PR (slice 12) merges, or the deploy's health check fails with 503 (`database-unreachable`).
4. Create CI's deploy key on your own machine: `ssh-keygen -t ed25519 -N '' -C xapply-ci -f <path>`. Add its public half to `deploy`'s `~/.ssh/authorized_keys`. It is separate from 10xjobs's CI key.
5. Add Claude's public key (`~/.ssh/10xapply-server.pub`) to `authorized_keys` too, with a comment naming it.
6. In GitHub → Settings → Environments → `prod`, set deployment branches to `main` only, before adding any secret. CI's SSH key is effectively root on the shared server (the `deploy` user runs Docker), so only workflows running from `main` may read it.
7. In GitHub, add six secrets to the `prod` environment:
   - `XAPPLY_SSH_PRIVATE_KEY`: the private half of CI's key.
   - `XAPPLY_SSH_KNOWN_HOSTS`: the output of `ssh-keyscan <host>`.
   - `XAPPLY_SSH_HOST`: `<host>`.
   - `XAPPLY_SSH_USER`: `deploy`.
   - `XAPPLY_HOSTNAME`: `<hostname>`.
   - `XAPPLY_API_KEY`: the same value as `API_KEY` in the server's `.env`.
8. Trigger the first deploy with a merge to `main`, or run `Deploy API` from the Actions tab (it builds from `main`).

No new firewall rule is needed: 80 and 443 are already open for 10xjobs.

Until `XAPPLY_SSH_HOST` exists, `Deploy API` skips itself with a green notice, and `API uptime` does the same until `XAPPLY_HOSTNAME` exists. Merging before the secrets is safe.

The `prod` environment must not require reviewers. A required review would make every deploy, and every hourly uptime run, wait for approval.

## Day to day

Run these as `deploy`, in `/home/deploy/xapply`. Use `DOCKER_CONFIG=~/xapply/.docker` in front of any command that pulls from GHCR.

- **Status and logs:** `docker compose -p xapply-api --env-file image.env --env-file .env ps`, and `docker compose -p xapply-api --env-file image.env --env-file .env logs -f xapply-api`. Compose needs the two env files because `compose.yaml` requires `API_IMAGE_TAG`.
- **Restart:** `docker compose -p xapply-api --env-file image.env --env-file .env restart xapply-api`.
- **Change the key:** edit `.env`, run `docker compose -p xapply-api --env-file image.env --env-file .env up -d`, then update the `XAPPLY_API_KEY` secret to the same value. Until the secret matches, the deploy's health check and the hourly uptime check fail. Then update every caller that sends the key.
- **Roll back:** run `Deploy API` from the Actions tab with `image_tag` set to an earlier full 40-character commit SHA. It skips the build and redeploys that image with that commit's deploy files. Run the dispatch from `main` (the default branch in the Run workflow menu): `prod` only allows `main`, so a dispatch from any other branch fails. A merge deploy never rolls the server back to an older commit by itself.
- **Add or remove an SSH key:** add or delete one line in `deploy`'s `~/.ssh/authorized_keys`. Deleting Claude's line removes its access.
- **Move to a real domain:** point a DNS record at the server, set the `XAPPLY_HOSTNAME` secret to the new name, then redeploy. The deploy renders and validates a new site file, and Caddy gets the certificate on its own. The site file holds one hostname, so the old name stops working.
- **If `install-site.sh` refuses the site file:** it validates the staged file in a temp copy of Caddy's config before anything in the sites folder changes, so a refused file is never installed and Caddy keeps its old config. If the reload fails after the file is in place, the script puts the previous site file back (or removes the new one if there was none) and reloads again. The public job log shows only a fixed line. Read the details in `~/xapply/install-site.log` on the server. Fix the cause and redeploy. A refused `XAPPLY_HOSTNAME` (`invalid hostname`) fails earlier, before anything reaches the server.
- **Uptime alert:** `API uptime` checks `/api/health` with the key every hour. GitHub emails a failed scheduled run to whoever last changed its cron line. GitHub pauses scheduled workflows after 60 days without repo activity: if the alerts stop, re-enable `API uptime` in the Actions tab.

10xjobs retries a failed webhook for about 21 hours and never resends what it missed, so fix an outage within a day.

## Intake link

`POST /api/intake/<token>` receives 10xjobs's match webhook. The token's SHA-256 hex is looked up in `intake_links`, which gives the user and the 10xjobs secret. Any failure (unknown token, bad or old signature or timestamp) answers 401. There is no web app for links yet, so the author's link is set up by hand. Never write the URL, token or secret into the repo, a log or a file.

1. Invite the author from the Supabase dashboard (Auth, Users, Invite). The `on_auth_user_created` trigger creates their `users` row. Accepting the invite is not needed for intake.
2. Claude generates a token locally: 32 random bytes, base64url. It computes the token's SHA-256 hex and gives the author the URL `https://xapply.<ip-with-dashes>.sslip.io/api/intake/<token>`.
3. The author pastes the URL into 10xjobs's Webhook page, turns the webhook on, and gives Claude the secret.
4. Claude inserts the `intake_links` row with `execute_sql`: the user id, the token hash and the secret.
5. The author presses "Send test" on 10xjobs's Webhook page. Claude reads the `webhook_deliveries` row, which has outcome `test`.

Check what arrived:

```sql
select outcome, "createdAt" from webhook_deliveries order by "createdAt" desc limit 5
```

**Rotate.** A new token means a new hash in the row and the new URL in 10xjobs. A new secret is regenerated in 10xjobs and updated in the row. The intake stops accepting the old value as soon as the row changes.

## What is shared with 10xjobs

- **The `edge` network.** An external Docker network. 10xjobs's Caddy and 10xapply's `xapply-api` service both join it; Caddy reaches it as `xapply-api:3000`. It publishes no host port. No service on `edge` may share a name or alias with a 10xjobs service, because Compose adds each service name as a DNS name on every network it joins: 10xapply's are all `xapply-*` (checked by `scripts/deploy-api-check.sh`), and 10xjobs's Caddy proxies `xjobs-api`.
- **The sites folder.** `/home/deploy/caddy-sites`, mounted read-only at `/etc/caddy/sites` in 10xjobs's Caddy container (`xjobs-engine-caddy-1`). Caddy imports every `*.caddy` file there. 10xapply owns `xapply.caddy`. The deploy stages the new file as `.incoming-xapply`, which the glob skips, and keeps a `.backup-xapply`.
- **10xjobs's Caddy.** 10xapply's deploy only runs `caddy validate` and `caddy reload` in it. It never runs `up`, `pull` or `down` on 10xjobs's project.
- **The `deploy` user.** Each repo uses its own Docker login directory, so neither clears the other's GHCR login: 10xapply's is `~/xapply/.docker`.

10xjobs's own README (section 18, "Other sites on this server") describes the same setup from its side.

Order for changing any of it:

1. Changing the `edge` network name or the sites folder: change 10xjobs's compose first, with the network and folder in place on the server, then change 10xapply's compose and redeploy.
2. A bad site file is refused before it is installed: `install-site.sh` validates the full Caddy config with it, in a temp folder inside the Caddy container, before moving it in place. A 10xjobs deploy runs `caddy reload` too, which re-reads every site file.
3. If 10xapply's container is down, Caddy still starts. Only the 10xapply hostname answers 502.
