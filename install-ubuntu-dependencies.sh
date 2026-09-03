#!/usr/bin/env bash
# Install the Ubuntu packages required to serve the GAMOT locator.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo ./install-ubuntu-dependencies.sh"
  exit 1
fi

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *ubuntu* ]]; then
    echo "This script supports Ubuntu (detected: ${PRETTY_NAME:-unknown})." >&2
    exit 1
  fi
fi

echo "Installing web server and runtime dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  nginx \
  ca-certificates \
  curl \
  ufw

systemctl enable nginx
systemctl start nginx

# HTTP is needed for the initial deployment. HTTPS can be added later with Certbot.
ufw allow 'Nginx HTTP' >/dev/null 2>&1 || true

echo "Ubuntu dependencies installed successfully."
echo "Installed: nginx, ca-certificates, curl, ufw"
