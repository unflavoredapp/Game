# Decrypt Web roadmap

Crypto stays out. Growth is protocol → toolchain → adapters.

## Now — Protocol foundation (this PR)

- [x] Object model: Job, Node, Artifact
- [x] HTTP contract `/v0/*` + OpenAPI
- [x] Reference relay (file-backed store, leases, capability routing, idempotent complete)
- [x] Auth: operator + node shared secrets

## v0.1 — Toolchain

Minimum tools so operators and node authors work against the protocol without hand-rolled curl:

| Tool | Purpose |
|------|---------|
| `dw` CLI | `jobs submit`, `jobs list`, `nodes list`, `artifact get` |
| Node adapter | Thin shim so DELvEKBot phone worker can speak `/v0/node/*` |
| Operator panel | Minimal dashboard (queue, nodes, progress) on the same API |
| Delivery hook | Optional Telegram/webhook on `done` / `failed` (config, not protocol) |

## v0.2 — Hardening

- Retry budget after lease expiry
- Artifact integrity (`sha256` required on complete)
- Rate limits / per-operator quotas
- Offline sweeper + metrics endpoint
- Capability matrix docs for backends (`buddy3`, …)

## Later

- Multi-relay federation (still no chain — signed operator trust lists)
- Pluggable backends beyond iOS IPA decrypt
- Public submit portal with accounts (still shared-secret or session auth)

## Non-goals

- Tokens, NFTs, wallets, on-chain settlement
- Replacing DELvEKBot overnight — bridge first, then migrate nodes
