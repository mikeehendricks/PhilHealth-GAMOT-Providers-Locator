#!/usr/bin/env bash
#
# PhilHealth GAMOT Package Providers — Locator
# Ubuntu / Debian installation script.
#
# What it does:
#   1. Installs system dependencies (curl, ca-certificates) and Node.js 20 LTS.
#   2. Copies the application to /opt/gamot-locator.
#   3. Creates a dedicated system user.
#   4. Installs a systemd service so the app auto-starts on boot.
#   5. Prints the access URL and optional nginx/reverse-proxy guidance.
#
# Usage:
#   sudo bash install.sh
#
# The application has NO npm dependencies (it is a zero-dependency Node.js
# server), so there is no "npm install" step and nothing to download at
# deploy time beyond the Node.js runtime itself.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via environment variables)
# ---------------------------------------------------------------------------
APP_NAME="gamot-locator"
APP_DIR="/opt/${APP_NAME}"
APP_USER="${APP_NAME}"
APP_PORT="${PORT:-3000}"
# Persistent runtime data (admin accounts, analytics, sessions, geo cache).
# Kept OUTSIDE APP_DIR so `rsync --delete` on redeploy never wipes it, and it
# is a dedicated writable path for the hardened systemd unit (ProtectSystem=full).
DATA_DIR="/var/lib/${APP_NAME}"
# Routing backend. Defaults to the free OSRM demo server. For production you
# can point this at a self-hosted OSRM instance, e.g.:
#   OSRM_URL=http://127.0.0.1:5000
OSRM_URL="${OSRM_URL:-https://router.project-osrm.org}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✖\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  die "Please run as root:  sudo bash install.sh"
fi

# Detect OS
if ! command -v apt-get >/dev/null 2>&1; then
  die "This installer targets Debian/Ubuntu (apt). Detected a different system."
fi

# ---------------------------------------------------------------------------
# 1. Install Node.js 20 LTS
# ---------------------------------------------------------------------------
say "Installing system packages and Node.js 20 LTS…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y --no-install-recommends curl ca-certificates gnupg git >/dev/null

install_node() {
  # Use NodeSource's official setup script for Node 20.x
  if ! node --version 2>/dev/null | grep -qE '^v(1[6-9]|2[0-9])\.'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y --no-install-recommends nodejs >/dev/null
  fi
}

if command -v node >/dev/null 2>&1 && node --version 2>/dev/null | grep -qE '^v(1[6-9]|2[0-9])\.'; then
  ok "Node.js $(node --version) already installed (sufficient)."
else
  if install_node; then
    ok "Node.js $(node --version) installed."
  else
    # Fallback: distro packages (older but usually workable for this app)
    warn "NodeSource install failed; falling back to distro Node.js."
    apt-get install -y --no-install-recommends nodejs >/dev/null
    ok "Node.js $(node --version) installed from distro."
  fi
fi

# ---------------------------------------------------------------------------
# 2. Install application files
# ---------------------------------------------------------------------------
say "Installing application to ${APP_DIR}…"
if [ ! -f "${SRC_DIR}/server.js" ] || [ ! -f "${SRC_DIR}/data/providers.json" ]; then
  die "Could not find the application files in ${SRC_DIR} (expected server.js and data/providers.json)."
fi

mkdir -p "${APP_DIR}"
# Copy the app, excluding any stray dependency/test artifacts
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'test*.js' \
  "${SRC_DIR}/" "${APP_DIR}/" 2>/dev/null || {
  # rsync may not be installed; fall back to cp
  cp -a "${SRC_DIR}/." "${APP_DIR}/"
}
chown -R root:root "${APP_DIR}"

# ---------------------------------------------------------------------------
# 3. Create service user
# ---------------------------------------------------------------------------
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
  ok "Created system user '${APP_USER}'."
fi

# ---------------------------------------------------------------------------
# 3b. Persistent data directory
# ---------------------------------------------------------------------------
say "Creating persistent data directory ${DATA_DIR}…"
mkdir -p "${DATA_DIR}"
chown "${APP_USER}:${APP_USER}" "${DATA_DIR}"
chmod 750 "${DATA_DIR}"

