#!/usr/bin/env bash
# Installs 10xapply's Caddy site file into 10xjobs's shared Caddy, on the server.
# Runs as `deploy` from ~/xapply, after the deploy has staged the new file as
# /home/deploy/caddy-sites/.incoming-xapply (the `*.caddy` import skips it).
#
# 1. Validate first, without touching the live sites folder: inside the Caddy
#    container, copy every other site file and the staged one into a temp
#    folder, point a temp copy of the Caddyfile's sites import at it, and run
#    `caddy validate` on that. A refused file never reaches the sites folder.
# 2. Only then back up the current xapply.caddy (if any), write the staged file
#    in its place and reload Caddy. On a failed write, restore the backup (or
#    remove the new file if there was none) and exit 1; on a failed reload,
#    restore, reload again and exit 1.
#
# Files are written with `cat >`, not `mv`, mirroring 10xjobs. It never prints
# a site file or Caddy's own output: this runs inside public CI logs, and a
# Caddy error can name 10xjobs's hostname. Caddy's output is appended to the
# log (mode 600) on the server instead.
#
# The environment overrides below exist for scripts/deploy-api-check.sh only;
# the defaults are the production values.
set -euo pipefail

CADDY="${CADDY_CONTAINER:-xjobs-engine-caddy-1}"
SITES="${CADDY_SITES_DIR:-/home/deploy/caddy-sites}"
LOG="${INSTALL_SITE_LOG:-$HOME/xapply/install-site.log}"
INCOMING="$SITES/.incoming-xapply"
TARGET="$SITES/xapply.caddy"
BACKUP="$SITES/.backup-xapply"
CONFIG=/etc/caddy/Caddyfile

if [[ ! -e $LOG ]]; then
  (umask 077 && : >"$LOG")
fi
chmod 600 "$LOG"
printf '== %s install-site\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG"

log_hint() {
  echo 'install-site: Caddy output is in the install-site log on the server (~/xapply/install-site.log)' >&2
}

# Runs inside the Caddy container, with the staged file on stdin. The import
# line must appear exactly once, or the temp config would not test the file.
# shellcheck disable=SC2016  # expanded by the container's shell, not here
VALIDATE_SCRIPT='
set -eu
line="import /etc/caddy/sites/*.caddy"
tmp="$(mktemp -d /tmp/xapply-validate.XXXXXX)"
trap "rm -rf \"$tmp\"" EXIT
mkdir "$tmp/sites"
for f in /etc/caddy/sites/*.caddy; do
  [ -f "$f" ] || continue
  [ "$(basename "$f")" = xapply.caddy ] && continue
  cp "$f" "$tmp/sites/"
done
cat >"$tmp/sites/xapply.caddy"
n="$(grep -cxF "$line" "$1" || true)"
if [ "$n" != 1 ]; then
  echo "the sites import line appears $n times in $1, expected once"
  exit 1
fi
awk -v line="$line" -v repl="import $tmp/sites/*.caddy" \
  "\$0 == line { print repl; next } { print }" "$1" >"$tmp/Caddyfile"
caddy validate --config "$tmp/Caddyfile" --adapter caddyfile
'

validate_staged() {
  printf -- '-- caddy validate (staged file, temp config)\n' >>"$LOG"
  docker exec -i "$CADDY" sh -c "$VALIDATE_SCRIPT" sh "$CONFIG" <"$INCOMING" >>"$LOG" 2>&1
}

reload() {
  printf -- '-- caddy reload\n' >>"$LOG"
  docker exec "$CADDY" caddy reload --config "$CONFIG" >>"$LOG" 2>&1
}

restore() {
  if [[ $had_backup -eq 1 ]]; then
    if cat "$BACKUP" >"$TARGET"; then
      echo 'install-site: restored the previous site file'
    else
      echo 'install-site: could not restore the previous site file' >&2
    fi
  else
    if rm -f "$TARGET"; then
      echo 'install-site: removed the new site file (there was none before)'
    else
      echo 'install-site: could not remove the new site file' >&2
    fi
  fi
}

restore_and_reload() {
  restore
  if reload; then
    echo 'install-site: reloaded the restored config'
  else
    echo 'install-site: reload of the restored config also failed' >&2
  fi
}

if [[ ! -f $INCOMING ]]; then
  echo 'install-site: no staged site file' >&2
  exit 1
fi

if ! validate_staged; then
  echo 'install-site: caddy validate refused the staged site file; nothing was installed' >&2
  log_hint
  exit 1
fi

had_backup=0
if [[ -f $TARGET ]]; then
  cat "$TARGET" >"$BACKUP"
  had_backup=1
fi

# A partial write must never stay in place.
if ! cat "$INCOMING" >"$TARGET"; then
  echo 'install-site: could not write the site file' >&2
  restore
  exit 1
fi

if ! reload; then
  echo 'install-site: caddy reload failed' >&2
  log_hint
  restore_and_reload
  exit 1
fi

rm -f "$INCOMING" "$BACKUP"
echo 'install-site: ok'
