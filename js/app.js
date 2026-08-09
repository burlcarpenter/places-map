import { loadTaxonomy, buckets, bucketById, annotate, categoryLabel, parseMaybeJson,
         applyTaxonomyFrom } from './categories.js';
import { getPlaces, setPlaces, getSettings, saveSettings } from './store.js';
import { fetchPlaces, diff, sanitizeToken } from './sync.js';

const $ = id => document.getElementById(id);
const SRC = 'places';
const LAYER = 'places-pins';
const LABELS = 'places-labels';

let map, data = null, active = new Set();
let watchId = null, meMarker = null, lastFix = null;
const ME_SRC = 'me-accuracy';

let baseLayerIds = [];   // the vector style's own layers, captured before we add anything
const SAT_SRC = 'satellite';
const SAT_LAYER = 'satellite-layer';

// ---------------------------------------------------------------- utilities

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 5200 : 3000);
}

/**
 * MapLibre symbol layers need real images, and there is no reliable emoji glyph
 * in the basemap font stack. So each bucket's emoji is drawn once to a canvas —
 * white disc, coloured ring, emoji centred — and registered as a sprite.
 */
function makePin({ emoji, color }, size = 46) {
  const dpr = 2, c = document.createElement('canvas');
  c.width = c.height = size * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);

  const r = size / 2 - 3;
  x.beginPath(); x.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  x.fillStyle = '#fff'; x.fill();
  x.lineWidth = 3; x.strokeStyle = color; x.stroke();

  x.font = `${Math.round(size * 0.46)}px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(emoji, size / 2, size / 2 + 1);

  return { width: size * dpr, height: size * dpr, data: x.getImageData(0, 0, c.width, c.height).data };
}

// ---------------------------------------------------------------- map setup

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [19.04, 47.50],   // Budapest, replaced by fitBounds once data loads
    zoom: 6,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  return new Promise(res => map.on('load', res));
}

/**
 * CARTO Positron prefers English names (name_en) for most place labels —
 * country/state/continent unconditionally, towns and cities below zoom 13.
 * That is why a French region rendered as "Great East" instead of "Grand Est."
 *
 * Prefer OSM's `name:latin` — a transliteration of the local name, not a
 * translation of it (e.g. "Moskva", not "Moscow") — falling back to the plain
 * `name` tag where no transliteration is tagged, which is already Latin script
 * for most of Europe and needs none. Coverage of `name:latin` in OSM is
 * inconsistent, so a handful of places may still fall back to their native
 * script rather than a Latin rendering.
 */
function useLocalLabels() {
  const expr = ['coalesce', ['get', 'name:latin'], ['get', 'name']];
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(layer.id, 'text-field');
    if (tf && JSON.stringify(tf).includes('name_en')) {
      map.setLayoutProperty(layer.id, 'text-field', expr);
    }
  }
}

/**
 * Satellite imagery as a raster layer beneath everything else, toggled by
 * visibility rather than swapping the whole style — a setStyle() call would
 * tear down and require re-adding every source, layer, marker and icon we
 * own. Esri's World Imagery tiles are the standard free-no-key option for a
 * personal project at this scale; I have not separately verified their usage
 * terms cover this beyond typical hobby-project use.
 */
function addSatelliteLayer() {
  // Snapshot the vector style's own layers before we add anything of ours, so
  // the toggle knows exactly what to hide and never touches our own layers.
  baseLayerIds = map.getStyle().layers.map(l => l.id);

  map.addSource(SAT_SRC, {
    type: 'raster',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    attribution: 'Imagery © Esri'
  });
  map.addLayer({ id: SAT_LAYER, type: 'raster', source: SAT_SRC, layout: { visibility: 'none' } });

  // MapLibre reports tile failures through this event, not a thrown JS error —
  // easy for a silent failure to produce no console output at all.
  map.on('error', e => {
    if (e?.sourceId === SAT_SRC) {
      toast(`Satellite imagery failed to load: ${e.error?.message ?? 'unknown error'}`, true);
    }
  });
}

function toggleSatellite() {
  try {
    const on = map.getLayoutProperty(SAT_LAYER, 'visibility') !== 'visible';
    map.setLayoutProperty(SAT_LAYER, 'visibility', on ? 'visible' : 'none');
    for (const id of baseLayerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
    }
    $('btn-satellite').classList.toggle('active', on);
    toast(on ? 'Satellite view on' : 'Satellite view off');
  } catch (e) {
    // If this fires, the button IS wired correctly — something in MapLibre
    // itself rejected the call, and the message says what.
    toast(`Satellite toggle failed: ${e.message}`, true);
  }
}

/** A quick, low-accuracy fix purely to frame the opening camera — not the tracked blue dot. */
function getInitialFix(timeout = 6000) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos),
      () => resolve(null),
      { enableHighAccuracy: false, timeout, maximumAge: 60000 }
    );
  });
}

function registerIcons() {
  for (const b of buckets()) {
    // Replace rather than skip — an existing image would keep a stale colour
    // after the taxonomy is edited in the desktop editor.
    if (map.hasImage(`pin-${b.id}`)) map.removeImage(`pin-${b.id}`);
    map.addImage(`pin-${b.id}`, makePin(b), { pixelRatio: 2 });
  }
}

function addLayers() {
  map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: LAYER,
    type: 'symbol',
    source: SRC,
    layout: {
      'icon-image': ['concat', 'pin-', ['get', '_bucket']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 0.8, 16, 1],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true
    }
  });

  map.addLayer({
    id: LABELS,
    type: 'symbol',
    source: SRC,
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 9,
      'text-optional': true
    },
    paint: {
      'text-color': '#3c4043',
      'text-halo-color': '#fff',
      'text-halo-width': 1.6
    }
  });

  map.on('zoom', updateAccuracyRadius);
  map.on('click', LAYER, e => openSheet(e.features[0]));
  map.on('mouseenter', LAYER, () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', LAYER, () => map.getCanvas().style.cursor = '');
}

function render(fc) {
  // The file may carry its own taxonomy from the desktop editor; adopt it
  // before annotating, and rebuild the marker sprites if it differs.
  if (applyTaxonomyFrom(fc)) registerIcons();
  data = annotate(fc);
  map.getSource(SRC).setData(data);
  buildCatPanel();
  applyFilter();
}

function fitToData() {
  const coords = (data.features ?? [])
    .map(f => f.geometry?.coordinates)
    .filter(c => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]));
  if (!coords.length) return;
  const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(b, { padding: { top: 90, bottom: 130, left: 40, right: 40 }, maxZoom: 15, duration: 0 });
}

// ---------------------------------------------------------------- filtering

function counts() {
  const m = new Map();
  for (const f of data?.features ?? []) {
    const b = f.properties._bucket;
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

function buildCatPanel() {
  const n = counts();
  const present = buckets().filter(b => n.get(b.id));

  // First build: everything visible. Rebuilds keep the user's current selection.
  if (!active.size) for (const b of present) active.add(b.id);

  const rows = $('cat-rows');
  rows.innerHTML = '';
  for (const b of present) {
    const c = n.get(b.id);
    const on = active.has(b.id);
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.style.setProperty('--rc', b.color);
    row.innerHTML = `
      <span class="cat-badge">${b.emoji}</span>
      <span class="cat-info"><b>${esc(b.label)}</b><small>${c} place${c === 1 ? '' : 's'}</small></span>
      <button class="cat-only" type="button">Only</button>
      <label class="switch">
        <input type="checkbox" ${on ? 'checked' : ''} aria-label="Show ${esc(b.label)}">
        <span class="slider"></span>
      </label>`;
    row.querySelector('.cat-only').addEventListener('click', () => onlyCategory(b.id));
    row.querySelector('input').addEventListener('change', e => {
      e.target.checked ? active.add(b.id) : active.delete(b.id);
      applyFilter();
      updateCatTrigger();
    });
    rows.appendChild(row);
  }

  updateCatTrigger();
}

function onlyCategory(id) {
  active = new Set([id]);
  buildCatPanel();
  applyFilter();
}

function showAllCategories() {
  active = new Set([...counts().keys()]);
  buildCatPanel();
  applyFilter();
}

function updateCatTrigger() {
  const total = [...counts().keys()].length;
  const on = active.size;
  const el = $('cat-trigger-label');
  el.innerHTML = on === total
    ? `Categories <span class="n">${total}</span>`
    : `Categories <span class="n filtered">${on}/${total}</span>`;
}

function toggleCatPanel(open) {
  const panel = $('cat-panel');
  const willOpen = open ?? panel.hidden;
  panel.hidden = !willOpen;
  $('cat-trigger').setAttribute('aria-expanded', String(willOpen));
}

function applyFilter() {
  const f = ['in', ['get', '_bucket'], ['literal', [...active]]];
  map.setFilter(LAYER, f);
  map.setFilter(LABELS, f);
}

// ---------------------------------------------------------------- place sheet

function stars(rating) {
  const r = Math.round(rating * 2) / 2;
  return '★'.repeat(Math.floor(r)) + (r % 1 ? '½' : '') + '☆'.repeat(Math.max(0, 5 - Math.ceil(r)));
}

/**
 * Only http(s) may reach an href. Escaping alone does not stop a `javascript:`
 * URL in a data field from running with full access to this origin — which
 * includes the stored GitHub token. Your own data is not the threat here;
 * anything you ever import from elsewhere is.
 */
function safeUrl(u) {
  try {
    const parsed = new URL(String(u ?? ''), location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

const safeTel = v => String(v ?? '').replace(/[^0-9+()\-\s]/g, '').trim();

/** Google repeats the place name inside the address string; drop that segment. */
function cleanAddress(p) {
  const addr = String(p.address ?? '').trim();
  const name = String(p.name ?? '').trim();
  if (!addr || !name) return addr;
  return addr.split(',').map(s => s.trim())
    .filter(s => s && s.toLowerCase() !== name.toLowerCase())
    .join(', ');
}

/** phones may be an array, a single string, or absent. */
function phone(p) {
  const v = p.phones ?? p.phone;
  return (Array.isArray(v) ? v[0] : v) || '';
}

function hoursHtml(raw) {
  const hours = parseMaybeJson(raw);
  if (!hours) return '';

  let items = [];
  if (Array.isArray(hours)) {
    items = hours.map(h => {
      if (typeof h === 'string') return [h, ''];
      if (h && typeof h === 'object') {
        // exportmymap writes [{day, hours}, ...]; fall back to the first pair.
        if ('day' in h) return [h.day, h.hours ?? h.time ?? ''];
        return Object.entries(h)[0] ?? [];
      }
      return [];
    }).filter(pair => pair.length && pair[0]);
  } else if (typeof hours === 'object') {
    items = Object.entries(hours);
  } else {
    return `<p class="raw-cat">${esc(hours)}</p>`;
  }
  if (!items.length) return '';
  return `<details class="hours"><summary>Opening hours</summary><ul>${
    items.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('')
  }</ul></details>`;
}

function openSheet(feature) {
  toggleCatPanel(false);
  const p = feature.properties ?? {};
  const [lng, lat] = feature.geometry.coordinates;
  const b = bucketById(p._bucket);

  // Google Maps https deep links hand off to the native Android app automatically
  // and still work on desktop, which raw geo:/google.navigation: intents do not.
  const dest = p.placeId
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=${encodeURIComponent(p.placeId)}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const view = safeUrl(p.googleMapsUrl) || (p.placeId
    ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${encodeURIComponent(p.placeId)}`
    : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);

  const locality = [p.district, p.city].filter(Boolean).join(' · ');

  $('sheet-body').innerHTML = `
    <h2>${esc(p.name ?? 'Unnamed place')}</h2>
    <div class="kicker">
      <span class="emoji">${b.emoji}</span><span>${esc(b.label)}</span>
      ${locality ? `<span>·</span><span>${esc(locality)}</span>` : ''}
    </div>
    ${p.rating ? `<div class="rating"><span class="stars">${stars(p.rating)}</span>
      <span>${esc(p.rating)}${p.reviewCount ? ` · ${esc(p.reviewCount)} reviews` : ''}</span></div>` : ''}
    ${cleanAddress(p) ? `<p class="addr">${esc(cleanAddress(p))}</p>` : ''}
    ${p.user?.note ? `<div class="notebox user"><span class="lbl">My note</span>${esc(p.user.note)}</div>` : ''}
    ${p.note ? `<div class="notebox"><span class="lbl">Note</span>${esc(p.note)}</div>` : ''}
    ${hoursHtml(p.hours)}
    ${categoryLabel(p.category) ? `<p class="raw-cat">${esc(categoryLabel(p.category))}</p>` : ''}
    <div class="actions">
      <a class="primary" href="${dest}" target="_blank" rel="noopener">
        <svg class="icon" viewBox="0 0 24 24"><path d="M21.71 11.29 12.71 2.29a1 1 0 00-1.42 0l-9 9a1 1 0 000 1.42l9 9a1 1 0 001.42 0l9-9a1 1 0 000-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 011-1h5V7.5l3.5 3.5z" fill="#fff"/></svg>
        Navigate
      </a>
      <a class="secondary" href="${view}" target="_blank" rel="noopener">Open in Google Maps</a>
      ${safeUrl(p.website) ? `<a class="secondary" href="${esc(safeUrl(p.website))}" target="_blank" rel="noopener">Website</a>` : ''}
      ${safeTel(phone(p)) ? `<a class="secondary" href="tel:${esc(safeTel(phone(p)))}">Call</a>` : ''}
    </div>`;

  $('sheet').hidden = false;
  map.easeTo({ center: [lng, lat], offset: [0, -110], duration: 420 });
}

