#!/usr/bin/env bash
# DELvEKBot · on-device Dopamine/buddy3 worker
#
# A phone-side worker for jobs queued by your DELvEKBot/Tetherless-compatible
# server. This script does not implement the server queue or Telegram bot.
#
# Required tools: bash, curl, jq, flock, sed, date, find, stat
#
# Configure:
#   export DECRYPT_SITE_URL=https://your-server.example/
#   export DECRYPT_WORKER_TOKEN='...'
#   export BUDDY3_BIN=/var/mobile/Documents/buddy3
#   export BUDDY3_OUT_DIR=/var/mobile/Documents
#   bash delvekbot-worker.sh
#
# Or copy .env.example to .env next to this script (auto-loaded).
#
# Optional:
#   DELVEKBOT_ADID=iphone-worker-01
#   POLL_SECONDS=3
#   HEARTBEAT_SECONDS=30
#   COUNTRY=us
#   BUDDY3_VERBOSE=1
#   CURL_CONNECT_TIMEOUT=15
#   CURL_MAX_TIME=60
#   UPLOAD_MAX_TIME=1800
#
# Notes:
# - jq is required for reliable JSON parsing.
# - The worker uses the existing /progress endpoint for heartbeat messages.
#   The server must extend the job lease on progress calls if you want those
#   calls to act as lease heartbeats. See README.md.
# - Output freshness is checked against the time immediately before buddy3
#   starts, preventing accidental upload of a stale IPA from an earlier job.

set -Eeuo pipefail
umask 077

# Optional local env file (never commit real tokens).
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${_SCRIPT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${_SCRIPT_DIR}/.env"
  set +a
fi

SITE_URL="${DECRYPT_SITE_URL:-${MAC_PUBLIC_BASE:-}}"
TOKEN="${DECRYPT_WORKER_TOKEN:-}"
BUDDY3_BIN="${BUDDY3_BIN:-/var/mobile/Documents/buddy3}"
DOCS="${BUDDY3_OUT_DIR:-/var/mobile/Documents}"
POLL_SECONDS="${POLL_SECONDS:-3}"
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-30}"
COUNTRY="${COUNTRY:-us}"
ADID="${DELVEKBOT_ADID:-${DECRYPT_WORKER_ADID:-delvekbot-dopamine}}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-15}"
CURL_MAX_TIME="${CURL_MAX_TIME:-60}"
UPLOAD_MAX_TIME="${UPLOAD_MAX_TIME:-1800}"
LOCK_FILE="${DELVEKBOT_LOCK_FILE:-${DOCS}/.delvekbot-worker.lock}"

BASE=""
CURRENT_JOB_ID=""
HEARTBEAT_PID=""

log() { printf 'DELvEKBot: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

normalize_base() {
  local u="${1%/}"
  [[ -n "$u" ]] || return 1
  case "$u" in
    http://*|https://*) ;;
    *) u="https://$u" ;;
  esac
  printf '%s/' "$u"
}

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$CURL_MAX_TIME" \
    -X "$method" \
    -H "X-Decrypt-Worker-Token: ${TOKEN}" \
    -H "X-AS-ADID: ${ADID}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "$@" \
    "${BASE}${path}"
}

json_string() {
  # Read a top-level JSON string property. jq handles escaped characters.
  local json="$1" key="$2"
  printf '%s' "$json" | jq -er --arg k "$key" \
    '.[$k] | select(type == "string")' 2>/dev/null
}

# Claim shapes supported:
#   idle:   { "job": null }
#   active: { "id": "...", "url": "..." }
#   active: { "job": { "id": "...", "url": "..." } }
#
# Critical: a missing .job key must NOT be treated as idle when top-level
# id/url are present. In jq, (.missing == null) is true.
claim_fields() {
  local json="$1"
  # Use -e so a filtered-out / empty result is a non-zero status.
  # Prefer null over jq's empty generator (empty makes {} construct nothing
  # and still exit 0, which falsely looked like a successful claim).
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
  # Explicit idle marker, or no extractable job fields.
  if printf '%s' "$json" | jq -e 'has("job") and .job == null' >/dev/null 2>&1; then
    return 0
  fi
  if claim_fields "$json" >/dev/null; then
    return 1
  fi
  return 0
}

progress() {
  local id="$1" msg="$2"
  # Progress is intentionally best-effort; a transient update failure should
  # not kill a running decrypt. Server-side lease extension is server behavior.
  local payload
  payload="$(jq -cn --arg id "$id" --arg msg "$msg" '{id:$id,msg:$msg}')"
  api POST "api/decrypt/worker/progress" -d "$payload" >/dev/null || true
}

