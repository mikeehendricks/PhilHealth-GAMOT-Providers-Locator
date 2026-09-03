# PhilHealth GAMOT Package Providers Locator

A responsive, dependency-light provider locator built with HTML, CSS, and vanilla JavaScript. It includes provider search by name/city/province, category filters, browser GPS sorting, Leaflet maps, and OSRM turn-by-turn driving directions.

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

GPS requires `https://` or localhost. Map tiles and routing use OpenStreetMap and the public OSRM demo service; for production, use a hosted routing provider or your own OSRM instance and follow their usage policies.

## Ubuntu deployment

```bash
chmod +x install.sh install-ubuntu-dependencies.sh
sudo ./install.sh
```

If you only need the Ubuntu dependencies, run:

```bash
sudo ./install-ubuntu-dependencies.sh
```

The dependency script installs nginx, CA certificates, curl, and ufw, then starts nginx.

The script installs nginx, copies the app to `/var/www/gamot-locator`, configures the default virtual host, and starts nginx. Add HTTPS for production because browser geolocation is restricted to secure contexts. Replace the sample `providers` array in `app.js` with the official PhilHealth directory before launch; provider data in this demo is illustrative.
