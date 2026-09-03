#!/usr/bin/env bash
set -euo pipefail
# Deploy the static locator to Ubuntu using nginx.
APP_DIR="${APP_DIR:-/var/www/gamot-locator}"
if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo ./install.sh"; exit 1; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Install the Ubuntu packages required by the static web app.
if [[ -x "$SCRIPT_DIR/install-ubuntu-dependencies.sh" ]]; then
  "$SCRIPT_DIR/install-ubuntu-dependencies.sh"
else
  apt-get update
  apt-get install -y nginx ca-certificates curl
fi
mkdir -p "$APP_DIR"
cp "$SCRIPT_DIR"/index.html "$SCRIPT_DIR"/style.css "$SCRIPT_DIR"/app.js "$APP_DIR"/
chown -R www-data:www-data "$APP_DIR"
cat > /etc/nginx/sites-available/gamot-locator <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root $APP_DIR;
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }
    location ~* \.(css|js|png|jpg|jpeg|gif|svg|ico)$ { expires 7d; add_header Cache-Control "public"; }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/gamot-locator /etc/nginx/sites-enabled/gamot-locator
nginx -t
systemctl enable --now nginx
systemctl reload nginx
echo "GAMOT locator installed at http://$(hostname -I | awk '{print $1}')"
echo "For GPS, serve over HTTPS in production (for example with certbot)."
