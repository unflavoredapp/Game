#!/usr/bin/env bash
# Install DELvEKBot Node panel + PM2 on Debian (run as root).
# JS + shell only — no Python.
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/unflavoredapp/Game.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/delvekbot}"
PANEL_DIR="$INSTALL_ROOT/DELvEKBot/panel"
DATA_DIR="${DELVEKBOT_DATA:-/var/lib/delvekbot}"

apt-get update
apt-get -y install curl ca-certificates gnupg git apache2 openssl

# Node 22.x
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -y install nodejs
fi

a2enmod proxy proxy_http rewrite headers ssl >/dev/null

if [[ ! -d "$INSTALL_ROOT/.git" ]]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_ROOT"
else
  git -C "$INSTALL_ROOT" fetch origin
  git -C "$INSTALL_ROOT" checkout "$REPO_BRANCH"
  git -C "$INSTALL_ROOT" pull origin "$REPO_BRANCH"
fi

cd "$PANEL_DIR"
npm install --omit=dev

if [[ ! -f /etc/delvekbot.env ]]; then
  WORKER_TOKEN="$(openssl rand -hex 32)"
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  cat >/etc/delvekbot.env <<EOF
HOST=127.0.0.1
PORT=3000
DELVEKBOT_DATA=${DATA_DIR}
DECRYPT_WORKER_TOKEN=${WORKER_TOKEN}
DELVEKBOT_ADMIN_TOKEN=${ADMIN_TOKEN}
DELVEKBOT_LEASE_SECONDS=900
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EOF
  chmod 600 /etc/delvekbot.env
  echo "Wrote /etc/delvekbot.env"
else
  grep -q '^PORT=' /etc/delvekbot.env || echo 'PORT=3000' >>/etc/delvekbot.env
  grep -q '^HOST=' /etc/delvekbot.env || echo 'HOST=127.0.0.1' >>/etc/delvekbot.env
  echo "Keeping existing /etc/delvekbot.env — add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID"
fi

ln -sfn /etc/delvekbot.env "$PANEL_DIR/.env"
mkdir -p "$DATA_DIR/ipas"
chown -R root:root "$DATA_DIR"

npm install -g pm2
systemctl disable --now delvekbot-api 2>/dev/null || true

set -a
# shellcheck disable=SC1091
source /etc/delvekbot.env
set +a

pm2 delete delvekbot 2>/dev/null || true
pm2 start "$PANEL_DIR/ecosystem.config.cjs" --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.txt 2>&1 || true
# shellcheck disable=SC1090
eval "$(grep -o 'sudo.*pm2 startup.*' /tmp/pm2-startup.txt | tail -1)" 2>/dev/null || true

# Apache proxy → Node :3000 (JS helper, no Python)
node "$PANEL_DIR/configure-apache.js"

a2enmod proxy proxy_http headers rewrite ssl >/dev/null
a2ensite delvek.bot.conf >/dev/null 2>&1 || true
apache2ctl configtest
systemctl reload apache2

echo
echo "PM2 status:"
pm2 status
echo
curl -fsS http://127.0.0.1:3000/health || true
echo
echo "Dashboard: https://delvek.bot/?token=$(grep ^DELVEKBOT_ADMIN_TOKEN= /etc/delvekbot.env | cut -d= -f2-)"
echo "Phone .env:"
echo "  DECRYPT_SITE_URL=https://delvek.bot/"
grep '^DECRYPT_WORKER_TOKEN=' /etc/delvekbot.env
echo
echo "Set Telegram in /etc/delvekbot.env then: cd $PANEL_DIR && pm2 restart delvekbot --update-env"
