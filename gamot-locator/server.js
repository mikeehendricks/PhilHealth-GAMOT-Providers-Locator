#!/usr/bin/env node
/**
 * PhilHealth GAMOT Package Providers — Locator
 * Zero-dependency Node.js server (no npm install required).
 *
 *   - Serves the static front-end from ./public
 *   - GET  /api/providers   -> full provider list (?q, ?province, ?city, ?region, ?limit)
 *   - GET  /api/route       -> proxies routing to OSRM (turn-by-turn navigation)
 *   - GET  /healthz         -> health check
 *   - GET  /admin           -> admin portal (analytics + visitor tracking)
 *
 *   Admin / analytics API (all under /api/admin/*):
 *     GET  /api/admin/status      -> { setupRequired } (is an admin registered?)
 *     POST /api/admin/register    -> one-time first-admin registration
 *     POST /api/admin/login       -> session cookie
 *     POST /api/admin/logout
 *     GET  /api/admin/me          -> current admin (auth)
 *     GET  /api/admin/stats       -> daily/weekly/monthly view counts (auth)
 *     GET  /api/admin/visitors    -> realtime visitors w/ IP + geolocation (auth)
 *     POST /api/admin/add-admin   -> add another administrator (auth)
 *
 * Environment variables:
 *   PORT      (default 3000)
 *   OSRM_URL  (default https://router.project-osrm.org)
 *   DATA_DIR  (default ./data) — where admins/analytics/sessions are persisted
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const PROVIDERS_PATH = path.join(__dirname, 'data', 'providers.json');
const RUNTIME_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

const ADMIN_FILE = path.join(RUNTIME_DIR, 'admins.json');
const ANALYTICS_FILE = path.join(RUNTIME_DIR, 'analytics.json');
const SESSIONS_FILE = path.join(RUNTIME_DIR, 'sessions.json');
const GEO_CACHE_FILE = path.join(RUNTIME_DIR, 'geo-cache.json');

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
    "script-src 'self' 'sha256-Y4+FWJO8ffamxjS+Nxzn0y18E8SyoO23BYikjQel8Jk=' 'sha256-HKD65T3BYNLVOmIKhHih6GnYzwEWrImDN/kRYG2+VRg='",
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
const rateBuckets = new Map();
const RATE_LIMITS = {
  route: { limit: 30, windowMs: 60 * 1000 },
  providers: { limit: 120, windowMs: 60 * 1000 },
  login: { limit: 10, windowMs: 5 * 60 * 1000 },      // brute-force protection
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
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

setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateBuckets) {
    if (now - rec.start > 120 * 1000) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https';
  return false;
}

// ---------------------------------------------------------------------------
// Persistence (admins, analytics, sessions, geo-cache)
// ---------------------------------------------------------------------------
function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    ensureRuntimeDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('Failed to persist', file, ':', e.message);
  }
}

// ---- Admins ----
let admins = readJSON(ADMIN_FILE, []); // [{ email, salt, hash, role, createdAt }]

// ---- Analytics ----
let analytics = readJSON(ANALYTICS_FILE, { visits: [] }); // { visits: [{ip, ts, path, ua, referer, geo|null}] }
if (!Array.isArray(analytics.visits)) analytics.visits = [];

// ---- Sessions ----
let sessions = readJSON(SESSIONS_FILE, {}); // token -> { email, expiresAt }
for (const [tok, s] of Object.entries(sessions)) {
  if (!s || s.expiresAt < Date.now()) delete sessions[tok];
}

// ---- Geo cache ----
let geoCache = readJSON(GEO_CACHE_FILE, {}); // ip -> {city, region, country, lat, lon}

const ACTIVE_IPS = new Map(); // ip -> lastSeen ts (in-memory only)

const VISIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // keep 90 days

function flushAll() {
  // prune old visits to bound the file size
  const cutoff = Date.now() - VISIT_RETENTION_MS;
  analytics.visits = analytics.visits.filter((v) => v.ts >= cutoff);
  writeJSON(ADMIN_FILE, admins);
  writeJSON(ANALYTICS_FILE, analytics);
  writeJSON(SESSIONS_FILE, sessions);
  writeJSON(GEO_CACHE_FILE, geoCache);
}

setInterval(flushAll, 30 * 1000).unref();
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// ---------------------------------------------------------------------------
// Visit tracking
// ---------------------------------------------------------------------------
const GEO_PENDING = new Set();
const GEO_QUEUE = [];
let geoProcessing = false;

function isPrivateIp(ip) {
  if (!ip || ip === 'unknown') return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.')) return true;
  return false;
}

function trackVisit(req, pathname) {
  const ip = clientIp(req);
  const now = Date.now();
  ACTIVE_IPS.set(ip, now);

  // Only count actual page loads of the main site (not assets, API, or /admin)
  const isPageView = pathname === '/' || pathname === '/index.html';
  if (!isPageView) return;

  analytics.visits.push({
    ip,
    ts: now,
    path: pathname,
    ua: String(req.headers['user-agent'] || '').slice(0, 300),
    referer: String(req.headers['referer'] || '').slice(0, 300),
    geo: null,
  });

  queueGeolocate(ip);
}

function queueGeolocate(ip) {
  if (isPrivateIp(ip)) {
    geoCache[ip] = { city: 'Local network', region: '', country: 'Local', lat: null, lon: null };
    return;
  }
  if (geoCache[ip] || GEO_PENDING.has(ip)) return;
  GEO_PENDING.add(ip);
  GEO_QUEUE.push(ip);
  processGeoQueue();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processGeoQueue() {
  if (geoProcessing) return;
  geoProcessing = true;
  while (GEO_QUEUE.length) {
    const ip = GEO_QUEUE.shift();
    try {
      const g = await geolocateIp(ip);
      if (g) {
        geoCache[ip] = g;
        for (const v of analytics.visits) {
          if (v.ip === ip && !v.geo) v.geo = g;
        }
      }
    } catch (e) {
      /* ignore individual lookup failures */
    }
    GEO_PENDING.delete(ip);
    await sleep(250); // rate-limit courtesy between lookups
  }
  geoProcessing = false;
}

