# DELvEKBot — phone worker + VPS panel

**JS + shell only.** Flow: **iPhone worker → VPS (Node/PM2) → Telegram**

| Piece | Path |
|------|------|
| Phone worker | `delvekbot-worker.sh` |
| Control panel + API | `panel/index.js`, `panel/css.js`, `panel/store.js` |
| Apache helper | `panel/configure-apache.js` |
| PM2 | `panel/ecosystem.config.cjs` |
| Install | `panel/install-vps.sh` |

## VPS install (Debian + Apache + PM2)

```sh
git clone --branch cursor/delvekbot-server-api-708a https://github.com/unflavoredapp/Game.git /opt/delvekbot
bash /opt/delvekbot/DELvEKBot/panel/install-vps.sh
```

After install:

1. Edit `/etc/delvekbot.env` — set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
2. `cd /opt/delvekbot/DELvEKBot/panel && pm2 restart delvekbot --update-env`
3. Open `https://delvek.bot/?token=YOUR_ADMIN_TOKEN`

```sh
pm2 status
pm2 logs delvekbot
pm2 restart delvekbot
```

## Phone `.env`

```sh
DECRYPT_SITE_URL=https://delvek.bot/
DECRYPT_WORKER_TOKEN=<from /etc/delvekbot.env>
BUDDY3_BIN=/var/mobile/Documents/buddy3
BUDDY3_OUT_DIR=/var/mobile/Documents
```

```sh
bash delvekbot-worker.sh
```

## Telegram

1. `@BotFather` → bot token  
2. Chat/channel id for delivery  
3. Put both in `/etc/delvekbot.env` → `pm2 restart delvekbot --update-env`
