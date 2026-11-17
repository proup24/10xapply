# Hosted API runbook

10xapply's API runs on the server it shares with 10xjobs. It is its own Compose project, `xapply-api`, in `/home/deploy/xapply/`. 10xjobs's Caddy serves it: the deploy puts one site file, `xapply.caddy`, in the folder that Caddy imports, and reloads it.

This repo is public. Below, `<ip>`, `<hostname>` and `<host>` stand for the server's address, the API's hostname and the server's SSH host. Never write the real values into the repo. Until a real domain exists the hostname is `xapply.<ip-with-dashes>.sslip.io` (for example `xapply.203-0-113-10.sslip.io`).

## First setup

Do these in order. The order matters: 10xjobs's change must not deploy before step 1.

1. As `deploy` on the server: `docker network create edge`, then `mkdir -p /home/deploy/caddy-sites /home/deploy/xapply`.
2. Merge the 10xjobs PR (#82 in the 10xjobs repo) and let it deploy. Check that 10xjobs's health still passes. If step 1 was skipped, 10xjobs's `up` fails after its files are in place.
3. Create `/home/deploy/xapply/.env` with mode 600, from `deploy/api/.env.example`. Set `API_KEY` to at least 32 characters, no spaces: `openssl rand -hex 32`.
4. Create CI's deploy key on your own machine: `ssh-keygen -t ed25519 -N '' -C xapply-ci -f <path>`. Add its public half to `deploy`'s `~/.ssh/authorized_keys`. It is separate from 10xjobs's CI key.
5. Add Claude's public key (`~/.ssh/10xapply-server.pub`) to `authorized_keys` too, with a comment naming it.
6. In GitHub, add six secrets to the `prod` environment:
   - `XAPPLY_SSH_PRIVATE_KEY`: the private half of CI's key.
   - `XAPPLY_SSH_KNOWN_HOSTS`: the output of `ssh-keyscan <host>`.
   - `XAPPLY_SSH_HOST`: `<host>`.
   - `XAPPLY_SSH_USER`: `deploy`.
   - `XAPPLY_HOSTNAME`: `<hostname>`.
   - `XAPPLY_API_KEY`: the same value as `API_KEY` in the server's `.env`.
7. Trigger the first deploy with a merge to `main`, or run `Deploy API` from the Actions tab (it builds from `main`).

No new firewall rule is needed: 80 and 443 are already open for 10xjobs.

Until `XAPPLY_SSH_HOST` exists, `Deploy API` skips itself with a green notice, and `API uptime` does the same until `XAPPLY_HOSTNAME` exists. Merging before the secrets is safe.

The `prod` environment must not require reviewers. A required review would make every deploy, and every hourly uptime run, wait for approval.

## Day to day

Run these as `deploy`, in `/home/deploy/xapply`. Use `DOCKER_CONFIG=~/xapply/.docker` in front of any command that pulls from GHCR.

- **Status and logs:** `docker compose -p xapply-api --env-file image.env --env-file .env ps`, and `docker compose -p xapply-api --env-file image.env --env-file .env logs -f api`. Compose needs the two env files because `compose.yaml` requires `API_IMAGE_TAG`.
- **Restart:** `docker compose -p xapply-api --env-file image.env --env-file .env restart api`.
- **Change the key:** edit `.env`, run `docker compose -p xapply-api --env-file image.env --env-file .env up -d`, then update the `XAPPLY_API_KEY` secret to the same value. Until the secret matches, the deploy's health check and the hourly uptime check fail. Then update every caller that sends the key.
- **Roll back:** run `Deploy API` from the Actions tab with `image_tag` set to an earlier full 40-character commit SHA. It skips the build and redeploys that image with that commit's deploy files. A merge deploy never rolls the server back to an older commit by itself.
- **Add or remove an SSH key:** add or delete one line in `deploy`'s `~/.ssh/authorized_keys`. Deleting Claude's line removes its access.
- **Move to a real domain:** point a DNS record at the server, set the `XAPPLY_HOSTNAME` secret to the new name, then redeploy. The deploy renders and validates a new site file, and Caddy gets the certificate on its own. The site file holds one hostname, so the old name stops working.
- **If `install-site.sh` refuses the site file:** Caddy keeps its old config, and the script puts the previous site file back (or removes the new one if there was none). The public job log shows only a fixed line. Read the details in `~/xapply/install-site.log` on the server. Fix the cause and redeploy. A refused `XAPPLY_HOSTNAME` (`invalid hostname`) fails earlier, before anything reaches the server.
- **Uptime alert:** `API uptime` checks `/api/health` with the key every hour. GitHub emails a failed scheduled run to whoever last changed its cron line. GitHub pauses scheduled workflows after 60 days without repo activity: if the alerts stop, re-enable `API uptime` in the Actions tab.

10xjobs retries a failed webhook for about 21 hours and never resends what it missed, so fix an outage within a day.

## What is shared with 10xjobs

- **The `edge` network.** An external Docker network. 10xjobs's Caddy and 10xapply's `api` both join it. 10xapply's container has the alias `xapply-api`; Caddy reaches it as `xapply-api:3000`. It publishes no host port.
- **The sites folder.** `/home/deploy/caddy-sites`, mounted read-only at `/etc/caddy/sites` in 10xjobs's Caddy container (`xjobs-engine-caddy-1`). Caddy imports every `*.caddy` file there. 10xapply owns `xapply.caddy`. The deploy stages the new file as `.incoming-xapply`, which the glob skips, and keeps a `.backup-xapply`.
- **10xjobs's Caddy.** 10xapply's deploy only runs `caddy validate` and `caddy reload` in it. It never runs `up`, `pull` or `down` on 10xjobs's project.
- **The `deploy` user.** Each repo uses its own Docker login directory, so neither clears the other's GHCR login: 10xapply's is `~/xapply/.docker`.

10xjobs's own README (section 18, "Other sites on this server") describes the same setup from its side.

Order for changing any of it:

1. Changing the `edge` network name or the sites folder: change 10xjobs's compose first, with the network and folder in place on the server, then change 10xapply's compose and redeploy.
2. A bad site file cannot break 10xjobs: the deploy validates the full Caddy config with it before moving it in place. A 10xjobs deploy runs `caddy reload` too, which re-reads every site file.
3. If 10xapply's container is down, Caddy still starts. Only the 10xapply hostname answers 502.
