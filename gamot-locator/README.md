# PhilHealth GAMOT Package Providers — Locator

A web application to locate accredited **PhilHealth GAMOT Package providers**
(pharmacies, hospitals, and rural health units) across the Philippines, find
the nearest one to your current location, and get **turn-by-turn navigation**
to any provider.

The dataset contains **2,328 accredited providers** (CY 2026), extracted from
the official PhilHealth GAMOT provider list and geocoded with coordinates.

---

## Features

- 🗺️ Interactive map of all 2,328 providers (with marker clustering).
- 📍 **"Locate Me"** — uses the device GPS to find the nearest providers,
  sorted by distance.
- 🔍 **Search** by provider name, city/municipality, or province, plus
  filters for province, city, and sector (Private / Government).
- 🧭 **Turn-by-turn navigation** — select any provider and get a route with
  step-by-step directions, distance, and estimated travel time.
- 🏥 Provider details: name, address, contact number, email, accreditation
  expiry, and sector (Private P / Government G).
- 📱 Responsive layout for desktop and mobile.
- 🔐 **Admin portal** at `/admin` (not linked from the main site): website
  view counts (daily / weekly / monthly), a live chart, a realtime visitor
  table (IP address, approximate location, visit times), and administrator
  management.

---

## Tech stack

| Layer      | Technology                                              |
|------------|---------------------------------------------------------|
| Front-end  | Vanilla JavaScript + [Leaflet](https://leafletjs.com/) (bundled locally) |
| Back-end   | **Zero-dependency Node.js** HTTP server (`server.js`)   |
| Map tiles  | OpenStreetMap (primary) + CARTO (automatic fallback) — no API key required |
| Routing    | [OSRM](https://project-osrm.org/) (turn-by-turn)        |
| Data       | `data/providers.json` (2,328 geocoded providers)        |

There are **no npm dependencies** — the server uses only Node.js built-in
modules, so deployment does not require an `npm install` step.

---

## Project structure

```
gamot-locator/
├── server.js               # Node.js HTTP server (static + API + OSRM proxy)
├── package.json            # metadata & "npm start" script (no dependencies)
├── install.sh              # Ubuntu/Debian installer (systemd service)
├── data/
│   └── providers.json      # 2,328 providers with lat/lon
└── public/
    ├── index.html
    ├── admin.html          # admin portal (analytics dashboard)
    ├── css/style.css
    ├── css/admin.css
    ├── js/app.js           # map, search, geolocation, turn-by-turn logic
    ├── js/admin.js         # admin portal logic
    └── vendor/             # Leaflet + Leaflet.markercluster (bundled)
```

The server also writes runtime state (admin accounts, visit analytics,
sessions, IP geolocation cache) as JSON files under `DATA_DIR` — see
"Admin portal" below. These files are git-ignored.

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Health check (returns provider count) |
| `GET /api/providers` | All providers. Optional filters: `q`, `province`, `city`, `region`, `sector`, `limit` |
| `GET /api/route?from=lat,lon&to=lat,lon&profile=driving` | Turn-by-turn route (proxies to OSRM) |
| `GET /api/admin/status` | `{ setupRequired }` — is the first admin registered? |
| `POST /api/admin/register` | One-time first-admin registration (closed once an admin exists) |
| `POST /api/admin/login` / `logout` | Session sign-in / sign-out (HttpOnly cookie) |
| `GET /api/admin/me` | Current administrator (auth) |
| `GET /api/admin/admins` | List administrators (auth) |
| `GET /api/admin/stats` | Daily / weekly / monthly view counts + 14-day series (auth) |
| `GET /api/admin/visitors` | Realtime visitors with IP + location (auth) |
| `POST /api/admin/add-admin` | Add another administrator (auth) |

Examples:

```bash
curl "http://localhost:3000/api/providers?q=bangued"
curl "http://localhost:3000/api/providers?province=Cebu&sector=Government"
curl "http://localhost:3000/api/route?from=14.5995,120.9842&to=17.5965,120.6179"
```

---

## Quick start (development)

Requires Node.js ≥ 14 (Node 18/20 LTS recommended).

```bash
# From the project directory
node server.js
# or
npm start
```

Then open <http://localhost:3000>.

Environment variables:

| Variable  | Default                          | Description                    |
|-----------|----------------------------------|--------------------------------|
| `PORT`    | `3000`                           | HTTP port                      |
| `HOST`    | `0.0.0.0`                        | Bind address                   |
| `OSRM_URL`| `https://router.project-osrm.org`| Routing backend (see below)    |
| `DATA_DIR`| `./data`                         | Where admin/analytics/session state is persisted |

---

## Production install on Ubuntu

Run the bundled installer (it installs Node.js 20 LTS, copies the app to
`/opt/gamot-locator`, creates a dedicated system user, and sets up a systemd
service):

```bash
sudo bash install.sh
```

The service auto-starts on boot. Useful commands:

```bash
systemctl status gamot-locator      # check status
journalctl -u gamot-locator -f      # follow logs
sudo systemctl restart gamot-locator
```

Change the port or routing backend in `/etc/gamot-locator.env`, then restart.

### Optional: nginx reverse proxy (serve on port 80/443)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Enable HTTPS with `sudo apt install certbot python3-certbot-nginx` and
`sudo certbot --nginx`.

---

## Notes on the routing backend (OSRM)

By default the app uses the **free OSRM public demo server**
(`router.project-osrm.org`). It provides driving directions for the
Philippines and requires no API key. However, it is a *shared demo service*
with no uptime SLA and modest rate limits — suitable for light to moderate
use.

For heavy or production-critical use, self-host OSRM on your server:

```bash
# Example: self-host OSRM with a Philippines extract
# 1. Install OSRM (see https://github.com/Project-OSRM/osrm-backend)
# 2. Download a Philippines PBF, e.g. from Geofabrik:
wget https://download.geofabrik.de/asia/philippines-latest.osm.pbf
# 3. Preprocess:
osrm-extract -p /opt/car.lua philippines-latest.osm.pbf
osrm-partition philippines-latest.osrm
osrm-customize philippines-latest.osrm
# 4. Run:
osrm-routed --algorithm mld philippines-latest.osrm
```

Then set `OSRM_URL=http://127.0.0.1:5000` in `/etc/gamot-locator.env` and
restart the service.

> Self-hosting OSRM for the whole Philippines needs roughly 2–4 GB of RAM for
> the routing graph and several GB of disk for the PBF and preprocessed data.

---

## Data

`data/providers.json` is generated from the official PhilHealth GAMOT package
providers list (2,328 entries, updated as of May 31, 2026). Each record:

```json
{
  "id": 1,
  "name": "Assumpta Family Hospital",
  "tel": "0917-7997644 / 0917-1248089",
  "email": "assumptafamilyhospital0325@gmail.com",
  "street": "Magallanes St., Zone 5",
  "city": "Bangued",
  "province": "Abra",
  "region": "Cordillera Administrative Region (CAR)",
  "expire": "31/12/2027",
  "sector": "Private",
  "sector_code": "P",
  "lat": 17.596487,
  "lon": 120.61785
}
```

Coordinates are the **municipality/city center** for each provider (geocoded
via OpenStreetMap/Nominatim and Photon). Street-level precision is not
guaranteed for every entry; treat the map pin as the provider's locality.

---

## Admin portal

The portal lives at `/admin` and is **not linked from the main site** — reach
it directly, e.g. `https://your-domain.com/admin`.

**First-time setup.** On the first visit, `/admin` shows a one-time
registration form. Create the first administrator account (email + password
of at least 10 characters). Once an administrator exists, registration is
closed and subsequent visits show a sign-in form.

**What it shows** (after sign-in):

- **Views today / this week / this month** — counts of page loads of the main
  site, plus a 14-day bar chart.
- **Visitors online** — unique IP addresses seen in the last 5 minutes, with
  their approximate location (city / region / country, resolved server-side
  from a free IP-geolocation service) and their first/last-seen times.
- **Administrators** — list of accounts that can access the portal, plus a
  form to add more administrators.

**How it's secured** (no third-party dependencies):

- Passwords are hashed with Node's built-in **scrypt** (per-user salt).
- Sessions use a random 256-bit token in an **HttpOnly, SameSite=Lax** cookie
  (HMAC not needed — the token is an opaque lookup key stored server-side).
- State-changing endpoints require a custom `X-Requested-With` header
  (cross-site requests can't set it), on top of SameSite cookies.
- Rate limiting on login (10 / 5 min) and registration (5 / hour) to deter
  brute force.

**Where data is stored.** Admin accounts, visit analytics, sessions, and the
IP-geolocation cache are written as JSON files under `DATA_DIR`
(`/var/lib/gamot-locator` in production). This directory lives **outside**
`/opt/gamot-locator` so that redeploying with the installer (which runs
`rsync --delete`) never wipes your analytics or admin accounts, and it is
declared writable in the systemd unit (`ReadWritePaths`) despite
`ProtectSystem=full`.

> Privacy note: the portal stores visitor IP addresses and approximate
> locations for the last 90 days of visit records. Local / private IPs are
> labelled "Local network" and are never sent to a geolocation service.

---

## License

© 2026 Mikee Custodio. All rights reserved.

This software is **proprietary**. You may use and run this application for its
intended purpose, but you may **not** copy, reproduce, modify, distribute,
sublicense, or create derivative works from its source code without the
express written permission of the author, **Mikee Custodio**.

To request permission, contact the author directly.

Third-party components and data used by this application retain their own
licenses:

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- Provider data © PhilHealth
- [Leaflet](https://leafletjs.com/) (BSD-2-Clause)
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) (MIT)
