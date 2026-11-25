# DELvEKBot — Dopamine / buddy3 phone worker

Phone-side polling/decryption/upload worker for a DELvEKBot-compatible decrypt
queue. This package does **not** include the VPS server, Telegram bot, or DB.

## Included

- `delvekbot-worker.sh` — phone-side worker
- `.env.example` — configuration template (copy to `.env` beside the script)
- `SERVER-CONTRACT.md` — API assumptions and server-side work still needed
- `tests/test-claim-parse.sh` — regression tests for claim JSON parsing

## Audit fixes (vs. submitted package)

1. **Critical claim idle bug:** `jq`'s `.job == null` is true when `job` is
   *missing*, so top-level `{id,url}` claims were treated as idle and never
   run. Parsing now requires an explicit `job: null` for idle, and accepts
   both top-level and nested `{job:{id,url}}` active shapes.
2. **Signal handling:** `INT`/`TERM` now exit so the worker actually stops
   (EXIT trap still runs cleanup once).
3. **Upload lease:** heartbeat progress continues through IPA upload, not only
   during buddy3.
4. **Query encoding:** both `id` and `name` are URI-encoded on complete.
5. **Country validation:** `COUNTRY` must be a 2-letter storefront code.
6. **Env loading:** optional `.env` next to the script is auto-sourced.
7. **Fresh IPA window:** start timestamp is `now - 1s` to tolerate 1-second
   filesystem mtime resolution.
8. **`sed` check:** required dependency is validated at startup.

## Earlier hardening retained

- Fresh-output IPA selection (mtime ≥ buddy3 start)
- `jq` for JSON parse/escape
- `flock` single-worker lock per output directory
- Completion response verification
- Restrictive umask, curl timeouts, cleanup on exit

## Install

On a jailbroken iPhone (Dopamine / Procursus-style bootstrap), install:

- `curl`
- `jq`
- `util-linux` (for `flock`)

Copy `delvekbot-worker.sh` to the phone:

```sh
chmod 700 delvekbot-worker.sh
cp .env.example .env   # then edit tokens/paths
bash delvekbot-worker.sh
```

Do not put the worker token in a public repository, screenshots, or shared logs.
Use HTTPS and a unique, revocable token for each worker.

## Tests

```sh
bash DELvEKBot/tests/test-claim-parse.sh
```

## Compatibility notes

- Claim idle: `{ "job": null }`. Claim active: top-level or nested string
  `id` + `url` (see `SERVER-CONTRACT.md`).
- Completion must return a JSON object. The worker rejects invalid JSON and
  explicit `ok:false`, `success:false`, or `error` fields.
- Progress posts only renew leases if the server extends `lease_expires_at`.
- Crash recovery requires server-side lease expiry/requeue.
- Use only apps and accounts you are authorized to access.

## Operational recommendation

Give every phone a unique `DELVEKBOT_ADID`. Keep a server-side worker record
(last-seen, online state, iOS/jailbreak, storage, capabilities) and route only
compatible jobs.
