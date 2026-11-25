# DELvEKBot — phone worker + VPS queue API

- **Phone:** `delvekbot-worker.sh` (buddy3 decrypt + upload)
- **VPS:** `server/` FastAPI queue at `https://delvek.bot/`

## VPS install (Debian + Apache)

On the server as root:

```sh
curl -fsSL https://raw.githubusercontent.com/unflavoredapp/Game/main/DELvEKBot/server/install-vps.sh -o /tmp/install-vps.sh
# Or after cloning:
git clone https://github.com/unflavoredapp/Game.git /opt/delvekbot
bash /opt/delvekbot/DELvEKBot/server/install-vps.sh
```

That will:

1. Install the API under `/opt/delvekbot`
2. Write tokens to `/etc/delvekbot.env`
3. Start `delvekbot-api` on `127.0.0.1:8080`
4. Proxy `/api/` and `/health` through Apache

Enqueue a job (from any machine with the admin token):

```sh
source /etc/delvekbot.env
curl -fsS -X POST https://delvek.bot/api/decrypt/admin/enqueue \
  -H "X-Delvekbot-Admin-Token: ${DELVEKBOT_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://apps.apple.com/us/app/example/id123456789"}'
```

## Phone worker

```sh
chmod 700 delvekbot-worker.sh
cp .env.example .env
# Set DECRYPT_SITE_URL=https://delvek.bot/
# Set DECRYPT_WORKER_TOKEN to the value from /etc/delvekbot.env on the VPS
bash delvekbot-worker.sh
```

Needs on-device: `curl`, `jq`, `flock` (`util-linux`), and `buddy3`.

## Layout

| Path | Role |
|------|------|
| `delvekbot-worker.sh` | iPhone poll/decrypt/upload client |
| `server/app.py` | Queue API (claim/progress/fail/complete) |
| `server/install-vps.sh` | Debian install + Apache proxy |
| `SERVER-CONTRACT.md` | HTTP contract |
| `tests/test-claim-parse.sh` | Claim JSON regression tests |

## Tests

```sh
bash DELvEKBot/tests/test-claim-parse.sh
```
