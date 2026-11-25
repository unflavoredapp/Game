# Decrypt Web

**Site:** [getipa.fast](https://getipa.fast)

<p><img src="brand/getipa-icon.jpg" alt="getipa.fast icon" width="96" height="96" /></p>

A **decryption network** with a versioned HTTP protocol. Nodes claim jobs, decrypt apps, and return artifacts through a relay. No wallets, tokens, or chains — shared secrets and leases.

Built for **getipa.fast** — a separate domain that backpedaled on adopting DELvEKBot and running that VPS stack. We stay conceptually synced with [`../DELvEKBot/`](../DELvEKBot/) (same decrypt-job ideas; our production host remains [delvek.bot](https://delvek.bot/)), but this track is its own protocol + toolchain.

| Piece | Path |
|-------|------|
| Protocol | [`PROTOCOL.md`](PROTOCOL.md) |
| OpenAPI | [`openapi.yaml`](openapi.yaml) |
| Reference relay | [`relay/`](relay/) |
| Roadmap (toolchain) | [`ROADMAP.md`](ROADMAP.md) |

## What it does now

Run the relay and open the site — **getipa.fast actually queues + completes jobs**:

1. Brand landing at `/`
2. Operator console (`#get`) — paste token, submit App Store URL
3. Built-in **demo node** claims jobs, fakes decrypt progress, returns a downloadable artifact  
   (`DEMO_NODE=0` when you attach real phone nodes)

## Quick start (reference relay)

```sh
cd decrypt-web/relay
cp .env.example .env   # set OPERATOR_TOKEN and NODE_TOKEN
npm install
npm start
# open http://127.0.0.1:3040/
```

Local health: `GET http://127.0.0.1:3040/v0/health`  
Production base: `https://getipa.fast`

```sh
BASE=http://127.0.0.1:3040   # or https://getipa.fast

# enqueue (or use the site console)
curl -s -X POST "$BASE/v0/jobs" \
  -H "X-Decrypt-Operator-Token: $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://apps.apple.com/us/app/id123","country":"us","constraints":{"backends":["demo"]}}'
```

## Design

- **Protocol-first** — wire format and objects are the product; the relay is a reference implementation.
- **Nodes are capacity** — countries + backends for routing, never for auth.
- **Relay is coordinator** — queue, lease, artifact store, operator API.
- **Toolchain over time** — CLI, panel, and node kits land as Decrypt Web v0.1+ (see ROADMAP).
- **Synced, not merged** — delvek.bot / DELvEKBot stays ours; getipa.fast is the other path.