fail_job() {
  local id="$1" err="$2"
  local payload
  payload="$(jq -cn --arg id "$id" --arg error "$err" '{id:$id,error:$error}')"
  api POST "api/decrypt/worker/fail" -d "$payload" >/dev/null || true
}

heartbeat_loop() {
  local id="$1"
  while sleep "$HEARTBEAT_SECONDS"; do
    progress "$id" "DELvEKBot · worker active; decryption still running"
  done
}

stop_heartbeat() {
  if [[ -n "${HEARTBEAT_PID}" ]]; then
    kill "$HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$HEARTBEAT_PID" >/dev/null 2>&1 || true
    HEARTBEAT_PID=""
  fi
}

start_heartbeat() {
  local id="$1"
  stop_heartbeat
  heartbeat_loop "$id" &
  HEARTBEAT_PID=$!
}

urlencode() {
  # Encode one UTF-8 string as a query component using jq's URI encoder.
  jq -rn --arg v "$1" '$v|@uri'
}

itunes_lookup() {
  local store_url="$1" app_id body
  app_id="$(printf '%s' "$store_url" | sed -nE 's/.*\/id([0-9]{5,12})([^0-9].*)?$/\1/p' | head -1)"
  [[ -n "$app_id" ]] || return 1

  body="$(curl -fsSL \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time 30 \
    "https://itunes.apple.com/lookup?id=${app_id}&country=${COUNTRY}" 2>/dev/null)" || return 1

  local result
  result="$(printf '%s' "$body" | jq -er \
    '.results[0] | select(.bundleId and .trackName) | [.bundleId,.trackName] | @tsv' 2>/dev/null)" || return 1
  printf '%s\n' "$result"
}