# ---------------------------------------------------------------------------
# 4. Environment configuration
# ---------------------------------------------------------------------------
ENV_FILE="/etc/${APP_NAME}.env"
# Preserve optional SEO rank-tracking keys across redeploys (otherwise the
# regenerated env file would wipe them). Read them from the current file, if any.
if [ -f "${ENV_FILE}" ]; then
  for _k in GOOGLE_CSE_KEY GOOGLE_CSE_ID BING_API_KEY SEO_KEYWORDS SITE_DOMAIN; do
    _v="$(grep -E "^${_k}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    if [ -n "${_v}" ]; then
      export "${_k}=${_v}"
    fi
  done
fi

say "Writing environment configuration to ${ENV_FILE}…"
cat > "${ENV_FILE}" <<EOF
# PhilHealth GAMOT Locator configuration
PORT=${APP_PORT}
OSRM_URL=${OSRM_URL}
DATA_DIR=${DATA_DIR}

# Optional SEO rank tracking (see README "SEO rank tracking")
# Google Programmable Search: API key + search engine ID (cx)
GOOGLE_CSE_KEY=${GOOGLE_CSE_KEY:-}
GOOGLE_CSE_ID=${GOOGLE_CSE_ID:-}
# Bing Web Search API key
BING_API_KEY=${BING_API_KEY:-}
# Comma-separated keywords to track, and the site domain
SEO_KEYWORDS=${SEO_KEYWORDS:-PhilHealth Yakap,PhilHealth GAMOT,PhilHealth GAMOT providers}
SITE_DOMAIN=${SITE_DOMAIN:-yakap.dreampixelmedia.uk}
EOF
chmod 600 "${ENV_FILE}"

# ---------------------------------------------------------------------------
# 5. systemd service
# ---------------------------------------------------------------------------
UNIT="/etc/systemd/system/${APP_NAME}.service"
say "Installing systemd service…"
cat > "${UNIT}" <<EOF
[Unit]
Description=PhilHealth GAMOT Package Providers Locator
After=network.target
Wants=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/env node ${APP_DIR}/server.js
Restart=always
RestartSec=3
# Basic hardening
NoNewPrivileges=true
ProtectSystem=full
# The app is read-only under /opt; only the persistent data dir (and /tmp) are writable.
ReadWritePaths=${DATA_DIR} /tmp

[Install]
WantedBy=multi-user.target
EOF

HAVE_SYSTEMD=false
if [ -d /run/systemd/system ] || (command -v systemctl >/dev/null 2>&1 && systemctl --version >/dev/null 2>&1); then
  HAVE_SYSTEMD=true
fi

if [ "${HAVE_SYSTEMD}" = true ]; then
  systemctl daemon-reload
  systemctl enable "${APP_NAME}" >/dev/null 2>&1 || true
  systemctl restart "${APP_NAME}"
  sleep 2
else
  warn "systemd not detected — skipping service setup. Start manually with:"
  echo "    sudo -u ${APP_USER} env \$(cat ${ENV_FILE}) node ${APP_DIR}/server.js &"
fi

# ---------------------------------------------------------------------------
# 6. Verify + report
# ---------------------------------------------------------------------------
if curl -fsS "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null 2>&1; then
  ok "Service is running and healthy on port ${APP_PORT}."
elif [ "${HAVE_SYSTEMD}" = true ]; then
  warn "Service may not have started. Check: journalctl -u ${APP_NAME} -n 50"
fi

echo
say "Installation complete!"
echo "  Application : ${APP_DIR}"
echo "  Data        : ${DATA_DIR}"
echo "  Service     : systemctl status ${APP_NAME}"
echo "  Logs        : journalctl -u ${APP_NAME} -f"
echo "  Local URL   : http://$(hostname -I 2>/dev/null | awk '{print $1}'):${APP_PORT}"
echo "  Admin portal: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${APP_PORT}/admin"
echo
echo "To change the port or routing backend, edit ${ENV_FILE} and run:"
echo "  sudo systemctl restart ${APP_NAME}"
echo
echo "Optional — open the firewall port:"
echo "  sudo ufw allow ${APP_PORT}/tcp"
echo
echo "Optional — serve on port 80/443 via nginx reverse proxy (see README.md)."
