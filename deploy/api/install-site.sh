#!/usr/bin/env bash
# Installs 10xapply's Caddy site file into 10xjobs's shared Caddy, on the server.
# Runs as `deploy` from ~/xapply, after the deploy has staged the new file as
# /home/deploy/caddy-sites/.incoming-xapply (the `*.caddy` import skips it).
#
# 1. Back up the current xapply.caddy, if there is one.
# 2. Put the staged file in place and validate Caddy's full config; on failure
#    restore the backup (or remove the file if there was none) and exit 1.
# 3. Reload Caddy; on failure restore, reload again and exit 1.
#
# Files are written with `cat >`, not `mv`, mirroring 10xjobs. It never prints
# a site file or Caddy's own output: this runs inside public CI logs.
set -euo pipefail

SITES=/home/deploy/caddy-sites
INCOMING="$SITES/.incoming-xapply"
TARGET="$SITES/xapply.caddy"
BACKUP="$SITES/.backup-xapply"
CADDY=xjobs-engine-caddy-1
CONFIG=/etc/caddy/Caddyfile

caddy_cmd() {
  docker exec "$CADDY" caddy "$1" --config "$CONFIG" >/dev/null 2>&1
}

restore() {
  if [[ $had_backup -eq 1 ]]; then
    cat "$BACKUP" >"$TARGET"
    echo 'install-site: restored the previous site file'
  else
    rm -f "$TARGET"
    echo 'install-site: removed the new site file (there was none before)'
  fi
}

if [[ ! -f $INCOMING ]]; then
  echo 'install-site: no staged site file' >&2
  exit 1
fi

had_backup=0
if [[ -f $TARGET ]]; then
  cat "$TARGET" >"$BACKUP"
  had_backup=1
fi

cat "$INCOMING" >"$TARGET"

if ! caddy_cmd validate; then
  echo 'install-site: caddy validate failed' >&2
  restore
  exit 1
fi

if ! caddy_cmd reload; then
  echo 'install-site: caddy reload failed' >&2
  restore
  if caddy_cmd reload; then
    echo 'install-site: reloaded the restored config'
  else
    echo 'install-site: reload of the restored config also failed' >&2
  fi
  exit 1
fi

rm -f "$INCOMING" "$BACKUP"
echo 'install-site: ok'