find_fresh_buddy_ipa() {
  local bid="$1" started_epoch="$2"
  local candidate
  local -a candidates=()

  # Search only the configured output directory, and only files newer than
  # the pre-run timestamp. NUL delimiters protect spaces in filenames.
  while IFS= read -r -d '' candidate; do
    [[ -s "$candidate" ]] || continue
    local mtime
    mtime="$(stat -f '%m' "$candidate" 2>/dev/null || stat -c '%Y' "$candidate" 2>/dev/null || echo 0)"
    if [[ "$mtime" -ge "$started_epoch" ]]; then
      candidates+=("$candidate")
    fi
  done < <(find "$DOCS" -maxdepth 2 -type f \
      \( -name "${bid}.ipa" -o -name "${bid}_decrypted.ipa" -o -name "${bid}"'*.ipa' \) \
      -print0 2>/dev/null)

  ((${#candidates[@]} > 0)) || return 1

  # Select newest matching fresh output.
  local newest="" newest_mtime=0 mtime
  for candidate in "${candidates[@]}"; do
    mtime="$(stat -f '%m' "$candidate" 2>/dev/null || stat -c '%Y' "$candidate" 2>/dev/null || echo 0)"
    if [[ "$mtime" -ge "$newest_mtime" ]]; then
      newest="$candidate"
      newest_mtime="$mtime"
    fi
  done
  [[ -n "$newest" ]] || return 1
  printf '%s\n' "$newest"
}

upload_ipa() {
  local id="$1" ipa="$2" name="$3"
  local qid qname response

  [[ -s "$ipa" ]] || return 1
  qid="$(urlencode "$id")"
  qname="$(urlencode "$name")"

  response="$(curl -fsS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time "$UPLOAD_MAX_TIME" \
    -X POST \
    -H "X-Decrypt-Worker-Token: ${TOKEN}" \
    -H "X-AS-ADID: ${ADID}" \
    -H "Content-Type: application/octet-stream" \
    -H "Accept: application/json" \
    --data-binary @"$ipa" \
    "${BASE}api/decrypt/worker/complete?id=${qid}&name=${qname}")" || return 1

  # Accept a valid JSON response unless it explicitly reports failure.
  # Adjust this predicate if the server uses a different response contract.
  printf '%s' "$response" | jq -e '
    type == "object" and
    (.ok != false) and
    (.success != false) and
    (has("error") | not)
  ' >/dev/null 2>&1
}

handle_job() {
  local id="$1" url="$2"
  CURRENT_JOB_ID="$id"
  log "claimed ${id}"
  progress "$id" "DELvEKBot · resolving App Store listing"

  local lookup bid name
  lookup="$(itunes_lookup "$url")" || {
    fail_job "$id" "Could not resolve a bundle ID from the App Store URL."
    CURRENT_JOB_ID=""
    return 0
  }
  bid="${lookup%%$'\t'*}"
  name="${lookup#*$'\t'}"
  [[ -n "$bid" ]] || {
    fail_job "$id" "App Store lookup returned no bundle ID."
    CURRENT_JOB_ID=""
    return 0
  }
  [[ -n "$name" ]] || name="$bid"

  progress "$id" "DELvEKBot · resolved ${bid}; starting buddy3"

  # Subtract 1s so same-second mtimes on coarse filesystems still qualify.
  local started_epoch
  started_epoch="$(( $(date +%s) - 1 ))"
  local -a args=()
  [[ "${BUDDY3_VERBOSE:-0}" == "1" ]] && args+=(-v)
  args+=("$bid")

  start_heartbeat "$id"

  set +e
  "${BUDDY3_BIN}" "${args[@]}"
  local rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    stop_heartbeat
    fail_job "$id" "buddy3 exited with status ${rc} for ${bid}."
    CURRENT_JOB_ID=""
    return 0
  fi

  local ipa
  ipa="$(find_fresh_buddy_ipa "$bid" "$started_epoch")" || {
    stop_heartbeat
    fail_job "$id" "buddy3 finished, but no fresh matching IPA was found under ${DOCS}."
    CURRENT_JOB_ID=""
    return 0
  }

  # Keep the lease heartbeat alive through potentially long uploads.
  progress "$id" "DELvEKBot · uploading $(basename "$ipa")"
  if upload_ipa "$id" "$ipa" "$name"; then
    log "upload completed for ${name} (${bid})"
  else
    fail_job "$id" "IPA upload failed or the server returned an invalid completion response."
  fi
  stop_heartbeat
  CURRENT_JOB_ID=""
}

cleanup() {
  stop_heartbeat
  if [[ -n "${CURRENT_JOB_ID}" ]]; then
    log "worker stopped while job ${CURRENT_JOB_ID} was active; server lease/recovery policy applies"
  fi
}

# INT/TERM must exit so the EXIT trap runs cleanup once and the loop stops.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

main() {
  need_cmd curl
  need_cmd jq
  need_cmd flock
  need_cmd find
  need_cmd stat
  need_cmd date
  need_cmd sed

  [[ -n "$SITE_URL" ]] || die "set DECRYPT_SITE_URL=https://your-server/"
  [[ -n "$TOKEN" ]] || die "set DECRYPT_WORKER_TOKEN"
  [[ -x "$BUDDY3_BIN" ]] || die "buddy3 is not executable: ${BUDDY3_BIN}"
  [[ -d "$DOCS" ]] || die "output directory does not exist: ${DOCS}"
  [[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] && ((POLL_SECONDS >= 1)) || die "POLL_SECONDS must be a positive integer"
  [[ "$HEARTBEAT_SECONDS" =~ ^[0-9]+$ ]] && ((HEARTBEAT_SECONDS >= 5)) || die "HEARTBEAT_SECONDS must be >= 5"
  [[ "$COUNTRY" =~ ^[a-zA-Z]{2}$ ]] || die "COUNTRY must be a 2-letter storefront code"

  BASE="$(normalize_base "$SITE_URL")" || die "invalid DECRYPT_SITE_URL"
  COUNTRY="$(printf '%s' "$COUNTRY" | tr '[:upper:]' '[:lower:]')"

  # Non-blocking process lock: only one worker may use this output directory.
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another DELvEKBot worker is already running (lock: ${LOCK_FILE})"

  log "site=${BASE} · adid=${ADID} · buddy3=${BUDDY3_BIN}"
  log "poll=${POLL_SECONDS}s · heartbeat=${HEARTBEAT_SECONDS}s · output=${DOCS}"

  while true; do
    local resp id url fields
    if ! resp="$(api POST "api/decrypt/worker/claim" \
        -d "$(jq -cn --arg adid "$ADID" '{adid:$adid}')" 2>/dev/null)"; then
      log "claim request failed; retrying in ${POLL_SECONDS}s"
      sleep "$POLL_SECONDS"
      continue
    fi

    if ! printf '%s' "$resp" | jq -e 'type == "object"' >/dev/null 2>&1; then
      log "server returned invalid JSON; retrying"
      sleep "$POLL_SECONDS"
      continue
    fi

    if is_idle_claim "$resp"; then
      sleep "$POLL_SECONDS"
      continue
    fi

    fields="$(claim_fields "$resp")" || {
      log "claim response did not contain string id/url; retrying"
      sleep "$POLL_SECONDS"
      continue
    }
    id="$(printf '%s' "$fields" | jq -er '.id')"
    url="$(printf '%s' "$fields" | jq -er '.url')"

    handle_job "$id" "$url"
    sleep 1
  done
}

main "$@"