// ---------------------------------------------------------------- my location

/**
 * Own the "you are here" rendering rather than using MapLibre's GeolocateControl,
 * whose dot would not paint here. A plain Marker plus a circle layer is fully
 * inspectable and styles with the rest of the app.
 */
function ensureAccuracyLayer() {
  if (map.getSource(ME_SRC)) return;
  map.addSource(ME_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: ME_SRC,
    type: 'circle',
    source: ME_SRC,
    paint: {
      'circle-color': '#1a73e8',
      'circle-opacity': 0.13,
      'circle-stroke-color': '#1a73e8',
      'circle-stroke-opacity': 0.35,
      'circle-stroke-width': 1,
      'circle-radius': 0
    }
  }, LAYER);   // beneath the place pins, never covering them
}

/** GPS accuracy is in metres; circle-radius is in pixels, and the ratio moves with zoom. */
function updateAccuracyRadius() {
  if (!lastFix || !map.getLayer(ME_SRC)) return;
  const metresPerPixel =
    156543.03392 * Math.cos(lastFix.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
  map.setPaintProperty(ME_SRC, 'circle-radius', Math.max(0, lastFix.accuracy / metresPerPixel));
}

function paintMe(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  lastFix = { lat, lng, accuracy };

  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    meMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  } else {
    meMarker.setLngLat([lng, lat]);
  }

  ensureAccuracyLayer();
  map.getSource(ME_SRC).setData({
    type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {}
  });
  updateAccuracyRadius();
}

