/* =========================================================================
 * PhilHealth GAMOT Package Providers — Locator
 * Front-end application logic (no build step, plain ES6).
 * ========================================================================= */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  providers: [],       // all providers
  map: null,
  cluster: null,       // marker cluster of all providers
  markersById: {},     // provider id -> Leaflet marker (for popups/highlight)
  userPos: null,       // { lat, lon, accuracy }
  userMarker: null,
  userAccuracy: null,  // accuracy circle layer
  routeLayer: null,    // L.LayerGroup for the active route
  routeSteps: [],      // parsed steps for turn-by-turn
  watchId: null,
  selectedId: null,
};

const PH_CENTER = [12.8797, 121.7740];
const PH_BOUNDS = L.latLngBounds([4.5, 116.5], [21.5, 127.5]);

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  if (m == null || isNaN(m)) return '';
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(1) + ' km';
}

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return mins + ' min';
  const h = Math.floor(mins / 60);
  const mm = mins % 60;
  return h + ' hr ' + (mm ? mm + ' min' : '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
async function init() {
  initMap();
  try {
    const res = await fetch('/api/providers');
    const data = await res.json();
    state.providers = data.providers || [];
  } catch (err) {
    toast('Could not load provider data. Is the server running?', 'error');
    $('loading').hidden = true;
    return;
  }
  buildProvinceSelect();
  buildCitySelect('');
  addAllMarkers();
  updateResultsCount();
  $('loading').hidden = true;
}

// ---------------------------------------------------------------------------
// Basemap tiles — every provider below is 100% free and requires NO API key.
// OSM is primary; Esri is the automatic fallback if OSM tiles fail to load.
// NOTE: CARTO was removed entirely — it returns HTTP 200 "API key required"
// watermark tiles that cannot be detected as errors.
// ---------------------------------------------------------------------------
const APP_VERSION = "1.4.1";

// Classic teardrop "location pin" for the user's real-time position.
// Fuchsia so it never gets confused with the blue/green provider pins.
const USER_PIN_SVG =
  '<svg viewBox="0 0 24 34" width="30" height="42" aria-hidden="true">' +
  '<path d="M12 1C5.37 1 0 6.37 0 13c0 8.4 12 20 12 20s12-11.6 12-20C24 6.37 18.63 1 12 1z" ' +
  'fill="#d946ef" stroke="#ffffff" stroke-width="2"/>' +
  '<circle cx="12" cy="13" r="5" fill="#ffffff"/>' +
  '</svg>';

const TILE_PROVIDERS = [
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom',
    maxZoom: 19,
  },
  {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 19,
  },
];

function initBaseLayer() {
  let providerIndex = 0;
  let layer = null;
  let failStreak = 0;
  const MAX_STREAK = 3;

  const loadProvider = (i) => {
    if (i >= TILE_PROVIDERS.length) return;
    const p = TILE_PROVIDERS[i];
    if (layer) state.map.removeLayer(layer);
    layer = L.tileLayer(p.url, {
      attribution: p.attribution,
      maxZoom: p.maxZoom,
      maxNativeZoom: p.maxZoom,
    });
    layer.on('tileerror', () => {
      failStreak++;
      if (failStreak >= MAX_STREAK) {
        failStreak = 0;
        providerIndex++;
        loadProvider(providerIndex);
      }
    });
    // Reset the streak whenever a tile actually loads, so transient
    // network blips don't trigger a needless provider switch.
    layer.on('tileload', () => { failStreak = 0; });
    layer.addTo(state.map);
  };

  loadProvider(0);
}

function initMap() {
  state.map = L.map('map', {
    center: PH_CENTER,
    zoom: 6,
    minZoom: 5,
    maxZoom: 19,
    worldCopyJump: true,
  });
  state.map.setMaxBounds(PH_BOUNDS.pad(0.4));

  initBaseLayer();

  state.cluster = L.markerClusterGroup({
    maxClusterRadius: 48,
    disableClusteringAtZoom: 11,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true,
  });
  state.map.addLayer(state.cluster);
  state.routeLayer = L.layerGroup().addTo(state.map);
}

