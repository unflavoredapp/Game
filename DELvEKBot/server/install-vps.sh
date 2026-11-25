#!/usr/bin/env bash
# Install DELvEKBot API on Debian (run as root on the VPS).
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/unflavoredapp/Game.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/delvekbot}"
DATA_DIR="${DELVEKBOT_DATA:-/var/lib/delvekbot}"

apt-get update
apt-get -y install python3 python3-venv python3-pip git apache2 openssl

a2enmod proxy proxy_http rewrite headers ssl >/dev/null

if [[ ! -d "$INSTALL_ROOT/.git" ]]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_ROOT"
else
  git -C "$INSTALL_ROOT" fetch origin
  git -C "$INSTALL_ROOT" checkout "$REPO_BRANCH"
  git -C "$INSTALL_ROOT" pull origin "$REPO_BRANCH"
fi

python3 -m venv "$INSTALL_ROOT/venv"
"$INSTALL_ROOT/venv/bin/pip" install -U pip
"$INSTALL_ROOT/venv/bin/pip" install -r "$INSTALL_ROOT/DELvEKBot/server/requirements.txt"

# App lives at /opt/delvekbot/server via symlink for the unit WorkingDirectory.
ln -sfn "$INSTALL_ROOT/DELvEKBot/server" "$INSTALL_ROOT/server"

mkdir -p "$DATA_DIR/ipas"
chown -R www-data:www-data "$DATA_DIR"
# www-data must read the app + venv
chown -R root:www-data "$INSTALL_ROOT"
chmod -R g+rX "$INSTALL_ROOT"

if [[ ! -f /etc/delvekbot.env ]]; then
  WORKER_TOKEN="$(openssl rand -hex 32)"
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  cat >/etc/delvekbot.env <<EOF
DECRYPT_WORKER_TOKEN=${WORKER_TOKEN}
DELVEKBOT_ADMIN_TOKEN=${ADMIN_TOKEN}
DELVEKBOT_DATA=${DATA_DIR}
DELVEKBOT_HOST=127.0.0.1
DELVEKBOT_PORT=8080
DELVEKBOT_LEASE_SECONDS=900
EOF
  chmod 600 /etc/delvekbot.env
  echo "Wrote /etc/delvekbot.env (tokens generated)."
else
  echo "Keeping existing /etc/delvekbot.env"
fi

install -m 644 "$INSTALL_ROOT/DELvEKBot/server/delvekbot-api.service" \
  /etc/systemd/system/delvekbot-api.service

# Apache site: merge proxy into existing SSL vhost when present.
SITE_AVAIL=/etc/apache2/sites-available/delvek.bot-le-ssl.conf
SITE_HTTP=/etc/apache2/sites-available/delvek.bot.conf
PROXY_SNIPPET="$INSTALL_ROOT/DELvEKBot/server/apache-delvek.bot.conf"

if [[ -f "$SITE_AVAIL" ]]; then
  if ! grep -q 'ProxyPass /api/' "$SITE_AVAIL"; then
    a2enmod proxy proxy_http
    # Insert proxy directives before </VirtualHost> of SSL site.
    cp "$SITE_AVAIL" "${SITE_AVAIL}.bak.$(date +%s)"
    python3 - <<'PY'
from pathlib import Path
path = Path("/etc/apache2/sites-available/delvek.bot-le-ssl.conf")
text = path.read_text()
snippet = """
    ProxyPreserveHost On
    ProxyPass /api/ http://127.0.0.1:8080/api/
    ProxyPassReverse /api/ http://127.0.0.1:8080/api/
    ProxyPass /health http://127.0.0.1:8080/health
    ProxyPassReverse /health http://127.0.0.1:8080/health
    LimitRequestBody 0
    ProxyTimeout 1800
"""
if "ProxyPass /api/" not in text:
    text = text.replace("</VirtualHost>", snippet + "\n</VirtualHost>", 1)
    path.write_text(text)
PY
  fi
elif [[ -f "$SITE_HTTP" ]]; then
  cp "$PROXY_SNIPPET" /etc/apache2/sites-available/delvek.bot.conf
  a2ensite delvek.bot.conf >/dev/null || true
else
  cp "$PROXY_SNIPPET" /etc/apache2/sites-available/delvek.bot.conf
  a2ensite delvek.bot.conf >/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now delvekbot-api
apache2ctl configtest
systemctl reload apache2

echo
echo "API health (local):"
curl -fsS http://127.0.0.1:8080/health || true
echo
echo "Worker token is in /etc/delvekbot.env — copy DECRYPT_WORKER_TOKEN to the phone .env"
echo "  DECRYPT_SITE_URL=https://delvek.bot/"
grep '^DECRYPT_WORKER_TOKEN=' /etc/delvekbot.env
