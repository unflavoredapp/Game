# Decrypt Web

A **decryption network** with a versioned HTTP protocol. Nodes claim jobs, decrypt apps, and return artifacts through a relay. No wallets, tokens, or chains — shared secrets and leases.

| Piece | Path |
|-------|------|
| Protocol | [`PROTOCOL.md`](PROTOCOL.md) |
| OpenAPI | [`openapi.yaml`](openapi.yaml) |
| Reference relay | [`relay/`](relay/) |
| Roadmap (toolchain) | [`ROADMAP.md`](ROADMAP.md) |

Legacy production bot lives in [`../DELvEKBot/`](../DELvEKBot/). New work targets this protocol; DELvEKBot remains the audited phone worker until a Decrypt Web node adapter ships.

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
- **Toolchain comes later** — CLI, SDKs, panel, and node adapters land as Decrypt Web v0.1+ (see ROADMAP).
