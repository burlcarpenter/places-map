import { loadTaxonomy, buckets, bucketById, annotate, categoryLabel, parseMaybeJson,
         applyTaxonomyFrom, RESEARCH_NEEDED } from './categories.js';
import { getPlaces, setPlaces, getSettings, saveSettings } from './store.js';
import { fetchPlaces, diff, sanitizeToken } from './sync.js';

const $ = id => document.getElementById(id);
const SRC = 'places';
const LAYER = 'places-pins';
const LABELS = 'places-labels';

let map, data = null, active = new Set(), activeCountries = new Set(), activeStatus = new Set();
let watchId = null, meMarker = null, lastFix = null;
const ME_SRC = 'me-accuracy';

let baseLayerIds = [];      // Positron's own layers, captured before we add anything of ours
let voyagerLayerIds = [];   // Voyager's layers, added later, prefixed to avoid id collisions
let currentView = 'map';    // 'map' | 'classic' | 'satellite' — mutually exclusive
const SAT_SRC = 'satellite';
const SAT_LAYER = 'satellite-layer';
const VOYAGER_STYLE_URL = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const VOYAGER_PREFIX = 'voy-';

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

/**
 * A place with two categories gets a disc split vertically instead of
 * white — left half one colour, right half the other, still ringed, still
 * carrying one emoji. Sprites are shared by combination (e.g. every
 * cafe+museum place uses the same image), so left/right is assigned by
 * whichever id sorts first alphabetically, not by which a given place calls
 * "primary" — otherwise every ordering of the same pair would need its own
 * sprite for no real benefit.
 */
