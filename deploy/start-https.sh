#!/bin/sh
set -eu

if [ "${PHOENIX_PUBLIC_IP:-}" = auto ]; then
  PHOENIX_PUBLIC_IP=$(wget -q -T 10 -O - https://api.ipify.org) || {
    echo 'Public IP discovery failed. Set PHOENIX_PUBLIC_IP explicitly.' >&2
    exit 1
  }
fi
printf '%s\n' "${PHOENIX_PUBLIC_IP:-}" | awk -F. '
  NF != 4 { exit 1 }
  { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || length($i) > 3 || $i > 255) exit 1 }
' || { echo 'Set a valid PHOENIX_PUBLIC_IP.' >&2; exit 1; }
export PHOENIX_PUBLIC_IP
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
