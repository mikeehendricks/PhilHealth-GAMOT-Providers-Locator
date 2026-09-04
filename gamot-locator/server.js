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
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const PROVIDERS_PATH = path.join(__dirname, 'data', 'providers.json');

// ---------------------------------------------------------------------------
// Security headers applied to every response
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' https://router.project-osrm.org https://tile.openstreetmap.org https://server.arcgisonline.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
};

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per IP + route bucket)
// ---------------------------------------------------------------------------
const rateBuckets = new Map(); // key -> { start, count }
const RATE_LIMITS = {
  route: { limit: 30, windowMs: 60 * 1000 },      // OSRM proxy — expensive, external call
  providers: { limit: 120, windowMs: 60 * 1000 }, // provider list search
};

function rateLimitHit(key, bucket) {
  const now = Date.now();
  let rec = rateBuckets.get(key);
  if (!rec || now - rec.start > bucket.windowMs) {
    rec = { start: now, count: 0 };
    rateBuckets.set(key, rec);
  }
  rec.count++;
  return rec.count > bucket.limit;
}

// Periodically purge stale rate-limit entries to avoid unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateBuckets) {
    if (now - rec.start > 120 * 1000) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

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
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  res.end(text);
}

function serveStatic(res, pathname, isHead) {
  // Prevent path traversal: resolve and confirm the result stays inside PUBLIC_DIR.
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If a non-file route is requested, fall back to index.html (SPA-ish behavior)
      if (err.code === 'ENOENT' && !path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) return sendText(res, 404, 'Not Found');
          res.writeHead(200, { 'Content-Type': MIME['.html'], ...SECURITY_HEADERS });
          res.end(isHead ? undefined : html);
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
      ...SECURITY_HEADERS,
    });
    res.end(isHead ? undefined : data);
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
  const q = (query.get('q') || '').slice(0, 200); // cap search length
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
  if (isNaN(limit) || limit < 0) limit = 0;
  limit = Math.min(limit, 500); // clamp to a sane maximum
  const total = list.length;
  if (limit > 0 && limit < list.length) list = list.slice(0, limit);

  sendJSON(res, 200, { total, count: list.length, providers: list });
}

// ---------------------------------------------------------------------------
// Routing proxy (OSRM) — tries a list of endpoints in order, returns JSON.
// ---------------------------------------------------------------------------
const ALLOWED_PROFILES = new Set(['driving', 'walking', 'cycling']);

function apiRoute(res, query) {
  const from = query.get('from'); // "lat,lon"
  const to = query.get('to'); // "lat,lon"
  const profile = (query.get('profile') || 'driving').toLowerCase();

  if (!from || !to) {
    sendJSON(res, 400, { error: 'Missing "from" or "to" parameters (lat,lon)' });
    return;
  }
  // Whitelist the profile to prevent path/query injection into the upstream URL.
  if (!ALLOWED_PROFILES.has(profile)) {
    sendJSON(res, 400, { error: 'Invalid profile. Use driving, walking, or cycling.' });
    return;
  }

  const NUM_RE = /^-?\d{1,3}(\.\d+)?$/;
  const parseCoord = (s) => {
    const parts = String(s).split(',');
    if (parts.length !== 2) return null;
    if (!NUM_RE.test(parts[0].trim()) || !NUM_RE.test(parts[1].trim())) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  };
  const f = parseCoord(from);
  const t = parseCoord(to);
  if (!f || !t) {
    sendJSON(res, 400, { error: 'Invalid coordinate format. Use lat,lon within valid ranges.' });
    return;
  }

  // OSRM expects lon,lat ordering
  const coords = `${f.lon},${f.lat};${t.lon},${t.lat}`;
  const path = `/route/v1/${profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=false`;

  // Endpoints to try, in order (primary + fallback mirror).
  const endpoints = [OSRM_URL, 'https://router.project-osrm.org'];

  const tryEndpoint = (idx) => {
    if (idx >= endpoints.length) {
      sendJSON(res, 502, { error: 'All routing services failed' });
      return;
    }
    const target = endpoints[idx].replace(/\/+$/, '') + path;
    let parsed;
    try {
      parsed = new URL(target);
    } catch (e) {
      sendJSON(res, 500, { error: 'Invalid routing endpoint configuration' });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(target, {
      headers: {
        'User-Agent': 'GAMOT-Locator/1.4.0',
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
          // Non-JSON (e.g. an HTML block page) — try the next endpoint.
          tryEndpoint(idx + 1);
          return;
        }
        res.writeHead(upstream.statusCode || 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify(json));
      });
    });
    req.on('error', () => tryEndpoint(idx + 1));
    req.setTimeout(15000, () => {
      req.destroy();
      tryEndpoint(idx + 1);
    });
  };

  tryEndpoint(0);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch (e) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (pathname === '/healthz' || pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', providers: loadProviders().length, uptime: process.uptime() });
    return;
  }

  if (pathname === '/api/providers') {
    const ip = clientIp(req);
    if (rateLimitHit(ip + ':providers', RATE_LIMITS.providers)) {
      sendJSON(res, 429, { error: 'Too many requests. Please slow down.' });
      return;
    }
    apiProviders(res, parsed.searchParams);
    return;
  }

  if (pathname === '/api/route') {
    const ip = clientIp(req);
    if (rateLimitHit(ip + ':route', RATE_LIMITS.route)) {
      sendJSON(res, 429, { error: 'Too many routing requests. Please slow down.' });
      return;
    }
    apiRoute(res, parsed.searchParams);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJSON(res, 404, { error: 'Unknown API endpoint' });
    return;
  }

  serveStatic(res, pathname, req.method === 'HEAD');
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