function makeSplitPin(bucketLeft, bucketRight, size = 46) {
  const dpr = 2, c = document.createElement('canvas');
  c.width = c.height = size * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);

  const r = size / 2 - 3, cx = size / 2, cy = size / 2;

  x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false); x.closePath();
  x.fillStyle = bucketRight.color; x.fill();

  x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r, Math.PI / 2, -Math.PI / 2, false); x.closePath();
  x.fillStyle = bucketLeft.color; x.fill();

  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.lineWidth = 2.5; x.strokeStyle = '#fff'; x.stroke();

  x.font = `${Math.round(size * 0.46)}px "Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,.85)';
  x.strokeText(bucketLeft.emoji, cx, cy + 1);   // halo — keeps the glyph legible over either colour
  x.fillText(bucketLeft.emoji, cx, cy + 1);

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

/**
 * Split-colour sprites, one per two-category combination actually present in
 * the current data — not the full combinatorial space of every possible
 * pair, which would keep growing pointlessly as categories are added.
 * Depends on data, so this runs after annotate(), not with registerIcons().
 */
function registerPairIcons() {
  const keys = new Set();
  for (const f of data?.features ?? []) {
    const k = f.properties._bucketKey;
    if (k?.includes('+')) keys.add(k);
  }
  for (const key of keys) {
    const id = `pin-${key}`;
    if (map.hasImage(id)) map.removeImage(id);

    // Research Needed never owns the icon — glancing at the map should show
    // what a place IS first; the colour split is the secondary "needs
    // research" signal, not the primary one. Two real categories keep the
    // plain alphabetical left/right (no reason to prefer either).
    const ids = key.split('+');
    const rnAt = ids.indexOf(RESEARCH_NEEDED.id);
    const [idLeft, idRight] = rnAt === -1 ? ids : [ids[1 - rnAt], ids[rnAt]];

    map.addImage(id, makeSplitPin(bucketById(idLeft), bucketById(idRight)), { pixelRatio: 2 });
  }
}

function addLayers() {
  map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: LAYER,
    type: 'symbol',
    source: SRC,
    layout: {
      'icon-image': ['concat', 'pin-', ['get', '_bucketKey']],
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
  for (const f of data.features) {
    f.properties._country = countryKey(f.properties);
    f.properties._status = statusOf(f.properties);
  }
  registerPairIcons();   // depends on _bucketKey, which annotate() just stamped
  map.getSource(SRC).setData(data);
  buildCatPanel();
  buildCountryPanel();
  buildStatusPanel();
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

/** A two-category place counts toward both totals — the chip is answering
 *  "how many places carry this tag", and a dual-tagged place genuinely does. */
function counts() {
  const m = new Map();
  for (const f of data?.features ?? []) {
    for (const b of [f.properties._bucket1, f.properties._bucket2]) {
      if (b) m.set(b, (m.get(b) ?? 0) + 1);
    }
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

// ---------------------------------------------------------------- countries

/**
 * A country's Unicode flag is just its two-letter code re-encoded as Regional
 * Indicator Symbols — no image assets or lookup table needed. Rendering
 * depends on the OS/browser having flag glyphs (most do); anything else falls
 * back to a plain globe.
 */
function countryFlag(code) {
  const cc = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

/** Grouping key: the ISO code when present (canonical), else the raw country name. */
function countryKey(p) {
  const code = String(p.countryCode ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  const name = String(p.country ?? '').trim();
  return name || 'unknown';
}

function countryLabel(p) {
  return String(p.country ?? '').trim() || (countryKey(p) === 'unknown' ? 'Unknown' : countryKey(p));
}

function countryCounts() {
  const m = new Map();
  for (const f of data?.features ?? []) {
    const key = f.properties._country;
    if (!m.has(key)) {
      m.set(key, { label: countryLabel(f.properties), flag: countryFlag(f.properties.countryCode), count: 0 });
    }
    m.get(key).count++;
  }
  return m;
}

function buildCountryPanel() {
  const n = countryCounts();
  const entries = [...n.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));

  if (!activeCountries.size) for (const [key] of entries) activeCountries.add(key);

  const rows = $('country-rows');
  rows.innerHTML = '';
  for (const [key, item] of entries) {
    const on = activeCountries.has(key);
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <span class="cat-badge">${item.flag}</span>
      <span class="cat-info"><b>${esc(item.label)}</b><small>${item.count} place${item.count === 1 ? '' : 's'}</small></span>
      <button class="cat-only" type="button">Only</button>
      <label class="switch">
        <input type="checkbox" ${on ? 'checked' : ''} aria-label="Show ${esc(item.label)}">
        <span class="slider"></span>
      </label>`;
    row.querySelector('.cat-only').addEventListener('click', () => onlyCountry(key));
    row.querySelector('input').addEventListener('change', e => {
      e.target.checked ? activeCountries.add(key) : activeCountries.delete(key);
      applyFilter();
      updateCountryTrigger();
    });
    rows.appendChild(row);
  }
  updateCountryTrigger();
}

function onlyCountry(key) {
  activeCountries = new Set([key]);
  buildCountryPanel();
  applyFilter();
}

function showAllCountries() {
  activeCountries = new Set(countryCounts().keys());
  buildCountryPanel();
  applyFilter();
}

function updateCountryTrigger() {
  const total = countryCounts().size;
  const on = activeCountries.size;
  const el = $('country-trigger-label');
  el.innerHTML = on === total
    ? `Countries <span class="n">${total}</span>`
    : `Countries <span class="n filtered">${on}/${total}</span>`;
}

function toggleCountryPanel(open) {
  const panel = $('country-panel');
  const willOpen = open ?? panel.hidden;
  panel.hidden = !willOpen;
  $('country-trigger').setAttribute('aria-expanded', String(willOpen));
}

// ---------------------------------------------------------------- priority

/**
 * A fixed small set, unlike categories/countries — not user-editable, no
 * taxonomy file. "Visited" supersedes a priority tier once you have actually
 * been; the tier only matters for planning what to see next. Colour carries
 * the medal-tier association (gold/silver/bronze) without needing emoji.
 */
const STATUS_TIERS = [
  { id: 'primary',   label: 'Primary',     color: '#c99a2e' },
  { id: 'secondary', label: 'Secondary',   color: '#8a94a3' },
  { id: 'tertiary',  label: 'Tertiary',    color: '#a9663c' },
  { id: 'visited',   label: 'Visited',     color: '#2f8f5b' },
  { id: 'unset',     label: 'Not planned', color: '#9aa0a6' }
];
const statusTier = id => STATUS_TIERS.find(s => s.id === id) ?? STATUS_TIERS.at(-1);
const statusOf = p => p.user?.status || 'unset';