function stopLocate() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastFix = null;
  $('btn-locate').classList.remove('busy', 'active');
  meMarker?.remove();
  meMarker = null;
  map.getSource(ME_SRC)?.setData({ type: 'FeatureCollection', features: [] });
}

function toggleLocate() {
  const btn = $('btn-locate');
  if (watchId !== null) return stopLocate();
  if (!navigator.geolocation) return toast('Geolocation unavailable on this device.', true);

  btn.classList.add('busy');
  let first = true;

  watchId = navigator.geolocation.watchPosition(
    pos => {
      btn.classList.remove('busy');
      btn.classList.add('active');
      paintMe(pos);
      if (first) {
        first = false;
        map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude],
                     zoom: Math.max(map.getZoom(), 15) });
      }
    },
    err => {
      stopLocate();
      toast(err.code === 1
        ? 'Location permission denied. Enable it for this site in your browser settings.'
        : `Location unavailable: ${err.message}`, true);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
  );
}

// ---------------------------------------------------------------- search

function search(q) {
  const box = $('results');
  const term = q.trim().toLowerCase();
  $('search-clear').hidden = !term;

  if (!term) { box.hidden = true; return; }

  const hits = (data?.features ?? []).filter(f => {
    const p = f.properties;
    return [p.name, p.address, p.city, p.district, categoryLabel(p.category), p.note, p.user?.note]
      .some(v => String(v ?? '').toLowerCase().includes(term));
  }).slice(0, 40);

  box.hidden = false;
  if (!hits.length) { box.innerHTML = '<p class="empty">No places match that.</p>'; return; }

  box.innerHTML = '';
  for (const f of hits) {
    const p = f.properties, b = bucketById(p._bucket);
    const btn = document.createElement('button');
    btn.className = 'result';
    btn.innerHTML = `<span class="emoji">${b.emoji}</span>
      <span><b>${esc(p.name)}</b><span>${esc([p.district, p.city].filter(Boolean).join(' · ') || b.label)}</span></span>`;
    btn.addEventListener('click', () => {
      box.hidden = true;
      $('search').value = '';
      $('search-clear').hidden = true;
      map.flyTo({ center: f.geometry.coordinates, zoom: 16, offset: [0, -110] });
      openSheet(f);
    });
    box.appendChild(btn);
  }
}