// ---------------------------------------------------------------------------
// IP geolocation (multiple free, no-key providers, server-side)
// ---------------------------------------------------------------------------
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'GAMOT-Locator/1.6.0', Accept: 'application/json' },
      timeout: timeoutMs || 4000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function geolocateIp(ip) {
  // Provider 1: ipwho.is (free, HTTPS, no key)
  try {
    const d = await httpGetJson('https://ipwho.is/' + encodeURIComponent(ip), 4000);
    if (d && d.success !== false && d.country) {
      return {
        city: d.city || '', region: d.region || '', country: d.country || '',
        lat: typeof d.latitude === 'number' ? d.latitude : null,
        lon: typeof d.longitude === 'number' ? d.longitude : null,
      };
    }
  } catch (e) { /* fall through */ }

  // Provider 2: ip-api.com (free, HTTP only, no key)
  try {
    const d = await httpGetJson(
      'http://ip-api.com/json/' + encodeURIComponent(ip) +
      '?fields=status,message,country,regionName,city,lat,lon', 4000);
    if (d && d.status === 'success') {
      return {
        city: d.city || '', region: d.regionName || '', country: d.country || '',
        lat: typeof d.lat === 'number' ? d.lat : null,
        lon: typeof d.lon === 'number' ? d.lon : null,
      };
    }
  } catch (e) { /* fall through */ }

  // Provider 3: ipapi.co (free, HTTPS, no key)
  try {
    const d = await httpGetJson('https://ipapi.co/' + encodeURIComponent(ip) + '/json/', 4000);
    if (d && !d.error && d.country_name) {
      return {
        city: d.city || '', region: d.region || '', country: d.country_name || '',
        lat: typeof d.latitude === 'number' ? d.latitude : null,
        lon: typeof d.longitude === 'number' ? d.longitude : null,
      };
    }
  } catch (e) { /* fall through */ }

  return null;
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt) & sessions
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
  } catch (e) {
    return false;
  }
}

function createSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  sessions[token] = { email, expiresAt };
  // bound number of sessions
  const keys = Object.keys(sessions);
  if (keys.length > 500) {
    keys.sort((a, b) => (sessions[a].expiresAt || 0) - (sessions[b].expiresAt || 0));
    for (let i = 0; i < keys.length - 500; i++) delete sessions[keys[i]];
  }
  return token;
}

