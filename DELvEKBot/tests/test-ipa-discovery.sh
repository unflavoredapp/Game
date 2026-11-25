#!/usr/bin/env bash
# Regression tests for buddy3 IPA name matching + discovery.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/delvekbot-ipa-test.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# Load helpers by extracting the discovery block into a sourced snippet.
HELPERS="$WORKDIR/helpers.sh"
awk '
  /^ipa_name_matches_bid\(\)/ {keep=1}
  /^upload_ipa\(\)/ {keep=0}
  keep {print}
' "$ROOT/delvekbot-worker.sh" > "$HELPERS"

DOCS="$WORKDIR/docs"
mkdir -p "$DOCS"
log() { :; }  # stub worker logger for sourced helpers
# shellcheck disable=SC1090
source "$HELPERS"

pass=0
fail=0
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (got='$got' want='$want')"
    fail=$((fail + 1))
  fi
}

assert_true() {
  local label="$1"
  shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    fail=$((fail + 1))
  fi
}

assert_false() {
  local label="$1"
  shift
  if "$@"; then
    echo "FAIL  $label (expected false)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

bid="com.audiomack.iphone"

assert_true "matches bundleid.ipa" \
  ipa_name_matches_bid "$bid" "com.audiomack.iphone.ipa"
assert_true "matches bundleid_decrypted.ipa" \
  ipa_name_matches_bid "$bid" "com.audiomack.iphone_decrypted.ipa"
assert_true "matches bundleid-suffix.ipa" \
  ipa_name_matches_bid "$bid" "com.audiomack.iphone-1.ipa"
assert_false "rejects AppName_decrypted.ipa" \
  ipa_name_matches_bid "$bid" "Audiomack_decrypted.ipa"
assert_false "rejects other bundle" \
  ipa_name_matches_bid "$bid" "ai.x.GrokApp.ipa"

# Simulate buddy3 writing bundleid.ipa with an OLD mtime (preserved package time).
target="$DOCS/${bid}.ipa"
printf 'fake-ipa-bytes' > "$target"
# Force mtime to yesterday so a pure freshness check would reject it.
touch -t 202001010101 "$target" 2>/dev/null || touch -d '2020-01-01 01:01:01' "$target"

snap="$WORKDIR/snap.txt"
: > "$snap"   # empty snapshot = file did not exist before buddy3
started_epoch="$(( $(date +%s) - 1 ))"

got="$(find_fresh_buddy_ipa "$bid" "$snap" "$started_epoch")"
assert_eq "discovers new bundleid.ipa despite old mtime" "$got" "$target"

# Size-unchanged stale file alone should still be returned as last resort.
snap2="$WORKDIR/snap2.txt"
printf '%s\t%s\n' "$target" "$(file_size_bytes "$target")" > "$snap2"
got2="$(find_fresh_buddy_ipa "$bid" "$snap2" "$started_epoch")"
assert_eq "falls back to newest match when size unchanged" "$got2" "$target"

# Size change should win.
printf 'fake-ipa-bytes-CHANGED' > "$target"
touch -t 202001010101 "$target" 2>/dev/null || touch -d '2020-01-01 01:01:01' "$target"
got3="$(find_fresh_buddy_ipa "$bid" "$snap2" "$started_epoch")"
assert_eq "prefers size-changed IPA" "$got3" "$target"

echo
echo "Results: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