// ---------------------------------------------------------------- sync

async function refresh({ silent = false } = {}) {
  const btn = $('btn-refresh');
  const settings = await getSettings();

  if (!settings.token) {
    if (!silent) { toast('Add your GitHub token in Settings first.', true); openSettings(); }
    return;
  }

  btn.classList.add('busy');
  try {
    const incoming = await fetchPlaces(settings);
    const cached = await getPlaces();
    const d = diff(cached, incoming);

    await setPlaces(incoming);
    await saveSettings({ lastSync: Date.now(), placeCount: d.total });
    render(incoming);

    const change = d.added || d.removed
      ? ` (${[d.added && `+${d.added}`, d.removed && `−${d.removed}`].filter(Boolean).join(', ')})`
      : '';
    toast(`Updated: ${d.total} places${change}`);
  } catch (e) {
    if (!silent) toast(e.message, true);
  } finally {
    btn.classList.remove('busy');
    refreshMeta();
  }
}

async function refreshMeta() {
  const s = await getSettings();
  $('meta-count').textContent = s.placeCount ?? (data?.features?.length ?? '—');
  $('meta-sync').textContent = s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never';
}

// ---------------------------------------------------------------- settings

async function openSettings() {
  const s = await getSettings();
  // Deliberately no hardcoded defaults — this repo is public, and baking in the
  // private repo's name and filename would advertise both. Fields start blank
  // and are remembered per device after the first save.
  $('set-owner').value = s.owner ?? '';
  $('set-repo').value  = s.repo  ?? '';
  $('set-path').value  = s.path  ?? '';
  $('set-token').value = s.token ?? '';
  await refreshMeta();
  $('settings').hidden = false;
}

