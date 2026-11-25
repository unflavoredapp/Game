#!/usr/bin/env bash
# Switch the active App Store account to the Apple ID for a country code.
# Intended to run on the jailbroken phone before appstoredl / appstorectl install.
# Always re-execs under sudo on iPhone (appstorectl needs root).
#
# Usage: switch-storefront.sh <country>
# Example: switch-storefront.sh in
set -Eeuo pipefail

if [[ "$(id -u 2>/dev/null || echo 1)" -ne 0 && "${DELVEKBOT_NO_SUDO:-0}" != "1" ]]; then
  command -v sudo >/dev/null 2>&1 || {
    echo "DELvEKBot: need sudo (or run as root)" >&2
    exit 1
  }
  echo "DELvEKBot: re-executing under sudo -E" >&2
  exec sudo -E -- "$0" "$@"
fi

COUNTRY="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z')"
[[ "${#COUNTRY}" -eq 2 ]] || {
  echo "usage: $0 <country-code>   e.g. $0 in" >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNTS="${DELVEKBOT_ACCOUNTS:-$ROOT/accounts.json}"

[[ -f "$ACCOUNTS" ]] || {
  echo "missing accounts.json at $ACCOUNTS" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || { echo "missing jq" >&2; exit 1; }
command -v appstorectl >/dev/null 2>&1 || {
  echo "missing appstorectl — install https://github.com/appknox/appstorectl" >&2
  exit 1
}

apple_id="$(jq -r --arg c "$COUNTRY" '.[$c].appleId // empty' "$ACCOUNTS")"
rel_pass="$(jq -r --arg c "$COUNTRY" '.[$c].passwordFile // empty' "$ACCOUNTS")"
[[ -n "$apple_id" ]] || {
  echo "no Apple ID mapped for country=$COUNTRY in $ACCOUNTS" >&2
  exit 1
}

if [[ -n "$rel_pass" ]]; then
  if [[ "$rel_pass" = /* ]]; then
    pass_file="$rel_pass"
  else
    pass_file="$ROOT/$rel_pass"
  fi
else
  pass_file=""
fi

echo "DELvEKBot: switching App Store → ${COUNTRY} (${apple_id})"

# Prefer non-interactive reuse of an already-trusted device session.
set +e
if [[ -n "$pass_file" && -s "$pass_file" ]]; then
  appstorectl login "$apple_id" --password-file "$pass_file" --no-bootstrap
  rc=$?
else
  appstorectl login "$apple_id" --no-bootstrap
  rc=$?
fi
set -e

if [[ "$rc" -ne 0 ]]; then
  echo "DELvEKBot: ERROR: could not activate ${apple_id} for ${COUNTRY}." >&2
  echo "Run bootstrap-accounts.sh once on this phone to login + complete 2FA." >&2
  exit "$rc"
fi

if command -v authpref >/dev/null 2>&1; then
  authpref free never 2>/dev/null || true
fi

echo "DELvEKBot: active storefront account ready for ${COUNTRY}"