function statusCounts() {
  const m = new Map();
  for (const f of data?.features ?? []) {
    const key = f.properties._status;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function buildStatusPanel() {
  const n = statusCounts();
  const present = STATUS_TIERS.filter(s => n.get(s.id));

  if (!activeStatus.size) for (const s of present) activeStatus.add(s.id);

  const rows = $('status-rows');
  rows.innerHTML = '';
  for (const s of present) {
    const c = n.get(s.id);
    const on = activeStatus.has(s.id);
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.style.setProperty('--rc', s.color);
    row.innerHTML = `
      <span class="cat-badge dot-badge"></span>
      <span class="cat-info"><b>${esc(s.label)}</b><small>${c} place${c === 1 ? '' : 's'}</small></span>
      <button class="cat-only" type="button">Only</button>
      <label class="switch">
        <input type="checkbox" ${on ? 'checked' : ''} aria-label="Show ${esc(s.label)}">
        <span class="slider"></span>
      </label>`;
    row.querySelector('.cat-only').addEventListener('click', () => onlyStatus(s.id));
    row.querySelector('input').addEventListener('change', e => {
      e.target.checked ? activeStatus.add(s.id) : activeStatus.delete(s.id);
      applyFilter();
      updateStatusTrigger();
    });
    rows.appendChild(row);
  }
  updateStatusTrigger();
}

function onlyStatus(id) {
  activeStatus = new Set([id]);
  buildStatusPanel();
  applyFilter();
}

function showAllStatus() {
  activeStatus = new Set(statusCounts().keys());
  buildStatusPanel();
  applyFilter();
}

function updateStatusTrigger() {
  const total = statusCounts().size;
  const on = activeStatus.size;
  const el = $('status-trigger-label');
  el.innerHTML = on === total
    ? `Priority <span class="n">${total}</span>`
    : `Priority <span class="n filtered">${on}/${total}</span>`;
}

function toggleStatusPanel(open) {
  const panel = $('status-panel');
  const willOpen = open ?? panel.hidden;
  panel.hidden = !willOpen;
  $('status-trigger').setAttribute('aria-expanded', String(willOpen));
}

function applyFilter() {
  // A place matches on category if EITHER of its (up to 2) scalar bucket
  // slots is active. Deliberately not built against the array-valued
  // _buckets property — GeoJSON sources JSON-stringify array properties
  // internally, and expressions read that same internal representation, so
  // ['get','_buckets'] is not reliably an array here either. _bucket1/2 are
  // plain strings, immune to that. An empty active set must still produce a
  // valid boolean expression that matches nothing, hence `false`.
  const activeArr = [...active];
  const catExpr = active.size
    ? ['any',
        ['in', ['get', '_bucket1'], ['literal', activeArr]],
        ['in', ['get', '_bucket2'], ['literal', activeArr]]]
    : false;

  const f = ['all',
    catExpr,
    ['in', ['get', '_country'], ['literal', [...activeCountries]]],
    ['in', ['get', '_status'], ['literal', [...activeStatus]]]
  ];
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
  toggleCountryPanel(false);
  toggleStatusPanel(false);
  const p = feature.properties ?? {};
  const [lng, lat] = feature.geometry.coordinates;
  // feature comes from a map click event — read the scalar _bucket1/2, not
  // the array-valued _buckets, which MapLibre hands back JSON-stringified
  // here (confirmed crash: (p._buckets ?? []).map is not a function).
  const bs = [p._bucket1 || 'other', p._bucket2].filter(Boolean).map(bucketById);

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
      <span class="emoji">${bs.map(b => b.emoji).join(' ')}</span><span>${bs.map(b => esc(b.label)).join(' + ')}</span>
      ${locality ? `<span>·</span><span>${esc(locality)}</span>` : ''}
    </div>
    ${statusHtml(p)}
    ${p.rating ? `<div class="rating"><span class="stars">${stars(p.rating)}</span>
      <span>${esc(p.rating)}${p.reviewCount ? ` · ${esc(p.reviewCount)} reviews` : ''}</span></div>` : ''}
    ${cleanAddress(p) ? `<p class="addr">${esc(cleanAddress(p))}</p>` : ''}
    ${p.user?.note ? `<div class="notebox user"><span class="lbl">My note</span>${esc(p.user.note)}</div>` : ''}
    ${p.note ? `<div class="notebox"><span class="lbl">Note</span>${esc(p.note)}</div>` : ''}
    ${tagsHtml(p)}
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

  for (const el of $('sheet-body').querySelectorAll('.tag-chip')) {
    el.addEventListener('click', () => {
      $('sheet').hidden = true;
      $('search').value = el.dataset.tag;
      search(el.dataset.tag);
    });
  }

  $('sheet').hidden = false;
  map.easeTo({ center: [lng, lat], offset: [0, -110], duration: 420 });
}

function statusHtml(p) {
  const st = p.user?.status;
  if (!st) return '';
  const tier = statusTier(st);
  if (st === 'visited') {
    const r = Number(p.user?.rating) || 0;
    return `<div class="status-pill" style="--sc:${tier.color}"><span class="dot"></span>Visited${
      r ? `<span class="mystars">${stars(r)}</span>` : ''}</div>`;
  }
  return `<div class="status-pill" style="--sc:${tier.color}"><span class="dot"></span>${esc(tier.label)} priority</div>`;
}

/** Tags are free-form and open-ended, so no toggle panel — tap one to search by it. */
function tagsHtml(p) {
  const tags = p.user?.tags ?? [];
  if (!tags.length) return '';
  return `<div class="tags-row">${tags.map(t =>
    `<button class="tag-chip" type="button" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('')}</div>`;
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

/**
 * Live, local, fires on every keystroke — searches only your own saved
 * places. Free, instant, no network call. Deliberately separate from the
 * Nominatim location lookup below, which fires only on Enter: Nominatim's
 * own usage policy explicitly prohibits autocomplete-style per-keystroke
 * queries against the public API, calling it out as bulk geocoding.
 */
function search(q) {
  const box = $('results');
  const placesBox = $('results-places');
  const term = q.trim().toLowerCase();
  $('search-clear').hidden = !term;

  // A location result from a previous, now-stale query should not linger
  // once the user starts typing something new.
  $('results-locations').innerHTML = '';

  if (!term) { box.hidden = true; placesBox.innerHTML = ''; return; }

  const hits = (data?.features ?? []).filter(f => {
    const p = f.properties;
    return [p.name, p.address, p.city, p.district, categoryLabel(p.category), p.note, p.user?.note,
             ...(p.user?.tags ?? [])]
      .some(v => String(v ?? '').toLowerCase().includes(term));
  }).slice(0, 40);

  box.hidden = false;
  if (!hits.length) {
    placesBox.innerHTML = '<p class="empty">No saved places match that. Press Enter to search it as a location.</p>';
    return;
  }

  placesBox.innerHTML = '';
  for (const f of hits) {
    const p = f.properties;
    const b = bucketById(p._bucket1 || 'other');   // primary category — a compact row shows one
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
    placesBox.appendChild(btn);
  }
}

// ---------------------------------------------------------- location search

let searchMarker = null;
let geocoding = false;

/**
 * Nominatim (OSM's free geocoding). Fires only on an explicit Enter press —
 * never per-keystroke, per their published usage policy, which classes that
 * pattern as unauthorised bulk geocoding regardless of volume. A browser
 * fetch() automatically sends a Referer header identifying this app, which
 * is what their policy asks for in lieu of a custom header browsers won't
 * let a page set anyway.
 */
async function geocodeAndShow(query) {
  const term = query.trim();
  if (!term || geocoding) return;
  geocoding = true;

  const box = $('results-locations');
  box.innerHTML = '<p class="empty">Searching…</p>';
  $('results').hidden = false;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(term)}&limit=5`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    const hits = await res.json();
    renderLocationResults(hits);
  } catch (e) {
    box.innerHTML = `<p class="empty">Location search failed: ${esc(e.message)}</p>`;
  } finally {
    geocoding = false;
  }
}

