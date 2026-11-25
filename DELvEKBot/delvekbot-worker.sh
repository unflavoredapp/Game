#!/usr/bin/env bash
# DELvEKBot · on-device Dopamine/buddy3 worker
#
# A phone-side worker for jobs queued by your DELvEKBot/Tetherless-compatible
# server. This script does not implement the server queue or Telegram bot.
#
# Required tools: bash, curl, jq, sed, date, find, stat
# Optional: flock (falls back to mkdir lock on Dopamine/Procursus)
#
# Configure:
#   export DECRYPT_SITE_URL=https://your-server.example/
#   export DECRYPT_WORKER_TOKEN='...'
#   export BUDDY3_BIN=/var/mobile/Documents/buddy3
#   export BUDDY3_OUT_DIR=/var/mobile/Documents
#   bash delvekbot-worker.sh
#   # (auto re-execs under sudo on iPhone — buddy3 / appstorectl need root)
#
# Or copy .env.example to .env next to this script (auto-loaded).
#
# Optional:
#   POLL_SECONDS=3
#   HEARTBEAT_SECONDS=30
#   COUNTRY=us
#   BUDDY3_VERBOSE=1
#   CURL_CONNECT_TIMEOUT=15
#   CURL_MAX_TIME=60
#   UPLOAD_MAX_TIME=1800
#   APPSTOREDL_BIN=/path/to/appstoredl   # auto-detected next to buddy3
#   SKIP_FETCH=0                         # set 1 to skip App Store install
#   FETCH_WAIT_SECONDS=8                 # pause after appstoredl before buddy3
#   DELVEKBOT_PHONE=iphone-multi-01
#   COUNTRY=us                           # default / fallback storefront
#   COUNTRIES=us,in                      # or auto from phone/accounts.json
#   DELVEKBOT_PHONE_DIR=.../DELvEKBot/phone
#   DELVEKBOT_NO_SUDO=1                  # skip sudo re-exec (tests only)
#
# Notes:
# - Always runs as root on the phone (re-execs via sudo -E unless already root).
# - jq is required for reliable JSON parsing.
# - The worker uses the existing /progress endpoint for heartbeat messages.
#   The server must extend the job lease on progress calls if you want those
#   calls to act as lease heartbeats. See README.md.
# - buddy3 output is matched by bundle id: <bundleId>.ipa (typical),
#   <bundleId>_decrypted.ipa, or <bundleId>*.ipa — not the App Store display name.
# - Discovery prefers IPAs that appeared or changed size since buddy3 started,
#   because buddy3 often preserves package mtimes on the written .ipa.

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
PHONE_ID="${DELVEKBOT_PHONE:-${DECRYPT_WORKER_PHONE:-default-phone}}"
PHONE_DIR="${DELVEKBOT_PHONE_DIR:-${_SCRIPT_DIR}/phone}"
SWITCH_SCRIPT="${DELVEKBOT_SWITCH_SCRIPT:-$PHONE_DIR/switch-storefront.sh}"
ACCOUNTS_JSON="${DELVEKBOT_ACCOUNTS:-$PHONE_DIR/accounts.json}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-15}"
CURL_MAX_TIME="${CURL_MAX_TIME:-60}"
UPLOAD_MAX_TIME="${UPLOAD_MAX_TIME:-1800}"
SKIP_FETCH="${SKIP_FETCH:-0}"
SKIP_ACCOUNT_SWITCH="${SKIP_ACCOUNT_SWITCH:-0}"
FETCH_WAIT_SECONDS="${FETCH_WAIT_SECONDS:-8}"
LOCK_FILE="${DELVEKBOT_LOCK_FILE:-${DOCS}/.delvekbot-worker.lock}"
LOCK_DIR="${DELVEKBOT_LOCK_DIR:-${DOCS}/.delvekbot-worker.lockdir}"

