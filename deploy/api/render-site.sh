#!/usr/bin/env bash
# Prints 10xapply's Caddy site file for <hostname> to stdout.
# Usage: render-site.sh <hostname>
# Exits 2 with "invalid hostname" unless the argument is an sslip.io name
# (xapply.<a>-<b>-<c>-<d>.sslip.io) or a plain lower-case domain. It never
# echoes the argument, on stdout or stderr.
set -euo pipefail
export LC_ALL=C

SSLIP='^xapply\.[0-9]{1,3}(-[0-9]{1,3}){3}\.sslip\.io$'
DOMAIN='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'

refuse() {
  echo 'invalid hostname' >&2
  exit 2
}

[[ $# -eq 1 ]] || refuse
host=$1
# Bash's =~ is POSIX ERE without REG_NEWLINE: `$` matches only at the very
# end, so a trailing newline is refused.
[[ $host =~ $SSLIP || $host =~ $DOMAIN ]] || refuse

template="$(dirname "${BASH_SOURCE[0]}")/xapply.caddy.template"
while IFS= read -r line || [[ -n $line ]]; do
  printf '%s\n' "${line//__HOSTNAME__/$host}"
done <"$template"