function renderLocationResults(hits) {
  const box = $('results-locations');
  if (!hits.length) { box.innerHTML = '<p class="empty">No location found for that.</p>'; return; }

  box.innerHTML = '<div class="results-label">Locations</div>';
  for (const hit of hits) {
    const btn = document.createElement('button');
    btn.className = 'result';
    btn.innerHTML = `<span class="emoji">📍</span>
      <span><b>${esc(hit.display_name.split(',')[0])}</b><span>${esc(hit.display_name)}</span></span>`;
    btn.addEventListener('click', () => {
      $('results').hidden = true;
      $('search').value = '';
      $('search-clear').hidden = true;
      dropSearchPin(+hit.lat, +hit.lon, hit.display_name);
    });
    box.appendChild(btn);
  }
}

/**
 * A distinct teardrop marker for "a place I looked up," never confusable
 * with a category pin (white disc + colour ring) or the GPS dot (solid
 * pulsing blue circle). Only one at a time — a fresh search replaces it.
 */
function dropSearchPin(lat, lng, label) {
  searchMarker?.remove();

  const el = document.createElement('div');
  el.className = 'search-pin';
  el.innerHTML = `<svg viewBox="0 0 24 34" width="30" height="42">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"
          fill="#d6249f" stroke="#fff" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="4.5" fill="#fff"/>
  </svg>`;

  searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([lng, lat])
    .setPopup(new maplibregl.Popup({ offset: 28, closeButton: true }).setText(label))
    .addTo(map);
  searchMarker.togglePopup();

  map.flyTo({ center: [lng, lat], zoom: 13, offset: [0, -60] });
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
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') geocodeAndShow(e.target.value);
  });
  $('search-clear').addEventListener('click', () => { $('search').value = ''; search(''); $('search').focus(); });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) $('results').hidden = true;
    // Per-container checks, not a shared class — a click on the country
    // trigger is "outside" #cat-filter (closing it) but "inside" #country-filter
    // (leaving it alone, since that click is what opens it). Net effect:
    // opening one panel closes the other for free.
    if (!e.target.closest('#cat-filter')) toggleCatPanel(false);
    if (!e.target.closest('#country-filter')) toggleCountryPanel(false);
    if (!e.target.closest('#status-filter')) toggleStatusPanel(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $('sheet').hidden = true; $('settings').hidden = true; $('results').hidden = true;
    toggleCatPanel(false);
    toggleCountryPanel(false);
    toggleStatusPanel(false);
  });

  $('btn-locate').addEventListener('click', toggleLocate);
  $('btn-satellite').addEventListener('click', toggleSatellite);
  $('cat-trigger').addEventListener('click', () => toggleCatPanel());
  $('cat-showall').addEventListener('click', showAllCategories);
  $('country-trigger').addEventListener('click', () => toggleCountryPanel());
  $('country-showall').addEventListener('click', showAllCountries);
  $('status-trigger').addEventListener('click', () => toggleStatusPanel());
  $('status-showall').addEventListener('click', showAllStatus);
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
      try {
        const reg = await navigator.serviceWorker.register('sw.js');

        // The browser only checks sw.js for changes lazily — often not on
        // every open of an installed PWA — so force the check explicitly
        // each time the app launches, rather than wait for it to happen on
        // its own schedule.
        reg.update().catch(() => {});

        // Even once a new worker installs, the page that is ALREADY open
        // keeps running the code it already loaded — installing alone does
        // not make this page's JS/CSS current. Only a reload does. Without
        // this listener the fix would need a manual cache-clear every time,
        // which is what happened with the last two pushes.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          location.reload();
        });
      } catch {
        // Registration failing should never block the app from working.
      }
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