function setSessionCookie(res, token, req) {
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `gamot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'gamot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function getSessionEmail(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)gamot_session=([^;]+)/.exec(cookie);
  if (!m) return null;
  const token = m[1];
  const s = sessions[token];
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    delete sessions[token];
    return null;
  }
  return s.email;
}

// ---------------------------------------------------------------------------
// HTTP helpers
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
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
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

function sendFile(res, filePath, cacheControl) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl || 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (maxBytes || 100000)) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
function serveStatic(res, pathname, isHead) {
  let rel = pathname.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' && !path.extname(filePath)) {
        sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
        return;
      }
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    let cacheControl;
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.mjs') {
      cacheControl = 'no-cache, no-store, must-revalidate';
    } else {
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
  const q = (query.get('q') || '').slice(0, 200);
  const province = query.get('province');
  const city = query.get('city');
  const region = query.get('region');
  const sector = query.get('sector');

  if (q) {
    const needle = norm(q);
    list = list.filter((p) =>
      norm(p.name).includes(needle) || norm(p.city).includes(needle) ||
      norm(p.province).includes(needle) || norm(p.region).includes(needle) ||
      norm(p.street).includes(needle));
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
  limit = Math.min(limit, 500);
  const total = list.length;
  if (limit > 0 && limit < list.length) list = list.slice(0, limit);

  sendJSON(res, 200, { total, count: list.length, providers: list });
}

// ---------------------------------------------------------------------------
// Routing proxy (OSRM)
// ---------------------------------------------------------------------------
const ALLOWED_PROFILES = new Set(['driving', 'walking', 'cycling']);

function apiRoute(res, query) {
  const from = query.get('from');
  const to = query.get('to');
  const profile = (query.get('profile') || 'driving').toLowerCase();

  if (!from || !to) {
    sendJSON(res, 400, { error: 'Missing "from" or "to" parameters (lat,lon)' });
    return;
  }
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

  const coords = `${f.lon},${f.lat};${t.lon},${t.lat}`;
  const path = `/route/v1/${profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=false`;
  const endpoints = [OSRM_URL, 'https://router.project-osrm.org'];

  const tryEndpoint = (idx) => {
    if (idx >= endpoints.length) {
      sendJSON(res, 502, { error: 'All routing services failed' });
      return;
    }
    const target = endpoints[idx].replace(/\/+$/, '') + path;
    let parsed;
    try { parsed = new URL(target); } catch (e) {
      sendJSON(res, 500, { error: 'Invalid routing endpoint configuration' });
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(target, {
      headers: { 'User-Agent': 'GAMOT-Locator/1.6.0', Accept: 'application/json' },
    }, (upstream) => {
      let body = '';
      upstream.on('data', (chunk) => (body += chunk));
      upstream.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch (e) {
          tryEndpoint(idx + 1);
          return;
        }
        res.writeHead(upstream.statusCode || 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify(json));
      });
    });
    req.on('error', () => tryEndpoint(idx + 1));
    req.setTimeout(15000, () => { req.destroy(); tryEndpoint(idx + 1); });
  };

  tryEndpoint(0);
}

// ---------------------------------------------------------------------------
// Admin / analytics API
// ---------------------------------------------------------------------------
function requireAuth(req, res) {
  const email = getSessionEmail(req);
  if (!email) {
    sendJSON(res, 401, { error: 'Not authenticated' });
    return null;
  }
  const admin = admins.find((a) => a.email === email);
  if (!admin) {
    sendJSON(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return admin;
}

// CSRF guard for state-changing endpoints: require a custom header that a
// cross-site form cannot set (combined with SameSite=Lax cookies).
function hasCsrfHeader(req) {
  return req.headers['x-requested-with'] === 'gamot-admin';
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function apiAdminStatus(res) {
  sendJSON(res, 200, { setupRequired: admins.length === 0 });
}

async function apiAdminRegister(req, res) {
  if (admins.length > 0) {
    sendJSON(res, 403, { error: 'Registration is closed. An administrator already exists.' });
    return;
  }
  if (!hasCsrfHeader(req)) { sendJSON(res, 403, { error: 'Forbidden' }); return; }

  const ip = clientIp(req);
  if (rateLimitHit(ip + ':register', RATE_LIMITS.register)) {
    sendJSON(res, 429, { error: 'Too many attempts. Please try again later.' });
    return;
  }

  const body = parseJsonBody(await readBody(req, 10000));
  if (!body) { sendJSON(res, 400, { error: 'Invalid request body' }); return; }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!VALID_EMAIL.test(email)) { sendJSON(res, 400, { error: 'Please enter a valid email address.' }); return; }
  if (password.length < 10) { sendJSON(res, 400, { error: 'Password must be at least 10 characters.' }); return; }

  const { salt, hash } = hashPassword(password);
  admins.push({ email, salt, hash, role: 'admin', createdAt: Date.now() });
  flushAll();

  const token = createSession(email);
  setSessionCookie(res, token, req);
  sendJSON(res, 200, { ok: true, email });
}

async function apiAdminLogin(req, res) {
  if (!hasCsrfHeader(req)) { sendJSON(res, 403, { error: 'Forbidden' }); return; }

  const ip = clientIp(req);
  if (rateLimitHit(ip + ':login', RATE_LIMITS.login)) {
    sendJSON(res, 429, { error: 'Too many login attempts. Please try again later.' });
    return;
  }

  const body = parseJsonBody(await readBody(req, 10000));
  if (!body) { sendJSON(res, 400, { error: 'Invalid request body' }); return; }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const admin = admins.find((a) => a.email === email);
  if (!admin || !verifyPassword(password, admin.salt, admin.hash)) {
    sendJSON(res, 401, { error: 'Invalid email or password.' });
    return;
  }

  const token = createSession(email);
  setSessionCookie(res, token, req);
  sendJSON(res, 200, { ok: true, email });
}

function apiAdminLogout(req, res) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)gamot_session=([^;]+)/.exec(cookie);
  if (m) delete sessions[m[1]];
  clearSessionCookie(res);
  sendJSON(res, 200, { ok: true });
}

function apiAdminMe(req, res) {
  const admin = requireAuth(req, res);
  if (!admin) return;
  sendJSON(res, 200, { email: admin.email, role: admin.role, createdAt: admin.createdAt });
}

function apiAdminList(req, res) {
  const admin = requireAuth(req, res);
  if (!admin) return;
  // never expose password hashes / salts
  const list = admins.map((a) => ({ email: a.email, role: a.role, createdAt: a.createdAt }));
  sendJSON(res, 200, { admins: list });
}

// daily / weekly / monthly view counts
function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function apiAdminStats(req, res) {
  const admin = requireAuth(req, res);
  if (!admin) return;

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

  let daily = 0, weekly = 0, monthly = 0;
  const byDay = new Map();

  // build the last-14-days bucket keys
  const bucketKeys = [];
  for (let i = 13; i >= 0; i--) {
    bucketKeys.push(localDayKey(now - i * dayMs));
  }
  for (const k of bucketKeys) byDay.set(k, 0);

  for (const v of analytics.visits) {
    const age = now - v.ts;
    if (age <= dayMs) daily++;
    if (age <= 7 * dayMs) weekly++;
    if (age <= 30 * dayMs) monthly++;
    if (v.ts >= startOfToday - 13 * dayMs) {
      const key = localDayKey(v.ts);
      if (byDay.has(key)) byDay.set(key, byDay.get(key) + 1);
    }
  }

  sendJSON(res, 200, {
    daily, weekly, monthly,
    total: analytics.visits.length,
    byDay: bucketKeys.map((k) => ({ date: k, count: byDay.get(k) || 0 })),
    updatedAt: now,
  });
}

// realtime visitors (unique IPs active in the last 5 minutes)
function apiAdminVisitors(req, res) {
  const admin = requireAuth(req, res);
  if (!admin) return;

  const now = Date.now();
  const ONLINE_WINDOW = 5 * 60 * 1000;

  // aggregate per-IP from active sessions + visit history
  const perIp = new Map();
  const activeIps = new Set();
  for (const [ip, lastSeen] of ACTIVE_IPS) {
    if (now - lastSeen <= ONLINE_WINDOW) activeIps.add(ip);
  }

  for (const v of analytics.visits) {
    const rec = perIp.get(v.ip) || { ip: v.ip, firstSeen: v.ts, lastSeen: v.ts, views: 0, geo: null };
    if (v.ts < rec.firstSeen) rec.firstSeen = v.ts;
    if (v.ts > rec.lastSeen) rec.lastSeen = v.ts;
    rec.views++;
    if (!rec.geo && v.geo) rec.geo = v.geo;
    perIp.set(v.ip, rec);
  }

  // include IPs that are active but may have no stored visit yet
  for (const ip of activeIps) {
    if (!perIp.has(ip)) {
      perIp.set(ip, { ip, firstSeen: now, lastSeen: now, views: 0, geo: geoCache[ip] || null });
    }
  }

  const visitors = [...perIp.values()]
    .filter((r) => activeIps.has(r.ip))
    .map((r) => {
      const g = r.geo || geoCache[r.ip] || null;
      const online = now - r.lastSeen <= ONLINE_WINDOW;
      return {
        ip: r.ip,
        city: g ? g.city : '',
        region: g ? g.region : '',
        country: g ? g.country : '',
        lat: g ? g.lat : null,
        lon: g ? g.lon : null,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        views: r.views,
        online,
        isLocal: isPrivateIp(r.ip),
      };
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  sendJSON(res, 200, { online: visitors.length, windowMs: ONLINE_WINDOW, visitors, updatedAt: now });
}

async function apiAdminAddAdmin(req, res) {
  const admin = requireAuth(req, res);
  if (!admin) return;
  if (!hasCsrfHeader(req)) { sendJSON(res, 403, { error: 'Forbidden' }); return; }

  const body = parseJsonBody(await readBody(req, 10000));
  if (!body) { sendJSON(res, 400, { error: 'Invalid request body' }); return; }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!VALID_EMAIL.test(email)) { sendJSON(res, 400, { error: 'Please enter a valid email address.' }); return; }
  if (password.length < 10) { sendJSON(res, 400, { error: 'Password must be at least 10 characters.' }); return; }
  if (admins.some((a) => a.email === email)) {
    sendJSON(res, 409, { error: 'An administrator with that email already exists.' });
    return;
  }

  const { salt, hash } = hashPassword(password);
  admins.push({ email, salt, hash, role: 'admin', createdAt: Date.now() });
  flushAll();
  sendJSON(res, 200, { ok: true, email });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
async function handle(req, res) {
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

  trackVisit(req, pathname);

  const method = req.method || 'GET';

  // ---- Admin portal page ----
  if (pathname === '/admin' || pathname === '/admin/') {
    if (method === 'GET' || method === 'HEAD') {
      fs.readFile(path.join(PUBLIC_DIR, 'admin.html'), (err, data) => {
        if (err) return sendText(res, 404, 'Not Found');
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          ...SECURITY_HEADERS,
        });
        res.end(method === 'HEAD' ? undefined : data);
      });
    } else {
      sendJSON(res, 405, { error: 'Method not allowed' });
    }
    return;
  }

  // ---- Admin API ----
  if (pathname.startsWith('/api/admin/')) {
    const endpoint = pathname.slice('/api/admin'.length);
    if (method === 'POST') {
      if (endpoint === '/register') return apiAdminRegister(req, res);
      if (endpoint === '/login') return apiAdminLogin(req, res);
      if (endpoint === '/logout') return apiAdminLogout(req, res);
      if (endpoint === '/add-admin') return apiAdminAddAdmin(req, res);
      sendJSON(res, 404, { error: 'Unknown API endpoint' });
      return;
    }
    if (method === 'GET') {
      if (endpoint === '/status') return apiAdminStatus(res);
      if (endpoint === '/me') return apiAdminMe(req, res);
      if (endpoint === '/admins') return apiAdminList(req, res);
      if (endpoint === '/stats') return apiAdminStats(req, res);
      if (endpoint === '/visitors') return apiAdminVisitors(req, res);
      sendJSON(res, 404, { error: 'Unknown API endpoint' });
      return;
    }
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  // ---- Health ----
  if (pathname === '/healthz' || pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', providers: loadProviders().length, uptime: process.uptime() });
    return;
  }

  // ---- Providers ----
  if (pathname === '/api/providers') {
    if (method !== 'GET' && method !== 'HEAD') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
    const ip = clientIp(req);
    if (rateLimitHit(ip + ':providers', RATE_LIMITS.providers)) {
      sendJSON(res, 429, { error: 'Too many requests. Please slow down.' });
      return;
    }
    apiProviders(res, parsed.searchParams);
    return;
  }

  // ---- Route ----
  if (pathname === '/api/route') {
    if (method !== 'GET' && method !== 'HEAD') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
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

  if (method !== 'GET' && method !== 'HEAD') {
    sendJSON(res, 405, { error: 'Method not allowed' });
    return;
  }

  serveStatic(res, pathname, method === 'HEAD');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
ensureRuntimeDir();
try {
  loadProviders();
  console.log(`Loaded ${providers.length} GAMOT providers.`);
} catch (e) {
  console.error('Failed to load providers.json:', e.message);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('Unhandled request error:', err);
    try { sendJSON(res, 500, { error: 'Internal server error' }); } catch (e) { /* ignore */ }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`GAMOT Locator listening on http://${HOST}:${PORT}`);
  console.log(`Runtime data directory: ${RUNTIME_DIR}`);
  console.log(`Admin portal: /admin  (setup required: ${admins.length === 0})`);
  console.log(`Routing via OSRM: ${OSRM_URL}`);
});
