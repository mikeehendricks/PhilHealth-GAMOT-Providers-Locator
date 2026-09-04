#!/usr/bin/env node
/**
 * PhilHealth GAMOT Package Providers — Locator
 * Zero-dependency Node.js server (no npm install required).
 *
 *   - Serves the static front-end from ./public
 *   - GET /api/providers            -> full provider list (supports ?q, ?province, ?city, ?region, ?limit)
 *   - GET /api/route                -> proxies routing to OSRM (turn-by-turn navigation)
 *   - GET /healthz                  -> health check
 *
 * Environment variables:
 *   PORT      (default 3000)
 *   OSRM_URL  (default https://router.project-osrm.org)  — override to use a self-hosted OSRM
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROVIDERS_PATH = path.join(__dirname, 'data', 'providers.json');

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveStatic(res, pathname) {
  // Prevent path traversal
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If a non-file route is requested, fall back to index.html (SPA-ish behavior)
      if (err.code === 'ENOENT' && !path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) return sendText(res, 404, 'Not Found');
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
        return;
      }
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    let cacheControl;
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.mjs') {
      // HTML/JS/CSS should never be stale-cached (esp. behind a CDN like
      // Cloudflare) so code updates propagate immediately.
      cacheControl = 'no-cache, no-store, must-revalidate';
    } else {
      // Static media (images, fonts) can be cached aggressively.
      cacheControl = 'public, max-age=604800, immutable';
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Data / providers
// ---------------------------------------------------------------------------
let providers = null;
function loadProviders() {
  if (!providers) {
    const raw = fs.readFileSync(PROVIDERS_PATH, 'utf8');
    providers = JSON.parse(raw);
  }
  return providers;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/ñ/g, 'n').trim();
}

function apiProviders(res, query) {
  let list = loadProviders();
  const q = query.get('q');
  const province = query.get('province');
  const city = query.get('city');
  const region = query.get('region');
  const sector = query.get('sector');

  if (q) {
    const needle = norm(q);
    list = list.filter((p) => {
      return (
        norm(p.name).includes(needle) ||
        norm(p.city).includes(needle) ||
        norm(p.province).includes(needle) ||
        norm(p.region).includes(needle) ||
        norm(p.street).includes(needle)
      );
    });
  }
  if (province) {
    const pv = norm(province);
    list = list.filter((p) => norm(p.province) === pv || norm(p.province).includes(pv));
  }
  if (city) {
    const ct = norm(city);
    list = list.filter((p) => norm(p.city) === ct || norm(p.city).includes(ct));
  }
  if (region) {
    const rg = norm(region);
    list = list.filter((p) => norm(p.region).includes(rg));
  }
  if (sector) {
    const sc = norm(sector);
    list = list.filter((p) => norm(p.sector).startsWith(sc) || norm(p.sector_code) === sc);
  }

  let limit = parseInt(query.get('limit') || '0', 10);
  const total = list.length;
  if (limit > 0 && limit < list.length) list = list.slice(0, limit);

  sendJSON(res, 200, { total, count: list.length, providers: list });
}

// ---------------------------------------------------------------------------
// Routing proxy (OSRM)
// ---------------------------------------------------------------------------
function apiRoute(res, query) {
  const from = query.get('from'); // "lat,lon"
  const to = query.get('to'); // "lat,lon"
  const profile = query.get('profile') || 'driving';

  if (!from || !to) {
    sendJSON(res, 400, { error: 'Missing "from" or "to" parameters (lat,lon)' });
    return;
  }

  const parseCoord = (s) => {
    const parts = s.split(',').map((x) => parseFloat(x));
    if (parts.length !== 2 || parts.some((x) => isNaN(x))) return null;
    return { lat: parts[0], lon: parts[1] };
  };
  const f = parseCoord(from);
  const t = parseCoord(to);
  if (!f || !t) {
    sendJSON(res, 400, { error: 'Invalid coordinate format. Use lat,lon' });
    return;
  }

  // OSRM expects lon,lat ordering
  const coords = `${f.lon},${f.lat};${t.lon},${t.lat}`;
  const target = `${OSRM_URL}/route/v1/${profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=false`;

  const parsed = new URL(target);
  const lib = parsed.protocol === 'https:' ? https : http;

  const req = lib.get(target, {
    headers: {
      'User-Agent': 'GAMOT-Locator/1.0',
      Accept: 'application/json',
    },
  }, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      let json;
      try {
        json = JSON.parse(body);
      } catch (e) {
        sendJSON(res, 502, { error: 'Upstream routing service returned invalid data', detail: body.slice(0, 300) });
        return;
      }
      res.writeHead(upstream.statusCode || 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(json));
    });
  });
  req.on('error', (err) => {
    sendJSON(res, 502, { error: 'Failed to reach routing service', detail: err.message });
  });
  req.setTimeout(30000, () => {
    req.destroy();
    sendJSON(res, 504, { error: 'Routing service timed out' });
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
function handle(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsed.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/healthz' || pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', providers: loadProviders().length, uptime: process.uptime() });
    return;
  }

  if (pathname === '/api/providers') {
    apiProviders(res, parsed.searchParams);
    return;
  }

  if (pathname === '/api/route') {
    apiRoute(res, parsed.searchParams);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJSON(res, 404, { error: 'Unknown API endpoint' });
    return;
  }

  serveStatic(res, pathname);
}

const server = http.createServer(handle);

// Warm the providers cache on start so the first request is fast
try {
  loadProviders();
  console.log(`Loaded ${providers.length} GAMOT providers.`);
} catch (e) {
  console.error('Failed to load providers.json:', e.message);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`GAMOT Locator listening on http://${HOST}:${PORT}`);
  console.log(`Routing via OSRM: ${OSRM_URL}`);
});
