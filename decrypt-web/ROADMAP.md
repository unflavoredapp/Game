# Decrypt Web roadmap

Site: **getipa.fast**

Crypto stays out. Growth is protocol → toolchain for that domain.  
DELvEKBot / **delvek.bot** stays our stack; we keep ideas in sync without forcing them onto getipa.fast’s VPS.

## Now — Protocol foundation

- [x] Object model: Job, Node, Artifact
- [x] HTTP contract `/v0/*` + OpenAPI
- [x] Reference relay (file-backed store, leases, capability routing, idempotent complete)
- [x] Auth: operator + node shared secrets

## v0.1 — Toolchain

Minimum tools so that domain can operate without adopting DELvEKBot’s panel/install:

| Tool | Purpose | Status |
|------|---------|--------|
| Site + operator console | Brand landing + queue/download on the relay | Done (demo node) |
| `dw` CLI | `jobs submit`, `jobs list`, `nodes list`, `artifact get` | Next |
| Node kit | Reference worker client against `/v0/node/*` (their phones/backends) | Next |
| Delivery hook | Optional Telegram/webhook on `done` / `failed` (config, not protocol) | Later |

Optional later: a thin shape bridge if anyone wants DELvEKBot-style `/api/decrypt/worker/*` talk to a Decrypt Web relay — sync aid, not a migration mandate.

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
- Replacing or sunsetting DELvEKBot / delvek.bot
- Requiring getipa.fast to run our VPS/panel install