# Prefer explicit APPSTOREDL_BIN; else same directory as buddy3; else PATH.
if [[ -z "${APPSTOREDL_BIN:-}" ]]; then
  if [[ -x "$(dirname "$BUDDY3_BIN")/appstoredl" ]]; then
    APPSTOREDL_BIN="$(dirname "$BUDDY3_BIN")/appstoredl"
  elif command -v appstoredl >/dev/null 2>&1; then
    APPSTOREDL_BIN="$(command -v appstoredl)"
  else
    APPSTOREDL_BIN=""
  fi
fi

# COUNTRIES: explicit env, else keys from accounts.json, else single COUNTRY.
if [[ -z "${COUNTRIES:-}" ]]; then
  if [[ -f "$ACCOUNTS_JSON" ]] && command -v jq >/dev/null 2>&1; then
    COUNTRIES="$(jq -r 'keys|join(",")' "$ACCOUNTS_JSON" 2>/dev/null || true)"
  fi
fi
COUNTRIES="${COUNTRIES:-$COUNTRY}"

BASE=""
CURRENT_JOB_ID=""
HEARTBEAT_PID=""
LOCK_MODE=""

log() { printf 'DELvEKBot: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

acquire_lock() {
  # Prefer flock when available; otherwise atomic mkdir (works without util-linux).
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock -n 9 || die "another DELvEKBot worker is already running (lock: ${LOCK_FILE})"
    LOCK_MODE="flock"
    return 0
  fi
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    LOCK_MODE="mkdir"
    return 0
  fi
  die "another DELvEKBot worker is already running (lock: ${LOCK_DIR})"
}

release_lock() {
  if [[ "$LOCK_MODE" == "mkdir" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

# buddy3 / appstorectl / appstoredl need root on Dopamine. Re-exec under sudo
# while preserving env (tokens, paths) via -E. Set DELVEKBOT_NO_SUDO=1 to skip.
ensure_root_via_sudo() {
  local uid
  uid="$(id -u 2>/dev/null || echo 1)"
  if [[ "$uid" -eq 0 ]]; then
    return 0
  fi
  if [[ "${DELVEKBOT_NO_SUDO:-0}" == "1" ]]; then
    log "DELVEKBOT_NO_SUDO=1 · continuing as uid=${uid} (not for production)"
    return 0
  fi
  need_cmd sudo
  log "not root (uid=${uid}) · re-executing under sudo -E"
  exec sudo -E -- "$0" "$@"
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
    -H "X-Delvekbot-Phone: ${PHONE_ID}" \
    -H "X-Delvekbot-Country: ${COUNTRY}" \
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

extract_adam_id() {
  printf '%s' "$1" | sed -nE 's/.*\/id([0-9]{5,12})([^0-9].*)?$/\1/p' | head -1
}

itunes_lookup() {
  local store_url="$1" storefront="${2:-$COUNTRY}" app_id body
  app_id="$(extract_adam_id "$store_url")"
  [[ -n "$app_id" ]] || return 1
  storefront="$(printf '%s' "$storefront" | tr '[:upper:]' '[:lower:]')"

  body="$(curl -fsSL \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    --max-time 30 \
    "https://itunes.apple.com/lookup?id=${app_id}&country=${storefront}" 2>/dev/null)" || return 1

  local result
  # bundleId, trackName, adamId
  result="$(printf '%s' "$body" | jq -er \
    --arg adam "$app_id" \
    '.results[0] | select(.bundleId and .trackName) | [.bundleId,.trackName,$adam] | @tsv' 2>/dev/null)" || return 1
  printf '%s\n' "$result"
}

switch_storefront_account() {
  local storefront="$1"
  if [[ "$SKIP_ACCOUNT_SWITCH" == "1" ]]; then
    log "SKIP_ACCOUNT_SWITCH=1 · leaving current App Store account"
    return 0
  fi
  if [[ ! -x "$SWITCH_SCRIPT" ]]; then
    log "switch-storefront.sh not found (${SWITCH_SCRIPT}); using current App Store login"
    return 0
  fi
  log "switching Apple ID for storefront ${storefront}"
  "$SWITCH_SCRIPT" "$storefront"
}

# Install/redownload via on-device App Store account, then buddy3 can decrypt.
ensure_app_installed() {
  local bid="$1" adam="$2" storefront="${3:-$COUNTRY}"
  if [[ "$SKIP_FETCH" == "1" ]]; then
    log "SKIP_FETCH=1 · not calling appstoredl/appstorectl"
    return 0
  fi

  switch_storefront_account "$storefront" || return $?

  # Prefer appstorectl install when available (same CLI used for account switch).
  if command -v appstorectl >/dev/null 2>&1; then
    log "fetching ${bid} via appstorectl install (--no-export)"
    set +e
    if [[ -n "$adam" ]]; then
      appstorectl install "$bid" --adam "$adam" --no-export
    else
      appstorectl install "$bid" --no-export
    fi
    local rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
      [[ "$FETCH_WAIT_SECONDS" =~ ^[0-9]+$ ]] && ((FETCH_WAIT_SECONDS > 0)) && sleep "$FETCH_WAIT_SECONDS"
      return 0
    fi
    log "appstorectl install failed (rc=${rc}); trying appstoredl"
  fi

  if [[ -z "$APPSTOREDL_BIN" || ! -x "$APPSTOREDL_BIN" ]]; then
    log "appstoredl not found; buddy3 will only work if ${bid} is already installed"
    return 0
  fi

  log "fetching ${bid} via appstoredl"
  set +e
  "${APPSTOREDL_BIN}" "$bid"
  local rc=$?
  if [[ "$rc" -ne 0 && -n "$adam" ]]; then
    log "appstoredl bundle-id failed (rc=${rc}); retrying with adam id ${adam}"
    "${APPSTOREDL_BIN}" "$adam"
    rc=$?
  fi
  set -e
  if [[ "$rc" -ne 0 ]]; then
    return "$rc"
  fi
  if [[ "$FETCH_WAIT_SECONDS" =~ ^[0-9]+$ ]] && ((FETCH_WAIT_SECONDS > 0)); then
    log "waiting ${FETCH_WAIT_SECONDS}s for install to settle"
    sleep "$FETCH_WAIT_SECONDS"
  fi
  return 0
}

# buddy3 usually writes "<bundleId>.ipa" (not AppName_decrypted.ipa).
# Also accept "<bundleId>_decrypted.ipa" and any "<bundleId>*.ipa".
ipa_name_matches_bid() {
  local bid="$1" base="$2"
  [[ "$base" == "${bid}.ipa" \
    || "$base" == "${bid}_decrypted.ipa" \
    || "$base" == "${bid}"*.ipa ]]
}

file_mtime_epoch() {
  # Darwin/iOS: stat -f '%m' · GNU: stat -c '%Y'
  local out
  out="$(stat -f '%m' "$1" 2>/dev/null || true)"
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$out"
    return 0
  fi
  out="$(stat -c '%Y' "$1" 2>/dev/null || true)"
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '0\n'
}

file_size_bytes() {
  local out
  out="$(wc -c < "$1" 2>/dev/null | tr -d '[:space:]')"
  [[ "$out" =~ ^[0-9]+$ ]] || out=0
  printf '%s\n' "$out"
}

# Write "path<TAB>size" lines for every matching IPA currently under DOCS.
# Uses a temp find list (no process substitution) for Dopamine bash compatibility.
snapshot_matching_ipas() {
  local bid="$1" out="$2"
  local f base tmp
  : > "$out"
  tmp="$(mktemp "${TMPDIR:-/tmp}/delvekbot-find.XXXXXX")"
  find "$DOCS" -maxdepth 2 -type f -name '*.ipa' 2>/dev/null | LC_ALL=C sort > "$tmp" || true
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] || continue
    base="$(basename "$f")"
    ipa_name_matches_bid "$bid" "$base" || continue
    printf '%s\t%s\n' "$f" "$(file_size_bytes "$f")"
  done < "$tmp" >> "$out"
  rm -f "$tmp"
}

# Prefer IPAs that appeared or changed size since the pre-buddy3 snapshot.
# buddy3 often preserves package mtimes, so a pure mtime "freshness" check
# falsely rejects a brand-new "<bundleId>.ipa" (e.g. com.audiomack.iphone.ipa).
find_fresh_buddy_ipa() {
  local bid="$1" snap="$2"
  local started_epoch="${3:-0}"
  local f base size old mtime
  local newest="" newest_mtime=0
  local newest_changed="" newest_changed_mtime=0
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/delvekbot-ipas.XXXXXX")"
  find "$DOCS" -maxdepth 2 -type f -name '*.ipa' 2>/dev/null | LC_ALL=C sort > "$tmp" || true

  while IFS= read -r f; do
    [[ -n "$f" && -s "$f" ]] || continue
    base="$(basename "$f")"
    ipa_name_matches_bid "$bid" "$base" || continue

    size="$(file_size_bytes "$f")"
    old="$(awk -F '\t' -v p="$f" '$1 == p { print $2; exit }' "$snap" 2>/dev/null || true)"
    mtime="$(file_mtime_epoch "$f")"

    if [[ -z "$old" || "$old" != "$size" ]]; then
      if [[ "$mtime" -ge "$newest_changed_mtime" ]]; then
        newest_changed="$f"
        newest_changed_mtime="$mtime"
      fi
    fi

    # Also track mtime-fresh matches (covers tools that rewrite in place
    # without a size change, when the filesystem updates mtime).
    if [[ "$started_epoch" =~ ^[0-9]+$ ]] && (( started_epoch > 0 )) \
      && [[ "$mtime" -ge "$started_epoch" ]]; then
      if [[ "$mtime" -ge "$newest_changed_mtime" ]]; then
        newest_changed="$f"
        newest_changed_mtime="$mtime"
      fi
    fi

    if [[ "$mtime" -ge "$newest_mtime" ]]; then
      newest="$f"
      newest_mtime="$mtime"
    fi
  done < "$tmp"
  rm -f "$tmp"

  if [[ -n "$newest_changed" ]]; then
    log "selected IPA $(basename "$newest_changed") (new or size-changed since buddy3 start)"
    printf '%s\n' "$newest_changed"
    return 0
  fi

  # Last resort after a successful buddy3 exit: newest name match.
  # Safer than failing when buddy3 stamped an old mtime onto a real output.
  if [[ -n "$newest" ]]; then
    log "no size/mtime-fresh IPA for ${bid}; using newest match $(basename "$newest")"
    printf '%s\n' "$newest"
    return 0
  fi

  log "no IPA matching ${bid}.ipa / ${bid}_decrypted.ipa / ${bid}*.ipa under ${DOCS}"
  return 1
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
  local id="$1" url="$2" job_country="${3:-$COUNTRY}"
  CURRENT_JOB_ID="$id"
  job_country="$(printf '%s' "$job_country" | tr '[:upper:]' '[:lower:]')"
  [[ "$job_country" =~ ^[a-z]{2}$ ]] || job_country="$COUNTRY"
  log "claimed ${id} · country=${job_country}"
  progress "$id" "DELvEKBot · resolving App Store listing (${job_country})"

  local lookup bid name adam rest
  lookup="$(itunes_lookup "$url" "$job_country")" || {
    fail_job "$id" "Could not resolve a bundle ID from the App Store URL."
    CURRENT_JOB_ID=""
    return 0
  }
  bid="${lookup%%$'\t'*}"
  rest="${lookup#*$'\t'}"
  name="${rest%%$'\t'*}"
  adam="${rest#*$'\t'}"
  [[ "$adam" == "$rest" ]] && adam="$(extract_adam_id "$url")"
  [[ -n "$bid" ]] || {
    fail_job "$id" "App Store lookup returned no bundle ID."
    CURRENT_JOB_ID=""
    return 0
  }
  [[ -n "$name" ]] || name="$bid"

  progress "$id" "DELvEKBot · resolved ${bid}; switching Apple ID / installing"

  start_heartbeat "$id"

  set +e
  ensure_app_installed "$bid" "$adam" "$job_country"
  local fetch_rc=$?
  set -e
  if [[ "$fetch_rc" -ne 0 ]]; then
    stop_heartbeat
    fail_job "$id" "App Store fetch failed for ${bid} (${job_country}). Run phone/bootstrap-accounts.sh once, or check appstorectl/appstoredl."
    CURRENT_JOB_ID=""
    return 0
  fi

  progress "$id" "DELvEKBot · starting buddy3 for ${bid}"

  # Snapshot matching IPAs before buddy3. buddy3 often writes "<bundleId>.ipa"
  # and may preserve package mtimes, so we detect new/changed size rather than
  # relying only on mtime freshness.
  local started_epoch snap
  started_epoch="$(( $(date +%s) - 1 ))"
  snap="$(mktemp "${TMPDIR:-/tmp}/delvekbot-snap.XXXXXX")"
  snapshot_matching_ipas "$bid" "$snap"

  local -a args=()
  [[ "${BUDDY3_VERBOSE:-0}" == "1" ]] && args+=(-v)
  args+=("$bid")

  set +e
  "${BUDDY3_BIN}" "${args[@]}"
  local rc=$?
  set -e

  if [[ "$rc" -ne 0 ]]; then
    rm -f "$snap"
    stop_heartbeat
    fail_job "$id" "buddy3 exited with status ${rc} for ${bid} (app missing or not decryptable)."
    CURRENT_JOB_ID=""
    return 0
  fi

  # Brief settle in case buddy3 closes the file slightly after exit.
  sleep 1

  local ipa
  ipa="$(find_fresh_buddy_ipa "$bid" "$snap" "$started_epoch")" || {
    rm -f "$snap"
    stop_heartbeat
    fail_job "$id" "buddy3 finished, but no matching IPA (${bid}.ipa) was found under ${DOCS}."
    CURRENT_JOB_ID=""
    return 0
  }
  rm -f "$snap"

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
  release_lock
  if [[ -n "${CURRENT_JOB_ID}" ]]; then
    log "worker stopped while job ${CURRENT_JOB_ID} was active; server lease/recovery policy applies"
  fi
}

# INT/TERM must exit so the EXIT trap runs cleanup once and the loop stops.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

main() {
  ensure_root_via_sudo "$@"

  need_cmd curl
  need_cmd jq
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
  COUNTRY="$(printf '%s' "$COUNTRY" | tr '[:upper:]' '[:lower:]')"
  COUNTRIES="$(printf '%s' "$COUNTRIES" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  [[ "$COUNTRY" =~ ^[a-z]{2}$ ]] || die "COUNTRY must be a 2-letter storefront code"

  BASE="$(normalize_base "$SITE_URL")" || die "invalid DECRYPT_SITE_URL"

  # Single-worker lock (flock if present, else mkdir).
  acquire_lock

  log "uid=$(id -u) · site=${BASE} · buddy3=${BUDDY3_BIN}"
  log "phone=${PHONE_ID} · countries=${COUNTRIES} · poll=${POLL_SECONDS}s · output=${DOCS}"
  log "accounts=${ACCOUNTS_JSON} · switch=$([[ -x $SWITCH_SCRIPT ]] && echo yes || echo no)"
  if [[ -n "$APPSTOREDL_BIN" ]]; then
    log "appstoredl=${APPSTOREDL_BIN} · skip_fetch=${SKIP_FETCH}"
  else
    log "appstoredl=not found · will prefer appstorectl install when present"
  fi

  while true; do
    local resp id url fields claim_body job_country
    claim_body="$(jq -cn --arg phone "$PHONE_ID" --arg countries "$COUNTRIES" '
      ($countries | split(",") | map(select(length==2))) as $c
      | {phoneId:$phone, country:($c[0] // "us"), countries:$c}
    ')"
    if ! resp="$(api POST "api/decrypt/worker/claim" \
        -d "$claim_body" 2>/dev/null)"; then
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
    job_country="$(printf '%s' "$resp" | jq -er '.country | select(type=="string")' 2>/dev/null || true)"
    [[ -n "$job_country" ]] || job_country="$COUNTRY"

    handle_job "$id" "$url" "$job_country"
    sleep 1
  done
}

main "$@"
