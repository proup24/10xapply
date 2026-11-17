#!/usr/bin/env bash
# Offline checks for the API's deploy files (deploy/api/). Each prints one `ok:` line.
# Needs Docker. Uses shellcheck from PATH, else its pinned image.
# Never touches the server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CADDY_IMAGE=caddy:2.11.6-alpine
SHELLCHECK_IMAGE=koalaman/shellcheck:v0.10.0
EXAMPLE_HOST=xapply.203-0-113-10.sslip.io
ENGINE_HOST=api.203-0-113-10.sslip.io

work="$(mktemp -d)"
throwaway="xapply-caddy-check-$$-$RANDOM"
cleanup() {
  docker rm -f "$throwaway" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# 1. shellcheck
scripts=(deploy/api/*.sh scripts/deploy-api-check.sh)
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${scripts[@]}"
else
  docker run --rm -v "$ROOT:/mnt" -w /mnt "$SHELLCHECK_IMAGE" "${scripts[@]}"
fi
echo 'ok: shellcheck'

# 2. compose config, in a temp folder with an empty .env and the edge network
mkdir "$work/compose"
cp deploy/api/compose.yaml "$work/compose/compose.yaml"
: >"$work/compose/.env"
docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null
(cd "$work/compose" && API_IMAGE_TAG=x docker compose -f compose.yaml config -q)
echo 'ok: compose config'

# 3. the rendered site file validates inside the vendored 10xjobs Caddyfile
mkdir "$work/sites"
deploy/api/render-site.sh "$EXAMPLE_HOST" >"$work/sites/xapply.caddy"
# caddy_on <sites folder> <docker run options...> -- <caddy args...>
caddy_on() {
  local sites=$1 opts=()
  shift
  while [[ $1 != -- ]]; do
    opts+=("$1")
    shift
  done
  shift
  docker run "${opts[@]}" \
    -e "ENGINE_HOSTNAME=$ENGINE_HOST" \
    -v "$ROOT/deploy/api/vendor/10xjobs.Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$sites:/etc/caddy/sites:ro" \
    "$CADDY_IMAGE" caddy "$@"
}
validate_log="$work/validate.log"
if ! caddy_on "$work/sites" --rm -- validate --config /etc/caddy/Caddyfile >"$validate_log" 2>&1; then
  tail -n 20 "$validate_log" >&2
  echo 'FAIL: caddy validate of the rendered site file' >&2
  exit 1
fi
echo 'ok: caddy validate with the rendered site file'

# 4. Caddy keeps running even though xapply-api does not resolve
caddy_on "$work/sites" -d --name "$throwaway" -- run --config /etc/caddy/Caddyfile >/dev/null
sleep 5
if [[ "$(docker inspect -f '{{.State.Running}}' "$throwaway" 2>/dev/null)" != true ]]; then
  echo 'FAIL: caddy stopped without xapply-api' >&2
  exit 1
fi
docker rm -f "$throwaway" >/dev/null
echo 'ok: caddy runs without xapply-api'

# 5. a broken site file makes caddy validate fail
mkdir "$work/broken"
printf '__HOSTNAME__ {\n' >"$work/broken/xapply.caddy"
if caddy_on "$work/broken" --rm -- validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo 'FAIL: caddy validate accepted a broken site file' >&2
  exit 1
fi
echo 'ok: caddy validate refuses a broken site file'
