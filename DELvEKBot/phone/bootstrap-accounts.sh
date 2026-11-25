#!/usr/bin/env bash
# One-time interactive login for every Apple ID in accounts.json.
# Complete 2FA when prompted. After this, switch-storefront.sh can reuse
# sessions with --no-bootstrap (no Face ID / 2FA on each job).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNTS="${DELVEKBOT_ACCOUNTS:-$ROOT/accounts.json}"
PASS_DIR="${DELVEKBOT_PASS_DIR:-$ROOT/passwords}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need jq

if ! command -v appstorectl >/dev/null 2>&1; then
  echo "Install appstorectl (on-device App Store CLI) first:" >&2
  echo "  https://github.com/appknox/appstorectl" >&2
  exit 1
fi

[[ -f "$ACCOUNTS" ]] || {
  echo "Copy accounts.example.json to accounts.json and fill Apple IDs." >&2
  echo "Expected: $ACCOUNTS" >&2
  exit 1
}

mkdir -p "$PASS_DIR"
chmod 700 "$PASS_DIR"

echo "Accounts file: $ACCOUNTS"
echo "Password dir:  $PASS_DIR"
echo

jq -r 'keys[]' "$ACCOUNTS" | while read -r country; do
  [[ -n "$country" ]] || continue
  apple_id="$(jq -r --arg c "$country" '.[$c].appleId // empty' "$ACCOUNTS")"
  rel_pass="$(jq -r --arg c "$country" '.[$c].passwordFile // empty' "$ACCOUNTS")"
  [[ -n "$apple_id" && -n "$rel_pass" ]] || {
    echo "skip $country · missing appleId/passwordFile"
    continue
  }

  if [[ "$rel_pass" = /* ]]; then
    pass_file="$rel_pass"
  else
    pass_file="$ROOT/$rel_pass"
  fi
  mkdir -p "$(dirname "$pass_file")"

  echo "=== storefront ${country} · ${apple_id} ==="
  if [[ ! -s "$pass_file" ]]; then
    printf 'Password for %s (stored only on this phone, mode 600): ' "$apple_id"
    # shellcheck disable=SC2162
    read -s password
    echo
    printf '%s' "$password" >"$pass_file"
    unset password
  fi
  chmod 600 "$pass_file"

  echo "Logging in (complete 2FA on device if asked)…"
  appstorectl login "$apple_id" --password-file "$pass_file" || {
    echo "login failed for $apple_id" >&2
    continue
  }

  # Prefer no password/Face ID prompts for free downloads when supported.
  if command -v authpref >/dev/null 2>&1; then
    authpref free never 2>/dev/null || true
  fi
  echo "OK · ${country}"
  echo
done

echo "Done. List sessions:"
appstorectl accounts || true
echo
echo "Jobs can now call: bash $ROOT/switch-storefront.sh <country>"
