# Decrypt Web Protocol v0

A coordinated network for **app decryption jobs**. No wallets, tokens, or on-chain trust — shared secrets, leases, and capability routing.

Version: `0.0`  
Base path: `/v0`  
Transport: HTTPS + JSON (artifact bodies are raw bytes)

---

## 1. Objects

### Job

A unit of work: decrypt one App Store listing for a target country.

| Field | Type | Notes |
|-------|------|--------|
| `id` | string (uuid) | Server-assigned |
| `url` | string | App Store URL |
| `country` | string | ISO 3166-1 alpha-2, lowercase |
| `status` | string | `queued` \| `leased` \| `done` \| `failed` |
| `constraints` | object | Optional; e.g. `{ "backends": ["buddy3"] }` |
| `progress` | object \| null | `{ "stage": string, "percent": number, "message": string }` |
| `artifact` | object \| null | Present when `status` is `done` |
| `error` | string \| null | Present when `status` is `failed` |
| `lease` | object \| null | `{ "nodeId": string, "expiresAt": number }` while leased |
| `createdAt` | number | Unix ms |
| `updatedAt` | number | Unix ms |

### Node

A decrypt worker (phone, VM, or future backend).

| Field | Type | Notes |
|-------|------|--------|
| `id` | string | Stable id from the node |
| `status` | string | `online` \| `busy` \| `offline` |
| `countries` | string[] | Storefronts this node can serve |
| `capabilities` | object | `{ "backends": string[], "iosVersion"?: string, "jailbreak"?: string }` |
| `freeBytes` | number \| null | Optional routing hint |
| `totalBytes` | number \| null | Optional |
| `activeJobId` | string \| null | Job currently leased |
| `lastSeenAt` | number | Unix ms |
| `jobsDone` | number | Lifetime counter |
| `jobsFailed` | number | Lifetime counter |

Capability fields are **routing metadata only**, never authorization.

### Artifact

Result of a successful decrypt.

| Field | Type | Notes |
|-------|------|--------|
| `name` | string | Filename (e.g. `com.example.app.ipa`) |
| `bytes` | number | Size |
| `contentType` | string | Default `application/octet-stream` |
| `sha256` | string \| null | Optional hex digest |
| `downloadPath` | string | Relay-relative path when available |

### Delivery (v0.1+)

How results reach operators. Out of scope for protocol wire format in v0; relays may still push to Telegram or similar as an implementation detail.

---

## 2. Auth

Two shared secrets (never expose in node lists or job public views):

| Header | Role |
|--------|------|
| `X-Decrypt-Operator-Token` | Submit/list jobs, inspect nodes, download artifacts |
| `X-Decrypt-Node-Token` | Register, claim, progress, fail, complete |

Missing or wrong token → `401` with `{ "error": "unauthorized" }`.

---

## 3. Operator endpoints

### `GET /v0/health`

No auth. Returns `{ "ok": true, "protocol": "decrypt-web", "version": "0.0" }`.

### `POST /v0/jobs`

Enqueue a job.

```json
{ "url": "https://apps.apple.com/us/app/id123", "country": "us", "constraints": { "backends": ["buddy3"] } }
```

`url` required. `country` defaults to `us`. Response: `201` + Job.

### `GET /v0/jobs`

List recent jobs. Query: `?limit=50` (max 200). Response: `{ "jobs": Job[] }`.

### `GET /v0/jobs/:id`

Single job. `404` if missing.

### `GET /v0/nodes`

List known nodes. Response: `{ "nodes": Node[] }`. Tokens never included.

### `GET /v0/artifacts/:jobId`

Operator download of the stored artifact body. `404` if missing or not done.

---

## 4. Node endpoints

### `POST /v0/node/hello`

Register or refresh presence. Body:

```json
{
  "id": "phone-us-1",
  "countries": ["us", "in"],
  "capabilities": { "backends": ["buddy3"], "iosVersion": "16.5", "jailbreak": "dopamine" },
  "freeBytes": 12000000000,
  "totalBytes": 64000000000
}
```

Response: `{ "node": Node, "leaseSeconds": 900 }`.

### `POST /v0/node/claim`

Claim the next compatible queued job.

```json
{ "id": "phone-us-1", "countries": ["us", "in"] }
```

Idle: `{ "job": null }`.  
Active: `{ "job": { "id", "url", "country", "constraints" } }` (minimal lease payload).

Rules:

1. Match job `country` against node `countries`.
2. If job has `constraints.backends`, require overlap with node capabilities.
3. Assign lease (`leaseSeconds`, default 900). Only the leasing node may progress/fail/complete.

### `POST /v0/node/progress`

```json
{ "id": "phone-us-1", "jobId": "...", "message": "decrypting", "stage": "decrypt", "percent": 55 }
```

Extends lease and updates progress. `409` if node does not hold the lease.

### `POST /v0/node/fail`

```json
{ "id": "phone-us-1", "jobId": "...", "error": "install failed" }
```

Marks job `failed`. `409` if wrong lessee.

### `POST /v0/node/complete?jobId=...&name=...&nodeId=...`

Raw body = artifact bytes (so node identity cannot live in JSON).

| Source | Field |
|--------|--------|
| Query | `jobId` (required), `name` (required), `nodeId` (required unless header set) |
| Header | `X-Decrypt-Node-Id` (alternate for `nodeId`), `Content-Type`, optional `X-Decrypt-Sha256` |

Idempotent: repeating complete for an already-`done` job returns success without double-counting `jobsDone`.

Response: `{ "ok": true, "job": Job }`.

---

## 5. Lease & recovery

1. Claim sets `status=leased` and `lease.expiresAt`.
2. Progress from the lessee extends `expiresAt` and `lastSeenAt`.
3. Relay periodically (or on next claim) requeues jobs whose lease expired (`status` back to `queued`, clear lease). Retry policy may fail after N requeues (relay config).
4. Nodes with `lastSeenAt` older than the online window are reported as `offline`.

---

## 6. Relationship to DELvEKBot

DELvEKBot (our domain) speaks `/api/decrypt/worker/*` on its own VPS panel.  
Decrypt Web (other domain) speaks `/v0/node/*` with richer objects.

Same problem space; separate deployments. Keep concepts aligned when either side evolves. An optional shape bridge is fine for sync — not a requirement to merge the stacks.

---

## 7. Non-goals (v0)

- Cryptocurrency, wallets, NFTs, or on-chain settlement
- Peer-to-peer job gossip without a relay
- Trusting node-reported capabilities as auth
- Public unauthenticated job submission
