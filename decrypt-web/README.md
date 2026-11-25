# Decrypt Web

A **decryption network** with a versioned HTTP protocol. Nodes claim jobs, decrypt apps, and return artifacts through a relay. No wallets, tokens, or chains — shared secrets and leases.

Built for a **separate domain** that backpedaled on adopting DELvEKBot and running that VPS stack. We stay conceptually synced with [`../DELvEKBot/`](../DELvEKBot/) (same decrypt-job ideas), but this track is its own protocol + toolchain — not a replacement for DELvEKBot on our side.

| Piece | Path |
|-------|------|
| Protocol | [`PROTOCOL.md`](PROTOCOL.md) |
| OpenAPI | [`openapi.yaml`](openapi.yaml) |
| Reference relay | [`relay/`](relay/) |
| Roadmap (toolchain) | [`ROADMAP.md`](ROADMAP.md) |

## Quick start (reference relay)

```sh
cd decrypt-web/relay
cp .env.example .env   # set OPERATOR_TOKEN and NODE_TOKEN
npm install
npm start
```

Health: `GET http://127.0.0.1:3040/v0/health`

```sh
# enqueue
curl -s -X POST http://127.0.0.1:3040/v0/jobs \
  -H "X-Decrypt-Operator-Token: $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://apps.apple.com/us/app/id123","country":"us"}'

# node hello + claim
curl -s -X POST http://127.0.0.1:3040/v0/node/hello \
  -H "X-Decrypt-Node-Token: $NODE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"dev-1","countries":["us"],"capabilities":{"backends":["buddy3"]}}'

curl -s -X POST http://127.0.0.1:3040/v0/node/claim \
  -H "X-Decrypt-Node-Token: $NODE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"dev-1","countries":["us"]}'
```

## Design

- **Protocol-first** — wire format and objects are the product; the relay is a reference implementation.
- **Nodes are capacity** — countries + backends for routing, never for auth.
- **Relay is coordinator** — queue, lease, artifact store, operator API.
- **Toolchain over time** — CLI, panel, and node kits land as Decrypt Web v0.1+ (see ROADMAP).
- **Synced, not merged** — DELvEKBot remains our VPS/phone product; Decrypt Web is the other domain’s path.