function providerMarker(p) {
  const isGov = p.sector_code === 'G';
  const icon = L.divIcon({
    className: 'provider-marker',
    html: `<span class="marker-dot ${isGov ? 'gov' : ''}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  const marker = L.marker([p.lat, p.lon], { icon, title: p.name });
  marker.bindPopup(popupHtml(p), { maxWidth: 280 });
  marker.on('click', () => { state.selectedId = p.id; });
  return marker;
}

function popupHtml(p) {
  const sectorTag = p.sector_code === 'G'
    ? '<span class="tag tag-G">Government</span>'
    : '<span class="tag tag-P">Private</span>';
  const exp = p.expire ? `<span class="tag tag-exp">Valid until ${escapeHtml(p.expire)}</span>` : '';
  const tel = p.tel ? `<div class="popup-addr">☎ ${escapeHtml(p.tel)}</div>` : '';
  const addr = [p.street, p.city, p.province].filter(Boolean).join(', ');
  return `
    <div class="popup-name">${escapeHtml(p.name)}</div>
    <div class="popup-addr">${escapeHtml(addr)}</div>
    ${tel}
    <div class="popup-tags">${sectorTag}${exp}</div>
    <div class="popup-actions">
      <button class="popup-dir" type="button" data-id="${p.id}">Directions</button>
    </div>`;
}

function addAllMarkers() {
  state.cluster.clearLayers();
  state.markersById = {};
  for (const p of state.providers) {
    const m = providerMarker(p);
    state.markersById[p.id] = m;
    state.cluster.addLayer(m);
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function buildProvinceSelect() {
  const sel = $('province-select');
  const regions = {};
  for (const p of state.providers) {
    (regions[p.region] || (regions[p.region] = new Set())).add(p.province);
  }
  const frag = document.createDocumentFragment();
  for (const region of Object.keys(regions).sort()) {
    const og = document.createElement('optgroup');
    og.label = region;
    for (const prov of [...regions[region]].sort()) {
      const opt = document.createElement('option');
      opt.value = prov;
      opt.textContent = prov;
      og.appendChild(opt);
    }
    frag.appendChild(og);
  }
  sel.appendChild(frag);
}

function buildCitySelect(province) {
  const sel = $('city-select');
  sel.innerHTML = '<option value="">All cities</option>';
  const cities = new Set();
  for (const p of state.providers) {
    if (!province || p.province === province) cities.add(p.city);
  }
  for (const c of [...cities].sort()) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

function currentFilters() {
  return {
    q: $('search-input').value.trim().toLowerCase(),
    province: $('province-select').value,
    city: $('city-select').value,
    sector: $('sector-select').value,
  };
}

function filterProviders() {
  const { q, province, city, sector } = currentFilters();
  let list = state.providers;
  if (q) {
    list = list.filter((p) =>
      (p.name + ' ' + p.city + ' ' + p.province + ' ' + p.region + ' ' + p.street).toLowerCase().includes(q)
    );
  }
  if (province) list = list.filter((p) => p.province === province);
  if (city) list = list.filter((p) => p.city === city);
  if (sector) list = list.filter((p) => p.sector === sector);

  // Attach distance from user when known
  if (state.userPos) {
    for (const p of list) p._dist = haversineMeters(state.userPos, p);
    list = [...list].sort((a, b) => a._dist - b._dist);
  } else {
    for (const p of list) p._dist = null;
    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  }
  return list;
}

function renderResults() {
  const list = filterProviders();
  updateResultsCount(list.length);
  const ul = $('results-list');
  ul.innerHTML = '';
  $('results-empty').hidden = list.length > 0;

  const max = 120;
  const shown = list.slice(0, max);
  for (const p of shown) {
    const li = document.createElement('li');
    li.className = 'result-item';
    li.setAttribute('role', 'listitem');
    const dist = p._dist != null ? `<div class="result-distance">📍 ${formatDistance(p._dist)}</div>` : '';
    li.innerHTML = `
      <span class="result-badge badge-${p.sector_code}">${p.sector_code}</span>
      <div class="result-body">
        <div class="result-name">${escapeHtml(p.name)}</div>
        <div class="result-meta">${escapeHtml(p.city)}, ${escapeHtml(p.province)}</div>
        ${dist}
      </div>
      <div class="result-actions">
        <button class="mini-btn dir" type="button">Directions</button>
      </div>`;
    li.addEventListener('click', () => focusProvider(p.id));
    li.querySelector('.mini-btn.dir').addEventListener('click', (e) => {
      e.stopPropagation();
      startDirections(p.id);
    });
    ul.appendChild(li);
  }
  if (list.length > max) {
    const note = document.createElement('li');
    note.className = 'results-empty';
    note.style.padding = '8px';
    note.textContent = `Showing first ${max} of ${list.length} results. Refine your search.`;
    ul.appendChild(note);
  }
}

function updateResultsCount(n) {
  const hasFilter = currentFilters().q || currentFilters().province || currentFilters().city || currentFilters().sector;
  $('results-count').textContent = n == null
    ? `${state.providers.length} accredited providers`
    : `${n} result${n === 1 ? '' : 's'}`;
  $('btn-reset').hidden = !hasFilter;
}

function focusProvider(id) {
  const m = state.markersById[id];
  if (!m) return;
  state.selectedId = id;
  const p = state.providers.find((x) => x.id === id);
  state.map.setView([p.lat, p.lon], 16, { animate: true });
  setTimeout(() => m.openPopup(), 350);
  if (isMobile()) closeSidebar();
  // highlight in list
  document.querySelectorAll('.result-item').forEach((el) => el.classList.remove('active'));
}

function resetFilters() {
  $('search-input').value = '';
  $('province-select').value = '';
  $('city-select').value = '';
  $('sector-select').value = '';
  $('btn-clear-search').hidden = true;
  buildCitySelect('');
  renderResults();
  state.map.setView(PH_CENTER, 6);
}

// ---------------------------------------------------------------------------
// Geolocation + nearest
// ---------------------------------------------------------------------------
function locate(onSuccess) {
  if (!('geolocation' in navigator)) {
    toast('Geolocation is not supported by this browser.');
    return;
  }
  setLocating(true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setLocating(false);
      state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      placeUserMarker();
      showNearest();
      state.map.setView([state.userPos.lat, state.userPos.lon], 13);
      startWatch();
      if (onSuccess) onSuccess();
    },
    (err) => {
      setLocating(false);
      const msg = err.code === err.PERMISSION_DENIED
        ? 'Location permission denied. Please allow location access and try again.'
        : 'Could not determine your location.';
      toast(msg, 'error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function startWatch() {
  if (state.watchId != null || !('geolocation' in navigator)) return;
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      placeUserMarker();
      updateGuidance();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function placeUserMarker() {
  if (!state.userPos) return;
  if (!state.userMarker) {
    const icon = L.divIcon({
      className: 'user-marker-wrap',
      html: '<span class="user-pin">' + USER_PIN_SVG + '</span><span class="user-label">You are here</span>',
      iconSize: [90, 66],
      iconAnchor: [45, 44],
    });
    state.userMarker = L.marker([state.userPos.lat, state.userPos.lon], {
      icon,
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(state.map);
    state.userMarker.bindTooltip('Your current location', {
      permanent: false, direction: 'top', offset: [0, -34],
    });
  } else {
    state.userMarker.setLatLng([state.userPos.lat, state.userPos.lon]);
  }

  // Accuracy circle showing the GPS uncertainty radius
  const radius = Math.max(state.userPos.accuracy || 0, 10);
  if (state.userAccuracy) {
    state.userAccuracy.setLatLng([state.userPos.lat, state.userPos.lon]);
    state.userAccuracy.setRadius(radius);
  } else {
    state.userAccuracy = L.circle([state.userPos.lat, state.userPos.lon], {
      radius,
      className: 'user-accuracy',
      interactive: false,
      weight: 2,
    }).addTo(state.map);
  }

  // (The user marker's zIndexOffset:1000 already keeps it above the
  //  provider markers and accuracy circle.)
}

function showNearest() {
  if (!state.userPos) return;
  const list = [...state.providers]
    .map((p) => ({ ...p, _dist: haversineMeters(state.userPos, p) }))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, 15);
  const ul = $('results-list');
  ul.innerHTML = '';
  $('results-empty').hidden = true;
  $('results-count').textContent = 'Nearest providers to you';
  $('btn-reset').hidden = false;
  for (const p of list) {
    const li = document.createElement('li');
    li.className = 'result-item';
    li.innerHTML = `
      <span class="result-badge badge-${p.sector_code}">${p.sector_code}</span>
      <div class="result-body">
        <div class="result-name">${escapeHtml(p.name)}</div>
        <div class="result-meta">${escapeHtml(p.city)}, ${escapeHtml(p.province)}</div>
        <div class="result-distance">📍 ${formatDistance(p._dist)}</div>
      </div>
      <div class="result-actions">
        <button class="mini-btn dir" type="button">Directions</button>
      </div>`;
    li.addEventListener('click', () => focusProvider(p.id));
    li.querySelector('.mini-btn.dir').addEventListener('click', (e) => {
      e.stopPropagation();
      startDirections(p.id);
    });
    ul.appendChild(li);
  }
  // Fit bounds to user + nearest
  const bounds = L.latLngBounds([[state.userPos.lat, state.userPos.lon]]);
  for (const p of list) bounds.extend([p.lat, p.lon]);
  state.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
}

function setLocating(on) {
  const btn = $('btn-locate');
  btn.disabled = on;
  btn.querySelector('.btn-label').textContent = on ? 'Locating…' : 'Locate Me';
}

// ---------------------------------------------------------------------------
// Directions / turn-by-turn
// ---------------------------------------------------------------------------
async function startDirections(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  if (isMobile()) closeSidebar();
  if (!state.userPos) {
    toast('Finding your location first…');
    locate(() => routeTo(p));
    return;
  }
  await routeTo(p);
}

async function routeTo(p) {
  $('dir-target').textContent = p.name;
  $('dir-summary').textContent = 'Calculating route…';
  $('directions-panel').hidden = false;
  $('dir-steps').innerHTML = '<li class="dir-step"><span class="step-body step-text">Fetching route…</span></li>';

  let data = null;
  let usedFallback = false;

  // 1) Try our server proxy first (works with a self-hosted OSRM too).
  data = await fetchRouteViaServer(p);
  if (data && data.code === 'Ok' && data.routes && data.routes.length) {
    drawRoute(data.routes[0], p);
    return;
  }

  // 2) Server proxy failed (could be a CDN/WAF blocking the /api/route
  //    path, or a proxy timeout returning an HTML error page). Fall back to
  //    calling the public OSRM API directly from the browser (it allows CORS).
  usedFallback = true;
  $('dir-summary').textContent = 'Retrying via direct routing…';
  data = await fetchRouteDirect(p);

  if (data && data.code === 'Ok' && data.routes && data.routes.length) {
    drawRoute(data.routes[0], p);
    return;
  }

  // 3) Both failed — show a clear, actionable message.
  $('dir-summary').textContent = '';
  $('dir-steps').innerHTML =
    '<li class="dir-step"><span class="step-body step-text">' +
    'Could not calculate a route. The routing service may be temporarily ' +
    'unavailable. Please try again in a moment.</span></li>';
}

// Fetch the route through our own server (preferred; supports self-hosted OSRM).
async function fetchRouteViaServer(p) {
  try {
    const url = `/api/route?from=${state.userPos.lat},${state.userPos.lon}&to=${p.lat},${p.lon}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    // Guard against CDN/WAF returning an HTML error page instead of JSON.
    if (!res.ok || !ct.includes('json')) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Fetch the route directly from the public OSRM API (CORS-enabled). This
// bypasses our server (and any CDN/WAF in front of it) entirely.
async function fetchRouteDirect(p) {
  try {
    const from = `${state.userPos.lon},${state.userPos.lat}`;
    const to = `${p.lon},${p.lat}`;
    const url =
      'https://router.project-osrm.org/route/v1/driving/' +
      `${from};${to}?overview=full&geometries=geojson&steps=true&alternatives=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function drawRoute(route, target) {
  // clear previous route
  state.routeLayer.clearLayers();
  state.routeSteps = [];

  const geom = route.geometry; // GeoJSON LineString
  const coords = geom.coordinates.map((c) => [c[1], c[0]]);
  const line = L.polyline(coords, { color: '#0d6efd', weight: 6, opacity: 0.85 }).addTo(state.routeLayer);
  const casing = L.polyline(coords, { color: '#ffffff', weight: 10, opacity: 0.6 }).addTo(state.routeLayer);
  casing.bringToBack();

  // endpoints
  const startIcon = L.divIcon({ className: '', html: '<span style="display:block;width:12px;height:12px;border-radius:50%;background:#22c55e;border:2px solid #fff;"></span>', iconSize: [16, 16], iconAnchor: [8, 8] });
  const endIcon = L.divIcon({ className: '', html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:#d63384;border:2px solid #fff;"></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
  L.marker(coords[0], { icon: startIcon }).addTo(state.routeLayer);
  L.marker(coords[coords.length - 1], { icon: endIcon }).addTo(state.routeLayer);

  // parse steps
  const steps = route.legs[0].steps;
  state.routeSteps = steps.map((s, i) => ({
    maneuver: s.maneuver,
    name: s.name || '',
    distance: s.distance,
    duration: s.duration,
    start: [s.geometry.coordinates[0][1], s.geometry.coordinates[0][0]],
  }));

  // summary
  $('dir-summary').textContent =
    `${formatDistance(route.distance)} · ${formatDuration(route.duration)} · ${steps.length} steps`;

  renderSteps(steps);

  // fit route
  state.map.fitBounds(line.getBounds(), { padding: [40, 40] });
  updateGuidance();
}

function turnIcon(maneuver) {
  const t = maneuver.type;
  const m = (maneuver.modifier || '').toLowerCase();
  if (t === 'arrive') return { icon: '⚑', cls: 'arrive' };
  if (t === 'depart') return { icon: '▶', cls: '' };
  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn' || t === 'exit roundabout') return { icon: '↻', cls: '' };
  if (t === 'turn' || t === 'fork' || t === 'merge' || t === 'on ramp' || t === 'off ramp' || t === 'end of road') {
    if (m.includes('sharp left')) return { icon: '⇠', cls: '' };
    if (m.includes('sharp right')) return { icon: '⇢', cls: '' };
    if (m.includes('slight left')) return { icon: '↖', cls: '' };
    if (m.includes('slight right')) return { icon: '↗', cls: '' };
    if (m.includes('left')) return { icon: '←', cls: '' };
    if (m.includes('right')) return { icon: '→', cls: '' };
    if (m.includes('uturn')) return { icon: '↶', cls: '' };
    return { icon: '↑', cls: '' };
  }
  // continue / new name / notification / etc.
  if (m.includes('uturn')) return { icon: '↶', cls: '' };
  if (m.includes('left')) return { icon: '↖', cls: '' };
  if (m.includes('right')) return { icon: '↗', cls: '' };
  return { icon: '↑', cls: '' };
}

function instructionText(maneuver, name) {
  const t = maneuver.type;
  const m = (maneuver.modifier || '').replace(/_/g, ' ').toLowerCase();
  if (t === 'depart') return `Head ${m || 'onward'} from your location`;
  if (t === 'arrive') return 'You have arrived at your destination';
  if (t === 'roundabout' || t === 'rotary' || t === 'roundabout turn') return `At the roundabout, take the ${m || 'next'} exit`;
  if (t === 'exit roundabout') return 'Exit the roundabout';
  if (t === 'merge') return `Merge ${m || ''}`.trim();
  if (t === 'on ramp') return `Take the ramp ${m || ''}`.trim();
  if (t === 'off ramp') return `Take the exit ${m || ''}`.trim();
  if (t === 'fork') return `Keep ${m || 'straight'} at the fork`;
  if (t === 'end of road') return `Turn ${m || 'straight'} at the end of the road`;
  if (t === 'turn') return `Turn ${m || 'straight'}`;
  if (t === 'continue') return m && m !== 'straight' ? `Continue ${m}` : 'Continue straight';
  if (t === 'new name') return 'Continue straight';
  return 'Continue';
}

function renderSteps(steps) {
  const ol = $('dir-steps');
  ol.innerHTML = '';
  steps.forEach((s, i) => {
    const { icon, cls } = turnIcon(s.maneuver);
    const li = document.createElement('li');
    li.className = 'dir-step';
    li.dataset.index = i;
    li.innerHTML = `
      <span class="step-icon ${cls}">${icon}</span>
      <span class="step-body">
        <span class="step-text">${escapeHtml(instructionText(s.maneuver, s.name))}</span>
        ${s.name && s.maneuver.type !== 'arrive' ? `<div class="step-street">${escapeHtml(s.name)}</div>` : ''}
        <div class="step-dist">${formatDistance(s.distance)}</div>
      </span>`;
    ol.appendChild(li);
  });
}

function updateGuidance() {
  if (!state.userPos || !state.routeSteps.length) return;
  // Find nearest step start to user to determine current step
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < state.routeSteps.length; i++) {
    const d = haversineMeters(state.userPos, { lat: state.routeSteps[i].start[0], lon: state.routeSteps[i].start[1] });
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  const items = $('dir-steps').querySelectorAll('.dir-step');
  items.forEach((el, i) => el.classList.toggle('current', i === bestIdx));
  const target = items[bestIdx];
  if (target) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearDirections() {
  state.routeLayer.clearLayers();
  state.routeSteps = [];
  $('directions-panel').hidden = true;
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
function toast(msg, kind) {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' toast-error' : '');
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ---------------------------------------------------------------------------
// Mobile sidebar (list overlay)
// ---------------------------------------------------------------------------
function isMobile() {
  return window.matchMedia('(max-width: 720px)').matches;
}
function openSidebar() {
  document.body.classList.add('sidebar-open');
  document.body.classList.remove('sidebar-hidden');
}
function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}
function toggleSidebar() {
  if (isMobile()) {
    // Mobile: toggle the slide-up bottom sheet
    document.body.classList.toggle('sidebar-open');
  } else {
    // Desktop: collapse/expand the sidebar (map expands to fill the space)
    document.body.classList.toggle('sidebar-hidden');
  }
}

// Keep state consistent when the window crosses the mobile/desktop breakpoint
// (e.g. rotating a phone or resizing a laptop window).
window.addEventListener('resize', () => {
  if (!isMobile()) document.body.classList.remove('sidebar-open');
});

// ---------------------------------------------------------------------------
// Wire up events
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const vn = document.getElementById('version-note');
  if (vn) vn.textContent = 'v' + APP_VERSION;
  console.log('[GAMOT Locator] version ' + APP_VERSION);
  init();

  // Mobile sidebar toggle + backdrop + close button
  $('btn-toggle-list').addEventListener('click', toggleSidebar);
  $('sidebar-backdrop').addEventListener('click', closeSidebar);
  $('btn-close-sidebar').addEventListener('click', closeSidebar);

  // Delegated handler for the popup "Directions" button (no inline onclick,
  // which keeps the Content-Security-Policy strict).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.popup-dir');
    if (btn) {
      const id = parseInt(btn.getAttribute('data-id'), 10);
      if (id) startDirections(id);
    }
  });

  $('search-input').addEventListener('input', debounce(() => {
    $('btn-clear-search').hidden = !$('search-input').value;
    renderResults();
  }, 150));

  $('btn-clear-search').addEventListener('click', () => {
    $('search-input').value = '';
    $('btn-clear-search').hidden = true;
    renderResults();
    $('search-input').focus();
  });

  $('province-select').addEventListener('change', () => {
    const prov = $('province-select').value;
    buildCitySelect(prov);
    renderResults();
    if (prov) {
      const pts = state.providers.filter((p) => p.province === prov);
      if (pts.length) {
        const b = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
        state.map.fitBounds(b, { padding: [20, 20] });
      }
    }
  });

  $('city-select').addEventListener('change', () => {
    renderResults();
    const city = $('city-select').value;
    if (city) {
      const pts = state.providers.filter((p) => p.city === city);
      if (pts.length) {
        const b = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
        state.map.fitBounds(b, { padding: [20, 20] });
      }
    }
  });

  $('sector-select').addEventListener('change', renderResults);
  $('btn-reset').addEventListener('click', resetFilters);
  $('btn-locate').addEventListener('click', () => locate());
  $('btn-close-dir').addEventListener('click', clearDirections);
});
