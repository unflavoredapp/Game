#!/usr/bin/env bash
# Unit tests for claim response parsing (no network, no buddy3).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mirror the worker's claim parsers so failures here mean the logic regressed.
claim_fields() {
  local json="$1"
  printf '%s' "$json" | jq -ec '
    if (.job | type) == "object" then
      {id:(.job.id // null), url:(.job.url // null)}
    else
      {id:(.id // null), url:(.url // null)}
    end
    | select((.id | type) == "string" and (.id | length) > 0
         and (.url | type) == "string" and (.url | length) > 0)
  ' 2>/dev/null
}

is_idle_claim() {
  local json="$1"
  if printf '%s' "$json" | jq -e 'has("job") and .job == null' >/dev/null 2>&1; then
    return 0
  fi
  if claim_fields "$json" >/dev/null; then
    return 1
  fi
  return 0
}

# Old buggy predicate from the packaged worker (for regression contrast).
buggy_is_null_job() {
  printf '%s' "$1" | jq -e '.job == null' >/dev/null 2>&1
}

pass=0
fail=0

assert_true() {
  local name="$1"
  shift
  if "$@"; then
    printf 'PASS %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n' "$name"
    fail=$((fail + 1))
  fi
}

assert_false() {
  local name="$1"
  shift
  if "$@"; then
    printf 'FAIL %s (expected false)\n' "$name"
    fail=$((fail + 1))
  else
    printf 'PASS %s\n' "$name"
    pass=$((pass + 1))
  fi
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    printf 'PASS %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL %s\n  got:  %s\n  want: %s\n' "$name" "$got" "$want"
    fail=$((fail + 1))
  fi
}

TOPLEVEL='{"id":"job-1","url":"https://apps.apple.com/us/app/x/id123456789"}'
NESTED='{"job":{"id":"job-2","url":"https://apps.apple.com/us/app/y/id987654321"}}'
IDLE='{"job":null}'
EMPTY='{}'
BAD='{"id":123,"url":"https://example"}'

# Regression: old predicate treated top-level claims as idle.
assert_true "buggy predicate misclassifies top-level claim as idle" \
  buggy_is_null_job "$TOPLEVEL"

# Fixed behavior
assert_false "top-level claim is not idle" is_idle_claim "$TOPLEVEL"
assert_false "nested claim is not idle" is_idle_claim "$NESTED"
assert_true "explicit job:null is idle" is_idle_claim "$IDLE"
assert_true "empty object is idle" is_idle_claim "$EMPTY"
assert_true "non-string id is idle/invalid" is_idle_claim "$BAD"

assert_eq "top-level id" \
  "$(claim_fields "$TOPLEVEL" | jq -r .id)" "job-1"
assert_eq "nested id" \
  "$(claim_fields "$NESTED" | jq -r .id)" "job-2"
assert_eq "top-level url" \
  "$(claim_fields "$TOPLEVEL" | jq -r .url)" \
  "https://apps.apple.com/us/app/x/id123456789"

# Ensure worker file still contains the fixed helpers (drift guard).
assert_true "worker defines claim_fields" \
  grep -q 'claim_fields()' "$ROOT/delvekbot-worker.sh"
assert_true "worker defines is_idle_claim" \
  grep -q 'is_idle_claim()' "$ROOT/delvekbot-worker.sh"
assert_false "worker no longer uses buggy .job == null alone" \
  grep -q "jq -e '\.job == null'" "$ROOT/delvekbot-worker.sh"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
