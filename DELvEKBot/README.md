# DELvEKBot — phone worker + VPS panel

Flow: **iPhone worker → VPS (Node/PM2) → Telegram**

| Piece | Path |
|------|------|
| Phone worker | `delvekbot-worker.sh` |
| Control panel + API | `panel/index.js`, `panel/css.js` |
| PM2 config | `panel/ecosystem.config.cjs` |

## VPS install (Debian + Apache + PM2)

```sh
git clone --branch cursor/delvekbot-server-api-708a https://github.com/unflavoredapp/Game.git /opt/delvekbot
bash /opt/delvekbot/DELvEKBot/panel/install-vps.sh
```

After install:

1. Edit `/etc/delvekbot.env` — set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
2. `cd /opt/delvekbot/DELvEKBot/panel && pm2 restart delvekbot --update-env`
3. Open dashboard: `https://delvek.bot/?token=YOUR_ADMIN_TOKEN`

PM2 helpers:

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

1. Talk to `@BotFather` → create bot → copy token  
2. Start a chat with the bot (or add it to a channel)  
3. Get chat id (`@userinfobot` or similar)  
4. Put both values in `/etc/delvekbot.env` and restart PM2  

Completed IPAs are uploaded from the phone, speed is recorded, then the file is sent to Telegram with upload stats in the caption.

## Local panel dev

```sh
cd DELvEKBot/panel
cp .env.example .env   # set tokens
npm install
npm start
```