async function saveFromForm() {
  await saveSettings({
    owner: $('set-owner').value.trim(),
    repo:  $('set-repo').value.trim(),
    path:  $('set-path').value.trim().replace(/^\/+/, ''),
    token: sanitizeToken($('set-token').value)
  });
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('btn-refresh').addEventListener('click', () => refresh());
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', e => { if (e.target.id === 'settings') $('settings').hidden = true; });

  $('settings-save').addEventListener('click', async () => {
    await saveFromForm(); $('settings').hidden = true; toast('Settings saved');
  });
  $('settings-sync').addEventListener('click', async () => {
    await saveFromForm(); $('settings').hidden = true; refresh();
  });

  $('sheet-close').addEventListener('click', () => { $('sheet').hidden = true; });
  $('search').addEventListener('input', e => search(e.target.value));
  $('search-clear').addEventListener('click', () => { $('search').value = ''; search(''); $('search').focus(); });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) $('results').hidden = true;
    if (!e.target.closest('.cat-filter')) toggleCatPanel(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $('sheet').hidden = true; $('settings').hidden = true; $('results').hidden = true;
    toggleCatPanel(false);
  });

  $('btn-locate').addEventListener('click', toggleLocate);
  $('btn-satellite').addEventListener('click', toggleSatellite);
  $('cat-trigger').addEventListener('click', () => toggleCatPanel());
  $('cat-showall').addEventListener('click', showAllCategories);
}

// ---------------------------------------------------------------- boot

(async function boot() {
  wire();
  await Promise.all([loadTaxonomy(), initMap()]);
  registerIcons();
  addSatelliteLayer();   // before addLayers(), so it only captures the vector style's own layers
  addLayers();
  useLocalLabels();

  // Kick off a quick location fix in parallel with data loading, rather than
  // after it, so opening the app is not gated on the slower of the two.
  const locPromise = getInitialFix();

  const cached = await getPlaces();
  if (cached) {
    render(cached);
    refresh({ silent: true });            // quiet background update; offline is fine
  } else {
    const s = await getSettings();
    if (s.token) await refresh();
    else { toast('Add your GitHub token in Settings to load places.'); openSettings(); }
  }

  // Open zoomed to wherever you are; fall back to fitting your data if
  // location is denied, times out, or the device has none to offer.
  const fix = await locPromise;
  if (fix) map.jumpTo({ center: [fix.coords.longitude, fix.coords.latitude], zoom: 15 });
  else fitToData();

  refreshMeta();

  // On when deployed, off on localhost. A service worker serving stale code
  // makes every local edit look like it silently failed, but offline caching is
  // the whole point once this is on a phone.
  const ENABLE_SW = !['localhost', '127.0.0.1'].includes(location.hostname);

  if ('serviceWorker' in navigator) {
    if (ENABLE_SW) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    } else {
      // Self-healing: tear down any worker and caches a previous build left behind.
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      if (regs.length) console.info('Removed stale service worker + caches.');
    }
  }
})();
