# DELvEKBot server contract

The phone worker preserves the API paths and headers from the submitted script.

## Existing endpoints expected by the worker

| Method | Path | Expected behavior |
|---|---|---|
| POST | `/api/decrypt/worker/claim` | Authenticates worker. Idle: `{ "job": null }`. Active: top-level string `id` + `url`, **or** nested `{ "job": { "id", "url" } }`. |
| POST | `/api/decrypt/worker/progress` | Records progress for a job. Recommended: also refresh the job lease. |
| POST | `/api/decrypt/worker/fail` | Marks a job failed with a supplied error. |
| POST | `/api/decrypt/worker/complete?id=...&name=...` | Accepts the IPA bytes and returns a JSON object indicating success. Query values are URI-encoded. |

All requests include:
- `X-Decrypt-Worker-Token: <worker token>`

Auth is token-only. No AirShare / ADID header is sent or required.

### Claim response shapes

```json
{ "job": null }
```

```json
{ "id": "uuid-or-opaque-id", "url": "https://apps.apple.com/.../id123456789" }
```

```json
{ "job": { "id": "uuid-or-opaque-id", "url": "https://apps.apple.com/.../id123456789" } }
```

Do not return an active job without string `id` and `url` (top-level or under `job`).
The worker treats any response without extractable string `id`/`url` as idle/invalid and retries.

## Recommended worker registry

Store one record per registered worker (keyed by worker token or an opaque server-side id):

- `status` (`online`, `offline`, `busy`, `disabled`)
- `last_seen_at`
- `ios_version`
- `jailbreak` / bootstrap type
- `capabilities` (backend names and supported operations)
- `free_bytes` and `total_bytes`
- `active_job_id`
- `last_error`

Do not trust device-reported capability data as authorization. Treat it as routing metadata and validate job eligibility independently.

## Lease and recovery behavior

The client sends periodic progress requests during a long-running buddy3 operation
and through IPA upload. For this to act as a heartbeat, the server's progress
handler should atomically extend `lease_expires_at` for the matching job and worker.

Recommended server behavior:

1. Claim assigns a worker and a bounded lease expiry.
2. Progress from the assigned worker extends the lease and updates `last_seen_at`.
3. A periodic server task marks workers offline after a configurable timeout.
4. Expired active jobs are requeued or failed according to retry count.
5. Completion/failure is accepted only from the worker currently holding the lease.
6. Completion is idempotent, so a retried upload cannot deliver duplicate results.

The phone script does not invent a heartbeat URL because the supplied server
code/API contract was not included. If you prefer a dedicated endpoint, add
`POST /api/decrypt/worker/heartbeat` server-side and update the client together.

## Suggested capability-aware routing

Before dispatch, compare the job's required backend/platform constraints with
the worker's registered capability record. Reject or defer incompatible jobs.
Expose worker health in an admin view, but never expose worker tokens.
