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
BUDDY3_BIN=/var/jb/usr/local/bin/buddy3
BUDDY3_OUT_DIR=/var/mobile/Documents
# appstoredl is auto-detected beside buddy3 (App Store install before decrypt)
SKIP_FETCH=0
FETCH_WAIT_SECONDS=8
```

```sh
bash delvekbot-worker.sh
```

Job flow on the phone: resolve URL → **`appstoredl` install** (signed-in App Store account) → **`buddy3` decrypt** → upload to VPS → Telegram.

### Multiple countries / Apple IDs (one phone)

You can keep **several Apple IDs on one jailbroken phone**. Login + 2FA once per
account, then the worker switches storefront before each fetch.

```sh
cd DELvEKBot/phone
cp accounts.example.json accounts.json   # edit Apple IDs
mkdir -p passwords && chmod 700 passwords
# put each password in passwords/us.pass, passwords/in.pass (chmod 600)
bash bootstrap-accounts.sh               # interactive; complete 2FA once each
```

Requires [`appstorectl`](https://github.com/appknox/appstorectl) on the phone.
Optional: `authpref free never` (set during bootstrap) to avoid Face ID on free apps.

Worker then claims any job whose country is listed in `accounts.json` / `COUNTRIES`,
runs `switch-storefront.sh <country>`, installs via `appstorectl`/`appstoredl`, then `buddy3`.

**Still supported:** one phone per country with a single signed-in Apple ID (`COUNTRY=in`).

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
